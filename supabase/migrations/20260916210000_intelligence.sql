-- Marketing OS — MVP-4.1: Intelligence Foundation
--
-- Establishes the Intelligence domain per Database Architecture §4,
-- Engineering Blueprint §19/§23 (`006_intelligence.sql`), ERD §4, DECISIONS
-- #11, and PRD §9 ("Sources, signals, topics, opportunities... Topic
-- grouping uses AI/provider classification plus relational grouping; no
-- vector/embedding infrastructure is required for MVP"). Additive
-- migration — does not modify Foundation, Storage Foundation, Brand,
-- Storage RBAC, Social Accounts, Publications, Publication Execution,
-- Publication Scheduler Claim, Notifications, or Analytics, and does not
-- touch Calendar (no schema of its own).
--
-- Scope for this migration (MVP-4.1, approved): schema + RLS only, for
-- marqos_signal_sources, marqos_signals, topics, signal_topics,
-- opportunities, plus the one explicitly pre-documented cross-domain
-- completion named in 20260915154503_content.sql's own header ("DEFERRED
-- DEPENDENCIES", item 2): content_briefs.opportunity_id.
--
-- marqos_signal_sources/marqos_signals are intentionally prefixed, not
-- named signal_sources/signals: this Supabase project already contains a
-- differently-shaped signal_sources/signals table pair belonging to a
-- separate, pre-existing application sharing the project (MVP-5.24
-- forensic audit; MVP-5.25 remediation, Strategy C — narrow coexistence).
-- topics/signal_topics/opportunities do not collide with anything in that
-- application and keep their original names.
--
-- HARD BOUNDARY (approved MVP-4.1 decision, not an oversight): no AI
-- classifier, mock classifier, "suggest topic" stub, ai_jobs, or
-- prompt_versions is introduced here. signal_topics rows are created only
-- through explicit/manual relational service operations
-- (src/server/services/intelligence.ts) — the AI-driven half of Blueprint
-- §19's "topic grouping uses AI/provider text classification... combined
-- with relational grouping" is deferred to a later, separately audited
-- slice, once the AI domain (ai_jobs, position 007 in Blueprint §23's
-- sequence) exists. Building an AI classification mechanism now — even a
-- mock one — would either invent unspecified classification behavior or
-- require standing up AI infrastructure out of sequence; neither is
-- approved for this slice.
--
-- opportunities.score is created exactly as Database Architecture §4
-- specifies (a plain numeric column) and is never written, calculated,
-- ranked, normalized, or thresholded by anything in this migration or in
-- intelligence.ts — no scoring formula exists anywhere in canonical text,
-- and none is invented here.
--
-- Composite tenant-consistency FKs (Database Architecture §16) are
-- implemented EXACTLY per §16's own explicit list, not by analogy: only
-- `signal_topics (signal_id, workspace_id) → marqos_signals (id, workspace_id)`,
-- `signal_topics (topic_id, workspace_id) → topics (id, workspace_id)`,
-- and the new `opportunities (brand_id, workspace_id) → brands (id,
-- workspace_id)` (nullable) are composite-FK-checked. `marqos_signals.source_id`
-- (→ marqos_signal_sources) and `opportunities.topic_id` (→ topics) are
-- deliberately PLAIN foreign keys only — §16's list does not name either
-- relationship, exactly mirroring how 20260915154503_content.sql already
-- left content_briefs.audience_profile_id/content_pillar_id as plain FKs
-- because §16's list covers content_briefs.brand_id but not those two
-- columns. Consequently `marqos_signal_sources` carries no `UNIQUE (id,
-- workspace_id)` either — Database Architecture §4's own text specifies
-- that constraint for signals/topics/opportunities, but not for
-- signal_sources, consistent with marqos_signal_sources never being a
-- composite-FK target.
--
-- DELETE policy (approved MVP-4.1 decision): none of signal_sources,
-- signals, topics, signal_topics, or opportunities appears in Database
-- Architecture §19's "soft/archive preferred" list or its "never
-- hard-deleted" list — this migration does not invent a delete/archive
-- behavior beyond each table's own existing canonical status field
-- (signal_source_status, topic_status, opportunity_status). No DELETE
-- policy or grant is defined for `authenticated` on any of these five
-- tables.

-- =============================================================================
-- Enums
-- =============================================================================

create type public.signal_source_status as enum ('active', 'paused', 'disabled', 'error');
create type public.topic_status as enum ('active', 'archived');
create type public.opportunity_status as enum ('open', 'in_progress', 'actioned', 'expired', 'dismissed');

-- =============================================================================
-- Tables
-- =============================================================================

