-- Marketing OS — MVP-5.35B: Publishing Domain + Idempotency Foundation
--
-- Additive only. Three parts, all prerequisites for a real provider
-- publish() (MVP-5.35A architecture, Panji decisions Q1–Q6):
--
--   1. marqos_content_variant_assets — explicit, ordered variant → asset
--      selection (Q1). The publication target is a content variant, so the
--      exact media it publishes is bound at variant level. The existing
--      content-level library (marqos_content_assets) is unchanged and is not
--      migrated. `marqos_` prefix: same collision rationale as the other
--      asset tables (Database Architecture §6).
--   2. publication_attempts — per-attempt provider checkpoint/audit record.
--      Provider progress (containers, remote media id) lives here, never in
--      publications: enforce_publication_lifecycle_transitions rejects any
--      UPDATE of a row that stays 'publishing', and this migration does not
--      change that (MVP-5.35A §3/§7).
--   3. enforce_publication_scheduling_transitions — DB parity for the
--      scheduling guard in schedulePublication (MVP-5.35A hazard H2): a
--      publication may never re-enter 'scheduled' from published,
--      publishing or cancelled, nor from a failed attempt whose remote
--      outcome is unknown.
--
-- Out of scope: any provider API call, execution-service changes (H1),
-- media conversion, carousel/reel, variant.format enforcement (format stays
-- free text; canonical publishing formats are validated at the publishing
-- boundary — see the MVP-5.35B format audit).

-- =============================================================================
-- 1. marqos_content_variant_assets
-- =============================================================================

create table public.marqos_content_variant_assets (
  content_variant_id uuid not null references public.content_variants (id) on delete cascade,
  asset_id uuid not null references public.marqos_assets (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Explicit publish order (carousel slide order later; single image = 0).
  sort_order integer not null check (sort_order >= 0),
  created_by uuid null references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (content_variant_id, asset_id),
  -- Deterministic ordering: one asset per position per variant.
  constraint marqos_content_variant_assets_order_key unique (content_variant_id, sort_order),
  -- Tenant-consistency composite FKs (Database Architecture §16).
  foreign key (content_variant_id, workspace_id) references public.content_variants (id, workspace_id),
  foreign key (asset_id, workspace_id) references public.marqos_assets (id, workspace_id)
);

comment on table public.marqos_content_variant_assets is
  'Ordered variant → asset selection: the exact media a publication of this variant publishes (MVP-5.35B, Q1). Junction, not a historical record — what was actually published is snapshotted in publication_attempts.media_asset_ids. marqos_content_assets remains the content-level library.';

create index marqos_content_variant_assets_workspace_id_idx on public.marqos_content_variant_assets (workspace_id);
create index marqos_content_variant_assets_asset_id_idx on public.marqos_content_variant_assets (asset_id);

alter table public.marqos_content_variant_assets enable row level security;

create policy "marqos_content_variant_assets_select_members"
on public.marqos_content_variant_assets
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "marqos_content_variant_assets_insert_editors"
on public.marqos_content_variant_assets
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "marqos_content_variant_assets_update_editors"
on public.marqos_content_variant_assets
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

create policy "marqos_content_variant_assets_delete_editors"
on public.marqos_content_variant_assets
for delete
to authenticated
using (public.is_workspace_editor(workspace_id));

grant select, insert, update, delete on public.marqos_content_variant_assets to authenticated;
grant select, insert, update, delete on public.marqos_content_variant_assets to service_role;

-- =============================================================================
-- 2. publication_attempts
-- =============================================================================

create type public.publication_attempt_stage as enum (
  'validating',
  'container_created',
  'container_ready',
  'publish_requested',
  'published',
  'failed',
  'outcome_unknown'
);

create table public.publication_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  publication_id uuid not null,
  -- Assigned by assign_publication_attempt_number(): 1, 2, 3… per publication.
  attempt_number integer not null check (attempt_number > 0),
  provider text not null,
  stage public.publication_attempt_stage not null default 'validating',
  -- Provider container ids (parent + children). Never tokens or URLs.
  container_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(container_ids) = 'array'),
  -- The marqos_assets actually submitted by this attempt (audit snapshot of
  -- the variant's selection at execution time).
  media_asset_ids uuid[] not null default '{}',
  external_media_id text null,
  error_code text null,
  error_message text null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint publication_attempts_id_workspace_id_key unique (id, workspace_id),
  constraint publication_attempts_number_key unique (publication_id, attempt_number),
  constraint publication_attempts_publication_workspace_fkey
    foreign key (publication_id, workspace_id) references public.publications (id, workspace_id),
  -- A terminal stage is exactly one with completed_at set (set by trigger).
  constraint publication_attempts_completed_at_matches_stage check (
    (stage in ('published', 'failed', 'outcome_unknown')) = (completed_at is not null)
  ),
  constraint publication_attempts_published_has_media_id check (
    stage <> 'published' or external_media_id is not null
  )
);

