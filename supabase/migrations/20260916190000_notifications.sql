-- Marketing OS — MVP-2.6: Distribution — Notifications Foundation
--
-- Establishes the Notification domain per Database Architecture §14,
-- Engineering Blueprint §23 (`010_notifications.sql`), ERD §16, and PRD §9
-- ("Notifications (e.g. publication failure) may be introduced here as
-- needed"). This migration is additive — it does not modify Foundation,
-- Storage Foundation, Brand, Content, Storage RBAC, Social Accounts,
-- Publications, Publication Execution, or Publication Scheduler Claim, and
-- does not touch the Calendar (a pure projection, no schema of its own —
-- ERD §10).
--
-- Scope for this migration (MVP-2.6, approved): CORE schema + RLS only.
-- `type` is intentionally left as unconstrained `text`, matching the
-- literal Database Architecture §14 schema (no enum is specified there,
-- unlike every other controlled status field in this database) — this is
-- an explicit, approved deviation from Database Architecture §1 Principle
-- 5 for this one column, not an oversight.
--
-- RLS shape is new to this codebase: `notifications` is the first table
-- requiring BOTH a tenant boundary (workspace membership) AND a row-owner
-- boundary (the specific recipient), unlike `audit_logs` (workspace-wide
-- read for any member) or any brand/content/distribution table (role-based,
-- not recipient-based). See the RLS section below.
--
-- No `authenticated` INSERT policy exists on this table by design.
-- Notifications are written only by trusted server-side code — the
-- existing RLS-scoped client for the user-triggered failure path and the
-- existing service-role client for the scheduler/system failure path,
-- exactly mirroring how `publication-execution.ts` already resolves Vault
-- credentials via a narrowly-scoped service-role call even from its
-- otherwise RLS-scoped, user-facing entry point. This migration introduces
-- no new service-role surface — only a new grant on a new table for the
-- role that already exists.

-- =============================================================================
-- Table
-- =============================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.notifications is
  'In-app notifications addressed to a single workspace member. Database Architecture §14. No UPDATE policy exists beyond the owning user marking read_at; no authenticated INSERT policy — writes go through trusted server-side code only (see migration header).';
comment on column public.notifications.type is
  'Unconstrained text by canonical design (Database Architecture §14 specifies no enum for this column). MVP-2.6 writes only the literal value "publication_failed".';
comment on column public.notifications.data is
  'Safe, non-secret references only (e.g. publication id). Never populated with provider credentials, Vault secrets, tokens, idempotency keys, or raw provider_response.';

-- =============================================================================
-- Indexes
--
-- The only read shape approved for this phase is "a user's own
-- notifications within a workspace, newest first" (listNotificationsForUser)
-- plus a point lookup by primary key (markNotificationRead, already served
-- by the primary key index). One composite index covers both the
-- workspace-scoped and workspace+user-scoped query shapes via the
-- leftmost-prefix rule — no additional workspace_id-only index is added.
-- =============================================================================

create index notifications_workspace_user_created_at_idx
  on public.notifications (workspace_id, user_id, created_at desc);

-- =============================================================================
-- RLS
--
-- SELECT: a workspace member may read only their OWN notifications — not
-- every notification in the workspace (unlike audit_logs). Both conditions
-- are required: workspace membership (tenant boundary) AND
-- user_id = auth.uid() (recipient boundary).
--
-- UPDATE: identical boundary, for mark-as-read. No column-level
-- restriction is enforced at the database layer in this milestone (no
-- trigger is introduced for this) — the service layer
-- (markNotificationRead) is solely responsible for only ever sending
-- `read_at` in its update payload.
--
-- INSERT: no policy for `authenticated`. Notifications are created only by
-- trusted server-side code (see migration header).
--
-- DELETE: no policy for `authenticated`. Not part of approved MVP-2.6
-- scope.
-- =============================================================================

alter table public.notifications enable row level security;

create policy "notifications_select_own"
on public.notifications
for select
to authenticated
using (public.is_workspace_member(workspace_id) and user_id = auth.uid());

create policy "notifications_update_own"
on public.notifications
for update
to authenticated
using (public.is_workspace_member(workspace_id) and user_id = auth.uid())
with check (public.is_workspace_member(workspace_id) and user_id = auth.uid());

-- No INSERT/DELETE policy for `authenticated` — see migration header and
-- RLS section comment above.

-- =============================================================================
-- Grants
--
-- auto_expose_new_tables is false (supabase/config.toml); explicit grants
-- are required regardless. `authenticated` receives select/update only —
-- no insert (writes are server-side/trusted-code only, enforced by the
-- absence of both a grant and a policy). `service_role` receives full CRUD,
-- matching every other table's service_role grant in this database.
-- =============================================================================

grant select, update on public.notifications to authenticated;
grant select, insert, update, delete on public.notifications to service_role;