create table public.marqos_signal_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null,
  source_type text not null,
  name text not null,
  status public.signal_source_status not null default 'active',
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.marqos_signal_sources is
  'Configured external signal collection sources. No composite-FK target (not referenced by any composite tenant-consistency FK per Database Architecture §16), so no UNIQUE(id, workspace_id) is required.';
comment on column public.marqos_signal_sources.configuration is
  'Non-secret source configuration only. Credentials/secrets must never be stored here (Database Architecture §4) — the same principle as social_accounts.vault_secret_id (§8), though no Vault integration exists for this domain in MVP-4.1 (real source integration is deferred).';

create table public.marqos_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source_id uuid not null references public.marqos_signal_sources (id) on delete cascade,
  external_id text null,
  source_url text null,
  title text null,
  content_text text null,
  author_name text null,
  published_at timestamptz null,
  captured_at timestamptz not null default now(),
  engagement_data jsonb not null default '{}'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite-FK target (Database Architecture §4: "supports composite FKs (§16)").
  constraint marqos_signals_id_workspace_id_key unique (id, workspace_id)

  -- source_id is intentionally a PLAIN foreign key only — §16's explicit
  -- composite-FK list does not name marqos_signals.source_id → marqos_signal_sources.
);

comment on table public.marqos_signals is
  'Observed external information (Database Architecture §4, DECISIONS #11: "Signal = observed information"). source_id is a plain FK only — not composite-FK-checked, per this migration''s header comment.';

create index marqos_signals_workspace_id_idx on public.marqos_signals (workspace_id);
create index marqos_signals_source_id_idx on public.marqos_signals (source_id);
-- Recommended, not mandated, by Database Architecture §4 ("Recommended
-- uniqueness: (source_id, external_id) where provider permits"). external_id
-- is nullable, and a plain UNIQUE constraint would reject multiple NULLs
-- inconsistently across providers that never supply one — a partial unique
-- index applies the recommendation only when external_id is actually present.
create unique index marqos_signals_source_id_external_id_key
  on public.marqos_signals (source_id, external_id)
  where external_id is not null;

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text null,
  status public.topic_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite-FK target (Database Architecture §4).
  constraint topics_id_workspace_id_key unique (id, workspace_id)
);

comment on table public.topics is 'Grouped subject (DECISIONS #11: "Topic = grouped subject").';

create index topics_workspace_id_idx on public.topics (workspace_id);

-- signal_topics: junction table, no surrogate id (Database Architecture §4
-- lists no `id` field for this table), mirroring marqos_content_assets'
-- shape (20260915154503_content.sql) exactly.
create table public.signal_topics (
  signal_id uuid not null references public.marqos_signals (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  relevance_score numeric null,
  created_at timestamptz not null default now(),
  primary key (signal_id, topic_id),

  -- Composite tenant-consistency FKs (Database Architecture §16, explicitly named).
  constraint signal_topics_signal_workspace_fkey
    foreign key (signal_id, workspace_id) references public.marqos_signals (id, workspace_id),
  constraint signal_topics_topic_workspace_fkey
    foreign key (topic_id, workspace_id) references public.topics (id, workspace_id)
);

comment on table public.signal_topics is
  'Relational signal->topic grouping (Engineering Blueprint §19). MVP-4.1: rows are created only through explicit/manual service operations — no AI classification exists in this slice (see migration header, HARD BOUNDARY).';

create index signal_topics_workspace_id_idx on public.signal_topics (workspace_id);

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  brand_id uuid null references public.brands (id) on delete set null,
  title text not null,
  description text null,
  rationale text null,
  -- Canonical column only (Database Architecture §4). Never written,
  -- calculated, ranked, normalized, or thresholded by this migration or by
  -- intelligence.ts — no scoring formula exists anywhere in canonical
  -- text. Nullable: left unset unless a caller explicitly supplies a
  -- value, which nothing in this slice does.
  score numeric null,
  status public.opportunity_status not null default 'open',
  detected_at timestamptz not null default now(),
  expires_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite-FK target (Database Architecture §4).
  constraint opportunities_id_workspace_id_key unique (id, workspace_id),

  -- Composite tenant-consistency FK for brand_id only (Database
  -- Architecture §16 explicitly lists opportunities in the "every optional
  -- brand_id... → brands" bullet). topic_id is intentionally a PLAIN
  -- foreign key only — §16's list does not name opportunities.topic_id →
  -- topics.
  constraint opportunities_brand_workspace_fkey
    foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.opportunities is
  'Strategic marketing opportunity (DECISIONS #11). topic_id is a plain FK only; brand_id is composite-FK-checked (nullable) — see this migration''s header comment.';
comment on column public.opportunities.score is
  'Canonical column only — never populated by this migration or by intelligence.ts. No scoring formula exists in any canonical document (MVP-4.1 approved decision).';

create index opportunities_workspace_id_idx on public.opportunities (workspace_id);
create index opportunities_topic_id_idx on public.opportunities (topic_id);
create index opportunities_brand_id_idx on public.opportunities (brand_id);

-- =============================================================================
-- Content integration — completes the pre-documented MVP-1.2 deferral
--
-- 20260915154503_content.sql's own header ("DEFERRED DEPENDENCIES", item
-- 2): "content_briefs.opportunity_id (Database Architecture §5: nullable
-- FK -> opportunities.id). `opportunities` is Intelligence domain (MVP-4).
-- PRD §5 explicitly allows 'a brief may exist without an opportunity', so
-- this deferral blocks nothing functionally; added additively when
-- Intelligence domain lands." Intelligence has now landed. This is a
-- backward-compatible additive change: the column is nullable, so every
-- existing content_briefs row (opportunity_id defaulting to NULL) remains
-- valid with no data migration required.
-- =============================================================================

