-- Marketing OS — MVP-1.2 Content Domain
-- Tables: content_briefs, content, content_versions, content_variants,
-- marqos_assets, marqos_content_assets, content_approvals
--
-- marqos_assets/marqos_content_assets are intentionally prefixed, not named
-- assets/content_assets: this Supabase project already contains a
-- differently-shaped assets/content_assets table pair belonging to a
-- separate, pre-existing application sharing the project (MVP-5.24 forensic
-- audit; MVP-5.25 remediation, Strategy C — narrow coexistence). The
-- `assets` Storage bucket (20260915063158_storage_foundation.sql) is
-- unaffected and keeps its original name — only these two database tables
-- were renamed.
-- Per Engineering Blueprint §23: RLS is established in the same migration
-- that creates each table. No table here exists without RLS enabled and
-- its policies defined.
--
-- Source of truth: Database Architecture §5 (Content Domain), §6 (Asset
-- Domain), §7 (Approval Domain), §16 (Tenant Consistency Enforcement), §18
-- (Indexing), §19 (Delete/Archive Policy), §20 (RLS Strategy); ERD §5-§8;
-- Engineering Blueprint §9 (Content Architecture), §23 (this migration
-- corresponds to the Blueprint's 003_content.sql grouping, which bundles
-- the Content and Asset domain sections of Database Architecture into one
-- file).
--
-- =============================================================================
-- DEFERRED DEPENDENCIES (not omitted by oversight — explicitly tracked)
-- =============================================================================
--
-- 1. content_versions.ai_job_id, marqos_assets.ai_job_id (Database Architecture
--    §5/§6: "nullable FK -> ai_jobs.id"). The `ai_jobs` table does not exist
--    yet (AI domain, Engineering Blueprint §23 position 007, after this
--    migration's position 003). A nullable FK cannot reference a table that
--    does not exist. Per explicit product decision for MVP-1.2: do NOT
--    create a minimal ai_jobs table to unblock this early.
--
--    THIS DOES NOT WAIVE THE REQUIREMENT. PRD §9 (MVP-1 definition)
--    explicitly requires "AI-generation traceability (generated versions/
--    assets link back to the AI job that produced them)" as part of MVP-1.
--    That requirement is UNMET until a follow-up migration adds:
--      alter table public.content_versions add column ai_job_id uuid
--        references public.ai_jobs (id);
--      alter table public.content_versions add constraint
--        content_versions_ai_job_id_workspace_id_fkey
--        foreign key (ai_job_id, workspace_id)
--        references public.ai_jobs (id, workspace_id);
--      -- (mirror for marqos_assets.ai_job_id)
--    This is the same deferral pattern already used for
--    brand_identity.logo_asset_id in 20260915153033_brand.sql.
--
-- 2. content_briefs.opportunity_id (Database Architecture §5: nullable FK
--    -> opportunities.id). `opportunities` is Intelligence domain (MVP-4).
--    PRD §5 explicitly allows "a brief may exist without an opportunity",
--    so this deferral blocks nothing functionally; added additively when
--    Intelligence domain lands.
--
-- 3. The `enforce_publication_approval_gate` trigger (Database Architecture
--    §17) lives on `publications`, which is Distribution domain (MVP-2) and
--    does not exist yet. `content_approvals` itself is fully created here
--    (PRD §9 places it in MVP-1); the gate trigger is added when
--    `publications` is created.
--
-- =============================================================================
-- ROLE MODEL FOR THIS MIGRATION (explicit product decisions)
-- =============================================================================
--
-- Reuses is_workspace_member() / is_workspace_editor() (owner/admin/
-- marketer) from Foundation/Brand for content_briefs, content,
-- content_versions, content_variants, assets, marqos_content_assets.
--
-- content_approvals is the one exception: INSERT is restricted to
-- is_workspace_admin() (owner/admin only), NOT is_workspace_editor(). This
-- preserves separation of duties between content creation (marketer) and
-- content approval (owner/admin) per explicit product decision. No UPDATE
-- policy at all (approval history is append-only, Database Architecture
-- §7/§19).