comment on table public.publication_attempts is
  'Provider checkpoint/audit per publish attempt (MVP-5.35B). Provider container lifecycle lives here; the MARQOS lifecycle lives in publications.status. Append/audit oriented: no DELETE for any API role; terminal attempts are immutable; members read, only the execution path (service_role) writes.';

-- At most one non-terminal attempt per publication.
create unique index publication_attempts_one_open_per_publication
  on public.publication_attempts (publication_id)
  where stage in ('validating', 'container_created', 'container_ready', 'publish_requested');

create index publication_attempts_workspace_id_idx on public.publication_attempts (workspace_id);

create trigger set_publication_attempts_updated_at
  before update on public.publication_attempts
  for each row
  execute function public.set_updated_at();

-- Deterministic numbering + start precondition. The advisory lock
-- serializes concurrent inserts for the same publication so numbering
-- never races; the unique constraints remain the final authority.
create function public.assign_publication_attempt_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.publication_status;
begin
  perform pg_advisory_xact_lock(hashtextextended('publication_attempts:' || new.publication_id::text, 0));

  select p.status into v_status
  from public.publications p
  where p.id = new.publication_id and p.workspace_id = new.workspace_id;

  if v_status is distinct from 'publishing' then
    raise exception 'Cannot start an attempt for publication %: status is %, expected publishing',
      new.publication_id, coalesce(v_status::text, 'missing');
  end if;

  select coalesce(max(pa.attempt_number), 0) + 1
  into new.attempt_number
  from public.publication_attempts pa
  where pa.publication_id = new.publication_id;

  if new.stage in ('published', 'failed', 'outcome_unknown') then
    new.completed_at := coalesce(new.completed_at, now());
  else
    new.completed_at := null;
  end if;

  return new;
end;
$$;

create trigger assign_publication_attempt_number
  before insert on public.publication_attempts
  for each row
  execute function public.assign_publication_attempt_number();

-- Identity is immutable; terminal attempts are immutable; completed_at is
-- derived from the stage.
create function public.enforce_publication_attempt_immutability()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.stage in ('published', 'failed', 'outcome_unknown') then
    raise exception 'Publication attempt % is terminal (%) and cannot be modified', old.id, old.stage;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.publication_id is distinct from old.publication_id
     or new.attempt_number is distinct from old.attempt_number
     or new.provider is distinct from old.provider
     or new.started_at is distinct from old.started_at then
    raise exception 'Publication attempt % identity fields are immutable', old.id;
  end if;

  if new.stage in ('published', 'failed', 'outcome_unknown') then
    new.completed_at := coalesce(new.completed_at, now());
  else
    new.completed_at := null;
  end if;

  return new;
end;
$$;

create trigger enforce_publication_attempt_immutability
  before update on public.publication_attempts
  for each row
  execute function public.enforce_publication_attempt_immutability();

alter table public.publication_attempts enable row level security;

create policy "publication_attempts_select_members"
on public.publication_attempts
for select
to authenticated
using (public.is_workspace_member(workspace_id));

-- `authenticated`: read only (no insert/update/delete policy or grant).
-- `service_role`: insert/update only — deliberately no DELETE (append/audit
-- record). Workspace deletion still cascades: referential actions run with
-- the table owner's privileges, not the caller's.
grant select on public.publication_attempts to authenticated;
grant select, insert, update on public.publication_attempts to service_role;

-- =============================================================================
-- 3. Scheduling transition guard (H2)
-- =============================================================================

create function public.enforce_publication_scheduling_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'UPDATE' or new.status is distinct from 'scheduled' then
    return new;
  end if;

  -- Never while a provider attempt is still open (its remote outcome is
  -- not yet settled).
  if exists (
    select 1 from public.publication_attempts pa
    where pa.publication_id = new.id
      and pa.stage in ('validating', 'container_created', 'container_ready', 'publish_requested')
  ) then
    raise exception 'Cannot reschedule publication %: a publish attempt is still open', new.id;
  end if;

  -- Reschedule of a still-scheduled row, or first scheduling.
  if old.status in ('draft', 'approved', 'scheduled') then
    return new;
  end if;

  -- Retry after a failure whose remote outcome is certain (not published).
  if old.status = 'failed' then
    if old.error_code is not distinct from 'publish_outcome_unknown' then
      raise exception 'Cannot reschedule publication %: the previous publish outcome is unknown and must be reconciled first', new.id;
    end if;
    return new;
  end if;

  raise exception 'Cannot transition publication % to scheduled from %', new.id, old.status;
end;
$$;

create trigger enforce_publication_scheduling_transitions
  before update on public.publications
  for each row
  execute function public.enforce_publication_scheduling_transitions();