alter table public.content_briefs
  add column opportunity_id uuid null references public.opportunities (id) on delete set null;

comment on column public.content_briefs.opportunity_id is
  'Completes the MVP-1.2 deferral documented in 20260915154503_content.sql. Nullable — PRD §5: "a brief may exist without an opportunity."';

create index content_briefs_opportunity_id_idx on public.content_briefs (opportunity_id);

alter table public.content_briefs
  add constraint content_briefs_opportunity_workspace_fkey
  foreign key (opportunity_id, workspace_id) references public.opportunities (id, workspace_id);

-- =============================================================================
-- RLS
--
-- All five tables: SELECT for workspace members, INSERT/UPDATE for
-- workspace editors (owner/admin/marketer) — the standard pattern already
-- used for brands/content/publications, not content_approvals' stricter
-- admin-only separation of duties (no canonical signal indicates
-- Intelligence needs that stricter model). No DELETE policy for
-- `authenticated` on any of the five tables (see migration header,
-- approved MVP-4.1 decision).
-- =============================================================================

alter table public.marqos_signal_sources enable row level security;

create policy "marqos_signal_sources_select_members"
on public.marqos_signal_sources
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "marqos_signal_sources_insert_editors"
on public.marqos_signal_sources
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "marqos_signal_sources_update_editors"
on public.marqos_signal_sources
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

alter table public.marqos_signals enable row level security;

create policy "marqos_signals_select_members"
on public.marqos_signals
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "marqos_signals_insert_editors"
on public.marqos_signals
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "marqos_signals_update_editors"
on public.marqos_signals
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

alter table public.topics enable row level security;

create policy "topics_select_members"
on public.topics
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "topics_insert_editors"
on public.topics
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "topics_update_editors"
on public.topics
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

alter table public.signal_topics enable row level security;

create policy "signal_topics_select_members"
on public.signal_topics
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "signal_topics_insert_editors"
on public.signal_topics
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

-- No UPDATE policy for signal_topics: every column besides created_at is
-- part of the relationship's identity (signal_id, topic_id) or a value
-- (relevance_score) that a caller would simply re-link (delete + insert)
-- rather than update in place; no canonical text requires an UPDATE path,
-- and none is built here to avoid inventing unspecified relink semantics.

alter table public.opportunities enable row level security;

create policy "opportunities_select_members"
on public.opportunities
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "opportunities_insert_editors"
on public.opportunities
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "opportunities_update_editors"
on public.opportunities
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

-- =============================================================================
-- Grants
--
-- auto_expose_new_tables is false (supabase/config.toml); explicit grants
-- are required regardless. `authenticated` receives exactly what its
-- policies allow — select/insert/update, no delete, matching the policy
-- set per table (signal_topics: select/insert only, no update policy
-- exists). `service_role` receives full CRUD, matching every other table's
-- service_role grant in this database.
-- =============================================================================

grant select, insert, update on public.marqos_signal_sources to authenticated;
grant select, insert, update, delete on public.marqos_signal_sources to service_role;

grant select, insert, update on public.marqos_signals to authenticated;
grant select, insert, update, delete on public.marqos_signals to service_role;

grant select, insert, update on public.topics to authenticated;
grant select, insert, update, delete on public.topics to service_role;

grant select, insert on public.signal_topics to authenticated;
grant select, insert, update, delete on public.signal_topics to service_role;

grant select, insert, update on public.opportunities to authenticated;
grant select, insert, update, delete on public.opportunities to service_role;