-- =============================================================================
-- Enums
-- =============================================================================

create type public.content_brief_status as enum ('draft', 'ready', 'in_progress', 'fulfilled', 'archived');
create type public.content_status as enum ('draft', 'in_review', 'approved', 'changes_requested', 'archived');
create type public.content_variant_status as enum ('draft', 'ready', 'approved', 'archived');
create type public.content_approval_status as enum ('pending', 'approved', 'changes_requested', 'rejected');
create type public.asset_type as enum ('image', 'video', 'audio', 'document', 'other');

-- =============================================================================
-- Tables
-- =============================================================================

-- content_briefs: planning artifact defining what content should say.
create table public.content_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  brand_id uuid not null references public.brands (id) on delete restrict,
  audience_profile_id uuid references public.audience_profiles (id) on delete set null,
  content_pillar_id uuid references public.content_pillars (id) on delete set null,
  title text not null,
  objective text,
  angle text,
  core_message text,
  cta text,
  format text,
  platform_intent jsonb,
  creative_direction jsonb,
  status public.content_brief_status not null default 'draft',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.content_briefs is 'Planning artifact. opportunity_id deferred until Intelligence domain (MVP-4) exists. audience_profile_id/content_pillar_id are plain FKs only (not composite-FK-checked) — Database Architecture §16''s explicit composite-FK list covers brand_id for this table but not these two columns; audience_profiles/content_pillars also have no UNIQUE(id, workspace_id) target to check against, consistent with Database Architecture §5 listing only brand_id as composite-FK-checked here. Archive-only: no DELETE policy, status = ''archived'' instead.';

-- content: the conceptual creative object. Not platform-specific, not a publication.
create table public.content (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  brand_id uuid not null references public.brands (id) on delete restrict,
  brief_id uuid references public.content_briefs (id) on delete set null,
  title text not null,
  content_type text,
  status public.content_status not null default 'draft',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.content is 'content.status is a UI rollup only, never authoritative for publish approval (Database Architecture §17 — enforced once content_approvals + publications exist). Archive-only: no DELETE policy.';

-- content_versions: immutable creative state. Never hard-deleted, never updated.
create table public.content_versions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content (id) on delete restrict,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version_number integer not null,
  source_version_id uuid references public.content_versions (id),
  generation_method text not null,
  content_payload jsonb not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (content_id, version_number),
  unique (id, workspace_id),
  foreign key (content_id, workspace_id) references public.content (id, workspace_id)
);

comment on table public.content_versions is 'Immutable: no updated_at column, no UPDATE policy/grant for any role (Database Architecture §5/§20). Never hard-deleted: no DELETE policy/grant. ai_job_id intentionally deferred — see header note.';

-- content_variants: platform/context adaptation of a content version. Never hard-deleted.
create table public.content_variants (
  id uuid primary key default gen_random_uuid(),
  content_version_id uuid not null references public.content_versions (id) on delete restrict,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  platform text,
  format text,
  caption text,
  copy_payload jsonb,
  metadata jsonb,
  status public.content_variant_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (content_version_id, workspace_id) references public.content_versions (id, workspace_id)
);

comment on table public.content_variants is 'platform is intentionally unconstrained text (PRD platform-abstraction principle). Never hard-deleted (Database Architecture §19): no DELETE policy/grant.';

-- marqos_assets: media metadata. Binary files live in Supabase Storage (assets bucket, Foundation).
create table public.marqos_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  brand_id uuid references public.brands (id) on delete set null,
  storage_bucket text not null default 'assets',
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  asset_type public.asset_type not null,
  file_size bigint not null,
  width integer,
  height integer,
  duration_ms integer,
  checksum text,
  metadata jsonb,
  source_asset_id uuid references public.marqos_assets (id),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, workspace_id),
  foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.marqos_assets is 'Metadata only — binary content lives in the `assets` Storage bucket (20260915063158_storage_foundation.sql), path convention {workspace_id}/{asset_id}.{ext}. ai_job_id intentionally deferred — see header note. Archive-only: no DELETE policy.';

