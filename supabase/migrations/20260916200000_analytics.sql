-- Marketing OS — MVP-3.1: Analytics Foundation
--
-- Establishes the Analytics domain per Database Architecture §9, Engineering
-- Blueprint §18/§23 (`005_analytics.sql`), ERD §11, and PRD §9 ("Metric
-- ingestion, historical snapshots, normalized metrics, performance
-- scoring"). Additive migration — does not modify Foundation, Storage
-- Foundation, Brand, Content, Storage RBAC, Social Accounts, Publications,
-- Publication Execution, Publication Scheduler Claim, or Notifications, and
-- does not touch the Calendar (a pure projection, no schema of its own).
--
-- Scope for this migration (MVP-3.1, approved): CORE schema + RLS +
-- historical immutability, in full canonical shape for BOTH tables. The
-- application-layer scoring service built alongside this migration
-- implements publication-scoped scoring only (see notifications.ts-style
-- module src/server/services/analytics.ts) — content-scoped scoring is
-- deferred because no canonical document specifies a cross-publication
-- aggregation formula, and inventing one was explicitly out of scope.
-- Deferring the *calculation* does not weaken the *schema*: this migration
-- implements content_performance_scores completely, including score_scope
-- and the exactly-one-of CHECK constraint, exactly as Database Architecture
-- §9 specifies, so content-scoped rows are fully supported by the database
-- the moment a calculation method is approved, with no future migration
-- required to enable it.
--
-- Metric retrieval feeding publication_metric_snapshots is mock-only this
-- phase (src/lib/social/provider.ts's MockProviderAdapter.getMetrics(),
-- mirroring the existing MockProviderAdapter.publish() precedent from
-- MVP-2.3) — no real provider API integration. No automatic scheduled
-- sync, no metric-sync notifications, no Analytics UI.
--
-- `score_type` and `calculation_version` are intentionally unconstrained
-- `text`, matching the literal Database Architecture §9 schema (no enum is
-- specified for either column) — the same approved deviation pattern
-- already used for notifications.type (20260916190000_notifications.sql).
-- `score_scope`, by contrast, IS a canonical enum
-- (`performance_score_scope`: `publication` | `content`) per Database
-- Architecture §9's own text — implemented exactly as specified, not an
-- invention.
--
-- Both tables are append-only and never hard-deleted (Database
-- Architecture §19's explicit list names both
-- `publication_metric_snapshots` and `content_performance_scores`): SELECT
-- for workspace members, INSERT for workspace editors, no UPDATE, no
-- DELETE policy for anyone — mirroring `content_approvals`' append-only
-- RLS shape, not `publications`' mutable-lifecycle shape. Recalculation
-- produces a new row (a new `calculation_version`), never an update to an
-- existing score, per Database Architecture §9's own text ("historical
-- scores remain interpretable even as the aggregation formula evolves").
-- This introduces no new RLS pattern beyond what `content_approvals`
-- already established in this codebase — unlike `notifications`, neither
-- table here needs a row-owner boundary, since both are ordinary
-- workspace-wide business data, not per-user data.

-- =============================================================================
-- Enum
-- =============================================================================

create type public.performance_score_scope as enum ('publication', 'content');

-- =============================================================================
-- Tables
-- =============================================================================

create table public.publication_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  publication_id uuid not null references public.publications (id) on delete restrict,
  captured_at timestamptz not null default now(),
  impressions bigint null,
  reach bigint null,
  views bigint null,
  likes bigint null,
  comments bigint null,
  shares bigint null,
  saves bigint null,
  clicks bigint null,
  engagement_rate numeric null,
  provider_metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  -- Composite-FK target (Database Architecture §9: "supports composite
  -- FKs (§16)"). The documented future consumer is
  -- insight_evidence.publication_metric_snapshot_id (Database Architecture
  -- §11) — insight_evidence does not exist yet (Optimization domain, out
  -- of MVP-3.1 scope), but this constraint is specified for THIS table now
  -- because Database Architecture §9 names it explicitly, not because
  -- insight_evidence is being anticipated speculatively.
  constraint publication_metric_snapshots_id_workspace_id_key unique (id, workspace_id),

  -- Tenant-consistency composite FK (Database Architecture §16): a
  -- snapshot can never reference a publication from a different workspace.
  constraint publication_metric_snapshots_publication_workspace_fkey
    foreign key (publication_id, workspace_id) references public.publications (id, workspace_id)
);

comment on table public.publication_metric_snapshots is
  'Historical, provider-reported metrics for a publication. Never overwritten or deleted (Database Architecture §9/§19) — every sync writes a new row, not an update.';
comment on column public.publication_metric_snapshots.provider_metrics is
  'Raw provider response, kept separate from the normalized columns above (Engineering Blueprint §18: raw and normalized/derived metrics are conceptually separate). Never contains credentials, tokens, or Vault secrets.';

create table public.content_performance_scores (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  score_scope public.performance_score_scope not null,
  publication_id uuid null references public.publications (id) on delete restrict,
  content_id uuid null references public.content (id) on delete restrict,
  score_type text not null,
  score numeric not null,
  calculation_version text not null,
  calculated_at timestamptz not null default now(),
  inputs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  -- Database Architecture §9: exactly one of publication_id/content_id is
  -- set, consistent with score_scope. Implemented in full here even though
  -- MVP-3.1's calculation service only ever writes score_scope='publication'
  -- rows — the schema is not weakened to match the deferred calculation
  -- scope (see migration header).
  constraint content_performance_scores_scope_target_check check (
    (score_scope = 'publication' and publication_id is not null and content_id is null)
    or
    (score_scope = 'content' and content_id is not null and publication_id is null)
  ),

  -- Tenant-consistency composite FKs (Database Architecture §16). Both
  -- referenced columns are nullable; PostgreSQL composite FKs use MATCH
  -- SIMPLE by default, so each is checked only when set.
  constraint content_performance_scores_publication_workspace_fkey
    foreign key (publication_id, workspace_id) references public.publications (id, workspace_id),
  constraint content_performance_scores_content_workspace_fkey
    foreign key (content_id, workspace_id) references public.content (id, workspace_id)
);

comment on table public.content_performance_scores is
  'Derived performance scores, always re-derivable from publication_metric_snapshots. Never overwritten or deleted (Database Architecture §9/§19) — recalculation writes a new row with a new calculation_version, never an UPDATE.';
comment on column public.content_performance_scores.score_type is
  'Unconstrained text by canonical design (Database Architecture §9 specifies no enum for this column). MVP-3.1 writes only "engagement_rate", publication-scoped only — see src/server/services/analytics.ts.';
comment on column public.content_performance_scores.calculation_version is
  'Unconstrained text by canonical design. MVP-3.1 writes only "v1".';

-- =============================================================================
-- Indexes
--
-- Database Architecture §18 names, for publication_metric_snapshots:
-- "(publication_id, captured_at)" and "(workspace_id, captured_at)".
-- workspace_id alone is indexed on every table that carries it (§18,
-- opening bullet); the composite (workspace_id, captured_at) already
-- covers plain workspace_id lookups via the leftmost-prefix rule, but a
-- bare workspace_id index is still added for content_performance_scores,
-- which has no equally-covering composite index named in §18.
-- =============================================================================

create index publication_metric_snapshots_publication_captured_at_idx
  on public.publication_metric_snapshots (publication_id, captured_at);
create index publication_metric_snapshots_workspace_captured_at_idx
  on public.publication_metric_snapshots (workspace_id, captured_at);

create index content_performance_scores_workspace_id_idx
  on public.content_performance_scores (workspace_id);
create index content_performance_scores_publication_id_idx
  on public.content_performance_scores (publication_id);
create index content_performance_scores_content_id_idx
  on public.content_performance_scores (content_id);

-- =============================================================================
-- RLS
--
-- Both tables: SELECT for workspace members, INSERT for workspace editors
-- (owner/admin/marketer — matching publications' write authorization, not
-- content_approvals' stricter admin-only separation of duties, since
-- recording a metric snapshot or a derived score carries no approval
-- semantics). No UPDATE/DELETE policy for either table — append-only,
-- historical (Database Architecture §19).
-- =============================================================================

alter table public.publication_metric_snapshots enable row level security;

create policy "publication_metric_snapshots_select_members"
on public.publication_metric_snapshots
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "publication_metric_snapshots_insert_editors"
on public.publication_metric_snapshots
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

-- No UPDATE/DELETE policy for `authenticated` — see migration header.

alter table public.content_performance_scores enable row level security;

create policy "content_performance_scores_select_members"
on public.content_performance_scores
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "content_performance_scores_insert_editors"
on public.content_performance_scores
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

-- No UPDATE/DELETE policy for `authenticated` — see migration header.

-- =============================================================================
-- Grants
--
-- auto_expose_new_tables is false (supabase/config.toml); explicit grants
-- are required regardless. `authenticated` receives select/insert only, no
-- update/delete, matching the policy set exactly (mirrors
-- content_approvals' grant shape). `service_role` receives full CRUD,
-- matching every other table's service_role grant in this database.
-- =============================================================================

grant select, insert on public.publication_metric_snapshots to authenticated;
grant select, insert, update, delete on public.publication_metric_snapshots to service_role;

grant select, insert on public.content_performance_scores to authenticated;
grant select, insert, update, delete on public.content_performance_scores to service_role;
