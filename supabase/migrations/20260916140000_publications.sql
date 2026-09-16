-- Marketing OS — MVP-2.2: Distribution — Publications Foundation
--
-- Establishes the Publications domain per Database Architecture §8 and
-- Engineering Blueprint §9/§16/§17: a `publications` row is a distribution
-- instance of one content_variant to one social_account. This migration is
-- additive — it does not modify the Foundation, Storage Foundation, Brand,
-- Content, Storage RBAC, or Social Accounts migrations, and does not touch
-- scheduling automation, provider adapters, or the Calendar (all deferred).
--
-- IMPORTANT — two different "approved" concepts:
-- `content_approvals.status = 'approved'` means a specific content_version
-- has been reviewed and signed off. `publications.status = 'approved'`
-- (below) is a DIFFERENT, unrelated status on the publication's own
-- distribution lifecycle (draft → approved → scheduled → publishing →
-- published, per Engineering Blueprint §17). A publication can only be
-- named 'approved' or later once the underlying content version has an
-- approved content_approvals decision (enforced by the trigger below for
-- scheduled/publishing/published) — but the two enums are independent
-- value sets that happen to share a label. Do not conflate them.

-- =============================================================================
-- Enum
-- =============================================================================

create type public.publication_status as enum (
  'draft',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled'
);

-- =============================================================================
-- Table
-- =============================================================================

create table public.publications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content_variant_id uuid not null references public.content_variants (id) on delete restrict,
  social_account_id uuid not null references public.social_accounts (id) on delete restrict,
  status public.publication_status not null default 'draft',
  scheduled_at timestamptz null,
  published_at timestamptz null,
  external_publication_id text null,
  external_url text null,
  provider_response jsonb not null default '{}'::jsonb,
  error_code text null,
  error_message text null,
  -- Required, application-generated (crypto.randomUUID()) — never a
  -- deterministic hash (approved MVP-2.2 decision, Q1). Uniqueness is
  -- enforced per (workspace_id, social_account_id) below.
  idempotency_key text not null,
  created_by uuid null references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite-FK target (Database Architecture §16).
  constraint publications_id_workspace_id_key unique (id, workspace_id),

  -- Database Architecture §8: "idempotency_key is unique per
  -- (workspace_id, social_account_id)."
  constraint publications_idempotency_key_key unique (workspace_id, social_account_id, idempotency_key),

  -- Tenant-consistency composite FKs (Database Architecture §16).
  constraint publications_variant_workspace_fkey
    foreign key (content_variant_id, workspace_id) references public.content_variants (id, workspace_id),
  constraint publications_account_workspace_fkey
    foreign key (social_account_id, workspace_id) references public.social_accounts (id, workspace_id)
);

comment on table public.publications is
  'Historical distribution records. Never hard-deleted (Database Architecture §19) — cancellation and failure are represented by status.';
comment on column public.publications.status is
  'publication_status is independent of content_approvals.status — both happen to include an "approved" value but represent different concepts. See migration header comment.';

create index publications_workspace_id_idx on public.publications (workspace_id);
create index publications_workspace_scheduled_at_idx on public.publications (workspace_id, scheduled_at);
create index publications_workspace_status_idx on public.publications (workspace_id, status);
create index publications_content_variant_id_idx on public.publications (content_variant_id);
create index publications_social_account_id_idx on public.publications (social_account_id);

create trigger set_publications_updated_at
  before update on public.publications
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- Approval gate — enforce_publication_approval_gate()
--
-- Database Architecture §17, "Content Approval → Publication Gate": a
-- publications row must not transition into scheduled, publishing, or
-- published unless an approved content_approvals row exists for the
-- content_version_id behind the publication's content_variant. Required
-- at BOTH layers (server-side and database trigger) — this is the
-- database layer, authoritative even against direct/elevated DB access
-- (e.g. a service-role connection bypassing RLS and the application).
--
-- MVP-2.2 explicit decision (canonical docs do not specify this): "latest
-- approval wins." content_approvals is append-only, so a later decision
-- (e.g. changes_requested) after an earlier approval must invalidate that
-- earlier approval for gating purposes. This function orders by
-- created_at desc and inspects only the single most recent row for the
-- resolved content_version_id — it does NOT use a bare EXISTS(status =
-- 'approved') check, which would incorrectly let a stale approval remain
-- valid after a later rejection.
--
-- Never reads content.status or content_variants.status — only
-- content_approvals, per the canonical gate definition.
-- =============================================================================

create function public.enforce_publication_approval_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_content_version_id uuid;
  v_latest_status public.content_approval_status;
begin
  -- Only scheduled/publishing/published are gated (Database Architecture §17).
  if new.status not in ('scheduled', 'publishing', 'published') then
    return new;
  end if;

  select cv.content_version_id
  into v_content_version_id
  from public.content_variants cv
  where cv.id = new.content_variant_id;

  if v_content_version_id is null then
    raise exception 'Cannot transition publication %: content variant % has no resolvable content version',
      new.id, new.content_variant_id;
  end if;

  -- Latest decision wins (MVP-2.2 explicit decision, see header comment):
  -- order by created_at desc and take only the single most recent row.
  select ca.status
  into v_latest_status
  from public.content_approvals ca
  where ca.content_version_id = v_content_version_id
  order by ca.created_at desc
  limit 1;

  if v_latest_status is distinct from 'approved' then
    raise exception 'Cannot transition publication % to %: content version % does not have an approved latest content_approvals decision',
      new.id, new.status, v_content_version_id;
  end if;

  return new;
end;
$$;

create trigger enforce_publication_approval_gate
  before insert or update on public.publications
  for each row
  execute function public.enforce_publication_approval_gate();

-- =============================================================================
-- Cancellation gate — enforce_publication_cancellation_gate()
--
-- MVP-2.2 stabilization: cancellation source-state must be
-- database-enforced, not application-only (the service-layer check in
-- schedulePublication/cancelPublication remains as defense in depth, per
-- the same "both layers required" principle used for the approval gate,
-- Database Architecture §17). A transition into 'cancelled' is allowed
-- only from 'draft', 'approved', or 'scheduled'. A publication can never
-- be INSERTed directly at 'cancelled' — every publication must begin at
-- 'draft' (OLD does not exist on INSERT, so that case is rejected
-- unconditionally rather than inspecting OLD.status).
-- =============================================================================

create function public.enforce_publication_cancellation_gate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from 'cancelled' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'Cannot insert publication % directly with status=cancelled; every publication must begin at draft',
      new.id;
  end if;

  if old.status not in ('draft', 'approved', 'scheduled') then
    raise exception 'Cannot cancel publication %: cannot transition from % to cancelled', new.id, old.status;
  end if;

  return new;
end;
$$;

create trigger enforce_publication_cancellation_gate
  before insert or update on public.publications
  for each row
  execute function public.enforce_publication_cancellation_gate();

-- =============================================================================
-- RLS
--
-- SELECT: any workspace member (viewer included) may read publications.
-- INSERT/UPDATE: workspace editors only (owner/admin/marketer) — matches
-- the established Brand/Content/Assets/Social-Accounts pattern.
-- No DELETE policy: publications are historical records and are never
-- hard-deleted under any circumstance (Database Architecture §19).
-- =============================================================================

alter table public.publications enable row level security;

create policy "publications_select_workspace_members"
on public.publications
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "publications_insert_workspace_editors"
on public.publications
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "publications_update_workspace_editors"
on public.publications
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

grant select, insert, update on public.publications to authenticated;
grant select, insert, update, delete on public.publications to service_role;