-- marqos_content_assets: junction allowing asset reuse and deterministic carousel ordering.
create table public.marqos_content_assets (
  content_id uuid not null references public.content (id) on delete cascade,
  asset_id uuid not null references public.marqos_assets (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role text,
  sort_order integer,
  created_at timestamptz not null default now(),
  primary key (content_id, asset_id),
  foreign key (content_id, workspace_id) references public.content (id, workspace_id),
  foreign key (asset_id, workspace_id) references public.marqos_assets (id, workspace_id)
);

comment on table public.marqos_content_assets is 'Junction table. Not a historical record — deleting a row removes the asset association only, never the underlying asset.';

-- content_approvals: append-only approval history. Publication authorization source of truth.
create table public.content_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  content_id uuid not null references public.content (id) on delete restrict,
  content_version_id uuid references public.content_versions (id) on delete restrict,
  status public.content_approval_status not null default 'pending',
  comment text,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (content_id, workspace_id) references public.content (id, workspace_id),
  foreign key (content_version_id, workspace_id) references public.content_versions (id, workspace_id)
);

comment on table public.content_approvals is 'Append-only: no UPDATE/DELETE policy or grant for any role. INSERT restricted to owner/admin (separation of duties from content authorship) — see header note. content_version_id must be populated for an approval to satisfy the future Publication Approval Gate (Database Architecture §17).';

-- =============================================================================
-- Indexes (Database Architecture §18)
-- =============================================================================

create index content_briefs_workspace_id_idx on public.content_briefs (workspace_id);
create index content_briefs_brand_id_idx on public.content_briefs (brand_id);
create index content_briefs_status_idx on public.content_briefs (status);

create index content_workspace_id_idx on public.content (workspace_id);
create index content_brand_id_idx on public.content (brand_id);
create index content_brief_id_idx on public.content (brief_id);
create index content_status_idx on public.content (status);

create index content_versions_workspace_id_idx on public.content_versions (workspace_id);
create index content_versions_content_id_idx on public.content_versions (content_id);

create index content_variants_workspace_id_idx on public.content_variants (workspace_id);
create index content_variants_content_version_id_idx on public.content_variants (content_version_id);
create index content_variants_status_idx on public.content_variants (status);

create index marqos_assets_workspace_id_idx on public.marqos_assets (workspace_id);
create index marqos_assets_brand_id_idx on public.marqos_assets (brand_id);
create index marqos_assets_asset_type_idx on public.marqos_assets (asset_type);

create index marqos_content_assets_workspace_id_idx on public.marqos_content_assets (workspace_id);
create index marqos_content_assets_asset_id_idx on public.marqos_content_assets (asset_id);

create index content_approvals_workspace_id_idx on public.content_approvals (workspace_id);
create index content_approvals_content_id_idx on public.content_approvals (content_id);
create index content_approvals_content_version_id_idx on public.content_approvals (content_version_id);
create index content_approvals_status_idx on public.content_approvals (status);

-- =============================================================================
-- updated_at triggers (public.set_updated_at() already exists — Foundation)
--
-- content_versions and content_approvals intentionally have none: neither
-- has an updated_at column (immutable / append-only).
-- =============================================================================

create trigger set_content_briefs_updated_at
  before update on public.content_briefs
  for each row
  execute function public.set_updated_at();

create trigger set_content_updated_at
  before update on public.content
  for each row
  execute function public.set_updated_at();

create trigger set_content_variants_updated_at
  before update on public.content_variants
  for each row
  execute function public.set_updated_at();

create trigger set_marqos_assets_updated_at
  before update on public.marqos_assets
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- Row Level Security
--
-- No new helper functions required: is_workspace_member() and
-- is_workspace_editor() (owner/admin/marketer) already exist from
-- Foundation/Brand. content_approvals INSERT uses is_workspace_admin()
-- (owner/admin only), also already existing from Foundation.
-- =============================================================================

