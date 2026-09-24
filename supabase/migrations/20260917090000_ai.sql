-- Marketing OS — MVP-5.3: AI Foundation
--
-- Establishes the AI domain (ai_jobs, ai_usage, prompt_versions) per Database
-- Architecture §10, Engineering Blueprint §10/§11/§12, ERD §13, and the
-- approved MVP-5.2 owner decisions recorded in DECISIONS.md #21-#28.
-- Completes the pre-documented MVP-1.2 deferral: content_versions.ai_job_id
-- / marqos_assets.ai_job_id (20260915154503_content.sql's own "DEFERRED
-- DEPENDENCIES", item 1).
--
-- SCOPE (approved MVP-5.3, Content-first AI backfill only — DECISIONS #21):
-- schema + RLS for ai_jobs/ai_usage/prompt_versions, plus the two Content
-- traceability columns. No Intelligence/Optimization/AI-variant/automation
-- schema is introduced here.
--
-- DEFERRED (flagged, not silently resolved): ai_jobs.automation_run_id
-- (Database Architecture §10: nullable FK -> automation_runs.id) is NOT
-- added by this migration. The `automations`/`automation_runs` tables do
-- not exist anywhere in this repository yet — no Automation-domain
-- migration has been created. Per the same deferral pattern already used
-- for content_versions.ai_job_id (this migration) and
-- content_briefs.opportunity_id (20260916210000_intelligence.sql), a
-- nullable FK cannot reference a table that does not exist.
-- THIS DOES NOT WAIVE THE REQUIREMENT: Database Architecture §10 still
-- specifies automation_run_id, and trigger_type = 'automation' cannot be
-- practically populated until a follow-up migration adds:
--   alter table public.ai_jobs add column automation_run_id uuid
--     references public.automation_runs (id);
--   alter table public.ai_jobs add constraint
--     ai_jobs_automation_run_workspace_fkey
--     foreign key (automation_run_id, workspace_id)
--     references public.automation_runs (id, workspace_id);
-- The `ai_job_trigger_type` enum below still includes 'automation' (per
-- Database Architecture §10's exact value set — enums are not left
-- open-ended, Database Architecture §22), but no application code in this
-- phase issues trigger_type = 'automation'; only 'user' and 'system' are
-- practically usable until automation_run_id lands.
--
-- D10 (approved, DECISIONS #26, clarified in the MVP-5.2A/MVP-5.3 owner
-- approval): ai_jobs.prompt_version_id is a PLAIN foreign key only, NOT
-- composite-FK-checked against (id, workspace_id), because
-- prompt_versions.workspace_id is nullable (NULL = global prompt shared
-- across every workspace) — a global prompt has no single workspace to
-- match against ai_jobs.workspace_id. Tenant safety for prompt resolution
-- is provided by ai_jobs.workspace_id itself, the prompt resolution
-- precedence (below), and RLS — not by a composite FK. See Database
-- Architecture §10 and ERD §13 (already amended in MVP-5.2A).
--
-- RLS (DECISIONS #24, approved): workspace members get SELECT only on all
-- three tables. No authenticated INSERT/UPDATE/DELETE policy exists for any
-- of them — every write (job creation, status transition, usage recording,
-- prompt authoring) happens via service_role, mirroring the precedent in
-- 20260916190000_notifications.sql (system-authored rows with no
-- authenticated insert policy).
--
-- Immutability note: unlike content_versions (which has no UPDATE policy
-- at all, for any role — Database Architecture §20), prompt_versions DOES
-- permit UPDATE for service_role. This is a deliberate, narrower exception:
-- the partial unique index below ("at most one active row per
-- (workspace_id, purpose)") requires the previously-active row to be
-- deactivated (is_active -> false) before or as part of activating a new
-- version, which is impossible without any UPDATE path at all. Application
-- discipline (src/server/services/ai.ts), not the database, is what
-- guarantees `template`/`configuration`/`version`/`purpose`/`name` are
-- never updated after creation — only `is_active` is ever flipped, on
-- supersession by a new version. This is a documented deviation from
-- content_versions' stricter model, not an oversight.

-- =============================================================================
-- Enums
-- =============================================================================

create type public.ai_job_trigger_type as enum ('user', 'automation', 'system');
create type public.ai_job_status as enum ('queued', 'running', 'completed', 'failed', 'cancelled');

-- =============================================================================
-- Tables
-- =============================================================================

-- prompt_versions is created before ai_jobs so ai_jobs.prompt_version_id can
-- reference it directly.
create table public.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid null references public.workspaces (id) on delete cascade,
  name text not null,
  purpose text not null,
  version integer not null,
  template text not null,
  configuration jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.prompt_versions is
  'Versioned AI prompts (Engineering Blueprint §12, DECISIONS #26). Immutable except for is_active (see migration header). workspace_id NULL means a global/default prompt shared across every workspace.';

create index prompt_versions_workspace_id_idx on public.prompt_versions (workspace_id);
create index prompt_versions_purpose_idx on public.prompt_versions (purpose);

-- One version number per (workspace_id, purpose) scope, including across
-- global rows. A plain UNIQUE(workspace_id, purpose, version) constraint
-- would NOT enforce this for global prompts, for the same reason documented
-- below for the active-prompt index: Postgres treats every NULL
-- workspace_id as distinct, so two global rows for the same purpose/version
-- would not collide. coalesce() to the same fixed sentinel used below
-- collapses every NULL to one comparable value.
create unique index prompt_versions_scope_purpose_version_key
  on public.prompt_versions (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose, version);

-- "At most one active prompt per (workspace_id, purpose)" (Engineering
-- Blueprint §12). A plain unique index on (workspace_id, purpose) WHERE
-- is_active would NOT enforce this correctly for global prompts: Postgres
-- treats every NULL as distinct from every other NULL in a unique index, so
-- two different global (workspace_id IS NULL) active prompts for the same
-- purpose would NOT collide under a naive index. coalesce() to a fixed
-- sentinel UUID collapses every NULL to the same comparable value so the
-- "at most one active global prompt per purpose" rule is actually enforced.
create unique index prompt_versions_active_scope_purpose_key
  on public.prompt_versions (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose)
  where is_active;

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  requested_by uuid null references public.profiles (id),
  trigger_type public.ai_job_trigger_type not null,
  job_type text not null,
  provider text not null,
  model text not null,
  status public.ai_job_status not null default 'queued',
  input_reference jsonb not null default '{}'::jsonb,
  output_reference jsonb null,
  error_code text null,
  error_message text null,
  prompt_version_id uuid null references public.prompt_versions (id),
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite-FK target (Database Architecture §10: "supports composite
  -- FKs (§16)") for content_versions.ai_job_id / marqos_assets.ai_job_id below,
  -- and for ai_usage.ai_job_id.
  constraint ai_jobs_id_workspace_id_key unique (id, workspace_id),

  -- Database Architecture §10: "trigger_type = 'user' requires
  -- requested_by". The 'automation' companion requirement
  -- (automation_run_id) cannot be enforced here — see migration header;
  -- enforced at the application layer instead until that column exists.
  constraint ai_jobs_user_trigger_requires_requester
    check (trigger_type <> 'user' or requested_by is not null)
);

comment on table public.ai_jobs is
  'Long-running or external AI work (Engineering Blueprint §11, DECISIONS #12). automation_run_id is deferred — see migration header.';
comment on column public.ai_jobs.prompt_version_id is
  'Plain FK only, not composite-FK-checked — see migration header and Database Architecture §10.';

create index ai_jobs_workspace_id_idx on public.ai_jobs (workspace_id);
create index ai_jobs_status_idx on public.ai_jobs (status);
create index ai_jobs_prompt_version_id_idx on public.ai_jobs (prompt_version_id);

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ai_job_id uuid not null references public.ai_jobs (id) on delete cascade,
  provider text not null,
  model text not null,
  input_tokens integer null,
  output_tokens integer null,
  image_count integer null,
  estimated_cost numeric null,
  currency text null,
  created_at timestamptz not null default now(),

  -- ai_jobs.workspace_id is always NOT NULL (unlike prompt_versions), so a
  -- real composite tenant-consistency FK applies here without the
  -- nullable-parent problem documented above for prompt_version_id.
  constraint ai_usage_job_workspace_fkey
    foreign key (ai_job_id, workspace_id) references public.ai_jobs (id, workspace_id)
);

comment on table public.ai_usage is
  'Per-execution token/cost accounting (Database Architecture §10). No pricing/billing logic is implemented — estimated_cost/currency are left NULL when the provider response does not honestly support a value (DECISIONS #21-#28 approval; no formula invented).';

create index ai_usage_workspace_id_idx on public.ai_usage (workspace_id);
create index ai_usage_ai_job_id_idx on public.ai_usage (ai_job_id);

-- =============================================================================
-- Content AI traceability — completes the MVP-1.2 deferral
--
-- 20260915154503_content.sql's own header ("DEFERRED DEPENDENCIES", item 1):
-- content_versions.ai_job_id / marqos_assets.ai_job_id, nullable FK -> ai_jobs.id,
-- composite-FK-checked against ai_jobs (id, workspace_id). Additive,
-- nullable, backward-compatible: every existing row defaults to NULL
-- (human-authored / uploaded), no data migration required.
-- =============================================================================

alter table public.content_versions
  add column ai_job_id uuid null references public.ai_jobs (id);

alter table public.content_versions
  add constraint content_versions_ai_job_workspace_fkey
  foreign key (ai_job_id, workspace_id) references public.ai_jobs (id, workspace_id);

comment on column public.content_versions.ai_job_id is
  'Completes the MVP-1.2 deferral (20260915154503_content.sql). NULL for human-authored versions; populated when generation_method indicates AI generation.';

create index content_versions_ai_job_id_idx on public.content_versions (ai_job_id);

alter table public.marqos_assets
  add column ai_job_id uuid null references public.ai_jobs (id);

alter table public.marqos_assets
  add constraint marqos_assets_ai_job_workspace_fkey
  foreign key (ai_job_id, workspace_id) references public.ai_jobs (id, workspace_id);

comment on column public.marqos_assets.ai_job_id is
  'Completes the MVP-1.2 deferral (20260915154503_content.sql). NULL for human/uploaded assets; populated for AI-generated assets.';

create index marqos_assets_ai_job_id_idx on public.marqos_assets (ai_job_id);

-- =============================================================================
-- RLS (DECISIONS #24, approved)
--
-- All three AI-domain tables: SELECT for workspace members only.
-- NO authenticated INSERT/UPDATE/DELETE policy on any of the three — every
-- write happens via service_role, mirroring 20260916190000_notifications.sql.
-- =============================================================================

alter table public.prompt_versions enable row level security;

create policy "prompt_versions_select_members_or_global"
on public.prompt_versions
for select
to authenticated
using (workspace_id is null or public.is_workspace_member(workspace_id));

alter table public.ai_jobs enable row level security;

create policy "ai_jobs_select_members"
on public.ai_jobs
for select
to authenticated
using (public.is_workspace_member(workspace_id));

alter table public.ai_usage enable row level security;

create policy "ai_usage_select_members"
on public.ai_usage
for select
to authenticated
using (public.is_workspace_member(workspace_id));

-- =============================================================================
-- Grants
--
-- `authenticated` receives exactly what its policies allow: select only, on
-- all three tables. `service_role` receives full CRUD, matching every other
-- table's service_role grant in this database.
-- =============================================================================

grant select on public.prompt_versions to authenticated;
grant select, insert, update, delete on public.prompt_versions to service_role;

grant select on public.ai_jobs to authenticated;
grant select, insert, update, delete on public.ai_jobs to service_role;

grant select on public.ai_usage to authenticated;
grant select, insert, update, delete on public.ai_usage to service_role;
