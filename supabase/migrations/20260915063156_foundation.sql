-- Marketing OS — MVP-0 Foundation
-- Tables: profiles, workspaces, workspace_members, audit_logs
-- Per Engineering Blueprint §23: RLS is established in the same migration
-- that creates each table. No table here exists without RLS enabled and
-- its policies defined.

-- =============================================================================
-- Enums
-- =============================================================================

create type public.workspace_role as enum ('owner', 'admin', 'marketer', 'viewer');

-- =============================================================================
-- Shared trigger function: maintain updated_at
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- Tables
-- =============================================================================

-- profiles: application-side user profile, 1:1 with auth.users.
-- No authentication credentials are stored here (Database Architecture §2).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Application profile data for an auth.users identity. No credentials stored here.';

-- workspaces: the primary multi-tenant boundary (Engineering Blueprint §7).
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  owner_id uuid not null references public.profiles (id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.workspaces is 'Tenant root. Archived via archived_at, never hard-deleted in normal operation.';

-- workspace_members: N:M join between profiles and workspaces, carrying role.
create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.workspace_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

comment on table public.workspace_members is 'Workspace membership and role assignment.';

-- audit_logs: append-only audit trail, present from Foundation (Database Architecture §13)
-- so every later domain is auditable from its first write.
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  actor_user_id uuid references public.profiles (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_logs is 'Append-only audit trail. No UPDATE/DELETE policy is defined for any role; writes go through log_audit_event().';

-- entity_id intentionally carries no foreign key: audit_logs is a generic,
-- cross-domain audit trail (any current or future entity type may be
-- logged), unlike insight_evidence's closed, curated typed-FK set
-- (Database Architecture §11, ERD constraint #7), which governs core
-- relational business data rather than log records.

-- =============================================================================
-- Indexes
-- =============================================================================

create index workspaces_owner_id_idx on public.workspaces (owner_id);
create index workspace_members_user_id_idx on public.workspace_members (user_id);
create index audit_logs_workspace_id_created_at_idx on public.audit_logs (workspace_id, created_at desc);
create index audit_logs_actor_user_id_idx on public.audit_logs (actor_user_id);

-- =============================================================================
-- updated_at triggers
-- =============================================================================

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

create trigger set_workspaces_updated_at
  before update on public.workspaces
  for each row
  execute function public.set_updated_at();

create trigger set_workspace_members_updated_at
  before update on public.workspace_members
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- RLS helper functions (SECURITY DEFINER)
--
-- These bypass RLS on workspace_members to avoid the table's own SELECT
-- policy recursively re-invoking itself when referenced from within
-- another policy. They run as the migration-owning role, which owns
-- workspace_members and therefore is exempt from its RLS by default
-- (RLS is enabled, not FORCE-enabled, on every table in this migration).
-- `set search_path = public` guards against search_path hijacking in
-- SECURITY DEFINER functions, per standard Supabase/Postgres guidance.
-- =============================================================================

create or replace function public.is_workspace_member(p_workspace_id uuid)
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
  );
$$;

create or replace function public.is_workspace_admin(p_workspace_id uuid)
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
      and wm.role in ('owner', 'admin')
  );
$$;

create or replace function public.get_workspace_role(p_workspace_id uuid)
returns public.workspace_role
language sql
security definer
set search_path = public
stable
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = auth.uid();
$$;

create or replace function public.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.workspace_members my
    join public.workspace_members their
      on their.workspace_id = my.workspace_id
    where my.user_id = auth.uid()
      and their.user_id = p_user_id
  );
$$;

-- =============================================================================
-- Audit write path
--
-- No INSERT policy is defined on audit_logs for `authenticated`. Client-
-- attributable audit entries are written exclusively through this
-- SECURITY DEFINER function, which pins actor_user_id to auth.uid() (never
-- client-supplied) and requires workspace membership. Server-side code
-- using the service role may still insert directly (service role bypasses
-- RLS), for system/automation-originated entries with no human actor.
-- =============================================================================

