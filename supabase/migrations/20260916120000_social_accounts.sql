-- Marketing OS — MVP-2.1: Distribution — Social Accounts Foundation
--
-- Establishes the Social Accounts domain per Database Architecture §8 and
-- Engineering Blueprint §16: workspace-scoped connections to social
-- platforms, with raw credentials stored exclusively in Supabase Vault
-- (never in this table, never in `metadata`). `vault_secret_id` is a bare
-- UUID reference; Vault reads/writes happen only in server-side code using
-- the service role (src/lib/supabase/service-role.ts) — this migration
-- does not grant any workspace role access to the `vault` schema.
--
-- This is an additive migration. It does not modify the Foundation,
-- Storage Foundation, Brand, or Content migrations, and does not touch
-- `publications` (deferred to a later MVP-2.x migration per Engineering
-- Blueprint §23's illustrative sequence, split the same way Brand and
-- Content were delivered as separate migrations).

-- =============================================================================
-- Enums
-- =============================================================================

-- Exactly the four adapters named in Engineering Blueprint §16. Not an
-- open-ended value set — extending it requires a migration (Database
-- Architecture §22).
create type public.social_platform as enum ('instagram', 'tiktok', 'youtube', 'threads');

create type public.social_account_status as enum ('connected', 'disconnected', 'expired', 'revoked', 'error');

-- =============================================================================
-- Table
-- =============================================================================

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  brand_id uuid null references public.brands (id) on delete set null,
  platform public.social_platform not null,
  external_account_id text not null,
  account_name text not null,
  account_handle text null,
  status public.social_account_status not null default 'connected',
  -- Nullable: a disconnected account has no live credential (cleared on
  -- disconnect, per the approved MVP-2.1 decision). NULL whenever
  -- status = 'disconnected'; set whenever status = 'connected'.
  vault_secret_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Composite-FK target (Database Architecture §16).
  constraint social_accounts_id_workspace_id_key unique (id, workspace_id),

  -- Database Architecture §21: "Provider external IDs protected against
  -- duplicates," scoped per workspace + platform so the same physical
  -- account cannot be registered twice in one workspace, while the same
  -- external_account_id under a different platform, or in a different
  -- workspace, is unaffected.
  constraint social_accounts_natural_key_key unique (workspace_id, platform, external_account_id),

  -- Tenant-consistency composite FK (Database Architecture §16): brand_id
  -- is nullable, so this is only checked when brand_id is set (MATCH SIMPLE).
  constraint social_accounts_brand_workspace_fkey
    foreign key (brand_id, workspace_id) references public.brands (id, workspace_id)
);

comment on table public.social_accounts is
  'Workspace-scoped social platform connections. Raw credentials never stored here — see vault_secret_id.';
comment on column public.social_accounts.vault_secret_id is
  'Supabase Vault secret UUID (vault.secrets.id). NULL when disconnected. Never a raw token.';

create index social_accounts_workspace_id_idx on public.social_accounts (workspace_id);
create index social_accounts_workspace_platform_idx on public.social_accounts (workspace_id, platform);
create index social_accounts_workspace_status_idx on public.social_accounts (workspace_id, status);

create trigger set_social_accounts_updated_at
  before update on public.social_accounts
  for each row
  execute function public.set_updated_at();

-- =============================================================================
-- RLS
--
-- SELECT: any workspace member (viewer included) may read non-secret
-- account metadata — vault_secret_id is an inert UUID reference without
-- service-role access to the `vault` schema, which no workspace role has.
-- INSERT/UPDATE: workspace editors only (owner/admin/marketer), matching
-- the established Brand/Content/Assets pattern — no admin-only carve-out
-- (approved MVP-2.1 decision).
-- No DELETE policy: disconnect is a status change (status='disconnected',
-- vault_secret_id=NULL), never a row delete (Database Architecture §19),
-- mirroring the existing `brands` archive-only precedent.
-- =============================================================================

alter table public.social_accounts enable row level security;

create policy "social_accounts_select_workspace_members"
on public.social_accounts
for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy "social_accounts_insert_workspace_editors"
on public.social_accounts
for insert
to authenticated
with check (public.is_workspace_editor(workspace_id));

create policy "social_accounts_update_workspace_editors"
on public.social_accounts
for update
to authenticated
using (public.is_workspace_editor(workspace_id))
with check (public.is_workspace_editor(workspace_id));

grant select, insert, update on public.social_accounts to authenticated;
grant select, insert, update, delete on public.social_accounts to service_role;

-- =============================================================================
-- Vault access wrapper functions
--
-- PostgREST only exposes the `public` and `graphql_public` schemas
-- (supabase/config.toml [api] schemas) — `vault` is not reachable via
-- `.schema('vault')` from any Supabase client, service-role included. These
-- two SECURITY DEFINER wrappers are the only path from application code to
-- Vault, and are themselves grantee-restricted to service_role, so the
-- unexposed `vault` schema stays unexposed and the wrapper surface is
-- narrow and purpose-built rather than the full Vault API. Called only
-- from src/lib/supabase/service-role.ts (never from the RLS-scoped client).
-- =============================================================================

create function public.create_social_account_vault_secret(p_secret text, p_description text default '')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  return vault.create_secret(p_secret, null, p_description);
end;
$$;

create function public.delete_social_account_vault_secret(p_secret_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from vault.secrets where id = p_secret_id;
end;
$$;

revoke all on function public.create_social_account_vault_secret(text, text) from public;
revoke all on function public.delete_social_account_vault_secret(uuid) from public;
grant execute on function public.create_social_account_vault_secret(text, text) to service_role;
grant execute on function public.delete_social_account_vault_secret(uuid) to service_role;
