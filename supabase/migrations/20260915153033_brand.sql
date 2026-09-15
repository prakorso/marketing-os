-- Marketing OS — MVP-1.1 Brand Domain
-- Tables: brands, brand_identity, brand_voice, audience_profiles, content_pillars
-- Per Engineering Blueprint §23: RLS is established in the same migration
-- that creates each table. No table here exists without RLS enabled and
-- its policies defined.
--
-- Source of truth: Database Architecture §3 (Brand Domain), §16 (Tenant
-- Consistency Enforcement), §18 (Indexing), §19 (Delete/Archive Policy),
-- §20 (RLS Strategy); ERD §3 (Workspace/Brand ERD); Engineering Blueprint
-- §7 (Multi-Tenancy — workspace_id direct on brand_identity, brand_voice,
-- audience_profiles, content_pillars) and §8 (Authorization roles).
--
-- Deferred by explicit doc language, not omitted by oversight:
--   * brand_identity.logo_asset_id — Database Architecture §3 specifies it
--     as "nullable FK -> assets.id where dependency order permits". The
--     assets table does not exist yet (Content/Asset domain, MVP-1.3+), so
--     dependency order does not permit it. Added when assets.sql lands.
--
-- Role/write-access judgment call (not explicit in canon, applied
-- consistently and documented here for review): the canonical docs define
-- roles (owner, admin, marketer, viewer) and state only one explicit rule
-- for write access — "Viewers must not receive write access simply because
-- they can read" (Database Architecture §20). Brand context is core
-- marketing configuration operated day-to-day by the "marketer" role (PRD
-- §4 primary user), not a security/membership concern like
-- workspace_members. This migration therefore introduces
-- is_workspace_editor() (owner/admin/marketer) as the write-access check
-- for all five Brand tables, and reserves is_workspace_admin() (owner/admin
-- only) for nothing in this domain — there is no admin-only operation
-- specified for Brand. viewer remains read-only throughout.

-- =============================================================================
-- Enums
-- =============================================================================

create type public.brand_status as enum ('active', 'archived');

-- =============================================================================
-- Tables
-- =============================================================================

-- brands: the tenant-scoped brand root (Database Architecture §3).
create table public.brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text,
  website_url text,
  status public.brand_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

comment on table public.brands is 'Tenant-scoped brand root. Archived via status = ''archived'', never hard-deleted (Database Architecture §19).';