alter table public.content_briefs enable row level security;
alter table public.content enable row level security;
alter table public.content_versions enable row level security;
alter table public.content_variants enable row level security;
alter table public.marqos_assets enable row level security;
alter table public.marqos_content_assets enable row level security;
alter table public.content_approvals enable row level security;

-- --- content_briefs -----------------------------------------------------------

create policy "content_briefs_select_members"
on public.content_briefs
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "content_briefs_insert_editors"
on public.content_briefs
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "content_briefs_update_editors"
on public.content_briefs
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

-- No DELETE policy: archive via status = 'archived' (product decision,
-- consistent with brands/content/assets archive-only pattern).

-- --- content -----------------------------------------------------------

create policy "content_select_members"
on public.content
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "content_insert_editors"
on public.content
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "content_update_editors"
on public.content
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

-- No DELETE policy: archive via archived_at/status (Database Architecture §19).

-- --- content_versions -----------------------------------------------------------

create policy "content_versions_select_members"
on public.content_versions
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "content_versions_insert_editors"
on public.content_versions
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

-- No UPDATE policy: versions are immutable (Database Architecture §5/§20).
-- No DELETE policy: versions are never hard-deleted (Database Architecture §19).

-- --- content_variants -----------------------------------------------------------

create policy "content_variants_select_members"
on public.content_variants
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "content_variants_insert_editors"
on public.content_variants
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "content_variants_update_editors"
on public.content_variants
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

-- No DELETE policy: variants are never hard-deleted (Database Architecture §19).

-- --- marqos_assets ---------------------------------------------------------

create policy "marqos_assets_select_members"
on public.marqos_assets
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "marqos_assets_insert_editors"
on public.marqos_assets
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "marqos_assets_update_editors"
on public.marqos_assets
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

-- No DELETE policy: archive via archived_at (Database Architecture §19).

-- --- marqos_content_assets -----------------------------------------------------------

create policy "marqos_content_assets_select_members"
on public.marqos_content_assets
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "marqos_content_assets_insert_editors"
on public.marqos_content_assets
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "marqos_content_assets_update_editors"
on public.marqos_content_assets
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

create policy "marqos_content_assets_delete_editors"
on public.marqos_content_assets
for delete
to authenticated
using (public.is_workspace_editor(workspace_id));

-- --- content_approvals -----------------------------------------------------------

create policy "content_approvals_select_members"
on public.content_approvals
for select
to authenticated
using (public.is_workspace_member(workspace_id));

-- INSERT restricted to owner/admin (is_workspace_admin), not
-- is_workspace_editor: separation of duties between authoring (marketer)
-- and approving (owner/admin) — explicit product decision.
create policy "content_approvals_insert_admins"
on public.content_approvals
for insert
to authenticated
with check (public.is_workspace_admin(workspace_id));

-- No UPDATE/DELETE policy: approval history is append-only
-- (Database Architecture §7/§19).

-- =============================================================================
-- Grants
--
-- Same explicit-grant posture as Foundation/Brand: RLS restricts rows,
-- GRANT restricts whether an operation may be attempted at all. `anon`
-- receives no grants. Grants below match the policy set exactly per table
-- (no UPDATE grant on content_versions, no INSERT/UPDATE/DELETE grant
-- beyond INSERT on content_approvals, no DELETE grant on the archive-only
-- tables).
-- =============================================================================

grant select, insert, update on public.content_briefs to authenticated;
grant select, insert, update, delete on public.content_briefs to service_role;

grant select, insert, update on public.content to authenticated;
grant select, insert, update, delete on public.content to service_role;

grant select, insert on public.content_versions to authenticated;
grant select, insert, update, delete on public.content_versions to service_role;

grant select, insert, update on public.content_variants to authenticated;
grant select, insert, update, delete on public.content_variants to service_role;

grant select, insert, update on public.marqos_assets to authenticated;
grant select, insert, update, delete on public.marqos_assets to service_role;

grant select, insert, update, delete on public.marqos_content_assets to authenticated;
grant select, insert, update, delete on public.marqos_content_assets to service_role;

grant select, insert on public.content_approvals to authenticated;
grant select, insert, update, delete on public.content_approvals to service_role;