create or replace function public.log_audit_event(
  p_workspace_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.audit_logs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log public.audit_logs;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;

  insert into public.audit_logs (workspace_id, actor_user_id, action, entity_type, entity_id, metadata)
  values (p_workspace_id, auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb))
  returning * into v_log;

  return v_log;
end;
$$;

-- =============================================================================
-- Workspace creation RPC
--
-- The sole path for creating a workspace: atomically inserts the workspace
-- and its owner membership row, then records an audit entry. No direct
-- INSERT policy exists on workspaces or workspace_members for
-- `authenticated`, so this invariant (every workspace has exactly one
-- founding owner membership) cannot be bypassed via direct table access.
-- =============================================================================

create or replace function public.create_workspace(p_name text, p_slug text)
returns public.workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.workspaces (name, slug, owner_id)
  values (p_name, p_slug, auth.uid())
  returning * into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace.id, auth.uid(), 'owner');

  perform public.log_audit_event(
    v_workspace.id,
    'workspace.created',
    'workspace',
    v_workspace.id,
    jsonb_build_object('name', p_name, 'slug', p_slug)
  );

  return v_workspace;
end;
$$;

-- =============================================================================
-- New-user profile provisioning
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.audit_logs enable row level security;

-- --- profiles -----------------------------------------------------------

create policy "profiles_select_self_or_workspace_peers"
on public.profiles
for select
to authenticated
using (
  id = auth.uid()
  or public.shares_workspace_with(id)
);

create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- No INSERT/DELETE policy: rows are created by handle_new_user() (SECURITY
-- DEFINER trigger) and removed only via auth.users deletion (cascade).

-- --- workspaces -----------------------------------------------------------

create policy "workspaces_select_members"
on public.workspaces
for select
to authenticated
using (public.is_workspace_member(id));

create policy "workspaces_update_admin"
on public.workspaces
for update
to authenticated
using (public.is_workspace_admin(id))
with check (public.is_workspace_admin(id));

-- No INSERT policy: workspaces are created exclusively via create_workspace().
-- No DELETE policy: workspaces are archived (archived_at), never hard-deleted.

-- --- workspace_members -----------------------------------------------------------

create policy "workspace_members_select_peers"
on public.workspace_members
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "workspace_members_insert_admin"
on public.workspace_members
for insert
to authenticated
with check (public.is_workspace_admin(workspace_id));

create policy "workspace_members_update_admin"
on public.workspace_members
for update
to authenticated
using (public.is_workspace_admin(workspace_id))
with check (public.is_workspace_admin(workspace_id));

create policy "workspace_members_delete_admin"
on public.workspace_members
for delete
to authenticated
using (public.is_workspace_admin(workspace_id));

-- Known follow-up (non-blocking for Phase 0): these policies do not yet
-- prevent an admin from removing the last remaining owner of a workspace.
-- To be hardened when workspace member management UI is built.

-- --- audit_logs -----------------------------------------------------------

create policy "audit_logs_select_members"
on public.audit_logs
for select
to authenticated
using (public.is_workspace_member(workspace_id));

-- No INSERT/UPDATE/DELETE policy for `authenticated`: writes go through
-- log_audit_event() (SECURITY DEFINER) or the service role.

-- =============================================================================
-- Grants
--
-- auto_expose_new_tables is set to false in supabase/config.toml, and the
-- same explicit-grant posture is applied here regardless of environment:
-- RLS restricts rows, GRANT restricts whether an operation may be
-- attempted at all. `anon` receives no grants on these tables — all access
-- happens after authentication.
-- =============================================================================

grant usage on schema public to authenticated, service_role;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

grant select, update on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspaces to service_role;

grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.workspace_members to service_role;

grant select on public.audit_logs to authenticated;
grant select, insert, update, delete on public.audit_logs to service_role;

grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function public.is_workspace_admin(uuid) to authenticated, service_role;
grant execute on function public.get_workspace_role(uuid) to authenticated, service_role;
grant execute on function public.shares_workspace_with(uuid) to authenticated, service_role;
grant execute on function public.create_workspace(text, text) to authenticated, service_role;
grant execute on function public.log_audit_event(uuid, text, text, uuid, jsonb) to authenticated, service_role;