-- brand_identity: 1:1 visual identity config per brand.
create table public.brand_identity (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null unique references public.brands (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  primary_colors jsonb,
  secondary_colors jsonb,
  typography jsonb,
  visual_guidelines jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.brand_identity is 'Visual identity for a brand (1:1). workspace_id is denormalized from brands and composite-FK-checked (Database Architecture §16) so it can never diverge. logo_asset_id deferred to the Content/Asset domain migration.';

-- brand_voice: 1:1 tone-of-voice config per brand.
create table public.brand_voice (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null unique references public.brands (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  tone text,
  personality text,
  preferred_terms jsonb,
  avoid_terms jsonb,
  writing_guidelines text,
  example_copy jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.brand_voice is 'Tone-of-voice guidance for a brand (1:1). workspace_id is denormalized from brands and composite-FK-checked (Database Architecture §16).';

-- audience_profiles: 1:N audience segments per brand.
create table public.audience_profiles (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text,
  demographics jsonb,
  needs jsonb,
  pain_points jsonb,
  motivations jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.audience_profiles is 'Audience segments for a brand (1:N). workspace_id is denormalized from brands and composite-FK-checked (Database Architecture §16).';

-- content_pillars: 1:N strategic content pillars per brand.
create table public.content_pillars (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text,
  priority integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.content_pillars is 'Strategic content pillars for a brand (1:N). workspace_id is denormalized from brands and composite-FK-checked (Database Architecture §16).';

-- =============================================================================
-- Indexes (Database Architecture §18)
-- =============================================================================

create index brands_workspace_id_idx on public.brands (workspace_id);
create index brands_status_idx on public.brands (status);

create index brand_identity_workspace_id_idx on public.brand_identity (workspace_id);

create index brand_voice_workspace_id_idx on public.brand_voice (workspace_id);

create index audience_profiles_workspace_id_idx on public.audience_profiles (workspace_id);
create index audience_profiles_brand_id_idx on public.audience_profiles (brand_id);

create index content_pillars_workspace_id_idx on public.content_pillars (workspace_id);
create index content_pillars_brand_id_idx on public.content_pillars (brand_id);

-- =============================================================================
-- updated_at triggers (public.set_updated_at() already exists — Foundation)
-- =============================================================================

create trigger set_brands_updated_at
  before update on public.brands
  for each row
  execute function public.set_updated_at();

create trigger set_brand_identity_updated_at
  before update on public.brand_identity
  for each row
  execute function public.set_updated_at();

create trigger set_brand_voice_updated_at
  before update on public.brand_voice
  for each row
  execute function public.set_updated_at();

create trigger set_audience_profiles_updated_at
  before update on public.audience_profiles
  for each row
  execute function public.set_updated_at();

create trigger set_content_pillars_updated_at
  before update on public.content_pillars
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- RLS helper: write-role check for Brand domain (SECURITY DEFINER)
--
-- Mirrors the pattern established in Foundation (is_workspace_member,
-- is_workspace_admin): bypasses RLS on workspace_members to avoid recursive
-- policy evaluation. owner/admin/marketer may write; viewer is read-only
-- (Database Architecture §20's one explicit write-access rule).
-- =============================================================================

create or replace function public.is_workspace_editor(p_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin', 'marketer')
  );
$$;

grant execute on function public.is_workspace_editor(uuid) to authenticated, service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.brands enable row level security;
alter table public.brand_identity enable row level security;
alter table public.brand_voice enable row level security;
alter table public.audience_profiles enable row level security;
alter table public.content_pillars enable row level security;

-- --- brands -----------------------------------------------------------

create policy "brands_select_members"
on public.brands
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "brands_insert_editors"
on public.brands
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "brands_update_editors"
on public.brands
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

-- No DELETE policy: brands are archived (status = 'archived'), never
-- hard-deleted in normal operation — mirrors the workspaces precedent
-- (Database Architecture §19, Foundation migration).

-- --- brand_identity -----------------------------------------------------------

create policy "brand_identity_select_members"
on public.brand_identity
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "brand_identity_insert_editors"
on public.brand_identity
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "brand_identity_update_editors"
on public.brand_identity
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

create policy "brand_identity_delete_editors"
on public.brand_identity
for delete
to authenticated
using (public.is_workspace_editor(workspace_id));

-- --- brand_voice -----------------------------------------------------------

create policy "brand_voice_select_members"
on public.brand_voice
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "brand_voice_insert_editors"
on public.brand_voice
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "brand_voice_update_editors"
on public.brand_voice
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

create policy "brand_voice_delete_editors"
on public.brand_voice
for delete
to authenticated
using (public.is_workspace_editor(workspace_id));

-- --- audience_profiles -----------------------------------------------------------

create policy "audience_profiles_select_members"
on public.audience_profiles
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "audience_profiles_insert_editors"
on public.audience_profiles
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "audience_profiles_update_editors"
on public.audience_profiles
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

create policy "audience_profiles_delete_editors"
on public.audience_profiles
for delete
to authenticated
using (public.is_workspace_editor(workspace_id));

-- --- content_pillars -----------------------------------------------------------

create policy "content_pillars_select_members"
on public.content_pillars
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "content_pillars_insert_editors"
on public.content_pillars
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "content_pillars_update_editors"
on public.content_pillars
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

create policy "content_pillars_delete_editors"
on public.content_pillars
for delete
to authenticated
using (public.is_workspace_editor(workspace_id));

-- =============================================================================
-- Grants
--
-- Same explicit-grant posture as Foundation: RLS restricts rows, GRANT
-- restricts whether an operation may be attempted at all. `anon` receives
-- no grants — all access happens after authentication.
-- =============================================================================

grant select, insert, update on public.brands to authenticated;
grant select, insert, update, delete on public.brands to service_role;

grant select, insert, update, delete on public.brand_identity to authenticated;
grant select, insert, update, delete on public.brand_identity to service_role;

grant select, insert, update, delete on public.brand_voice to authenticated;
grant select, insert, update, delete on public.brand_voice to service_role;

grant select, insert, update, delete on public.audience_profiles to authenticated;
grant select, insert, update, delete on public.audience_profiles to service_role;

grant select, insert, update, delete on public.content_pillars to authenticated;
grant select, insert, update, delete on public.content_pillars to service_role;
