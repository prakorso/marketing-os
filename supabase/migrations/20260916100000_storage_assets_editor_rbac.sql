-- Marketing OS — MVP-1 Stabilization: Storage RBAC tightening
--
-- The Storage Foundation migration (20260915063158) intentionally deferred
-- per-role granularity on storage.objects, granting any workspace member
-- read+write on the `assets` bucket ("per-role granularity ... is deferred
-- until the Assets domain (MVP-1) defines real business rules"). MVP-1's
-- Assets domain (src/server/services/assets.ts) gates uploads through
-- assertEditor() at the application layer, but that only protects the
-- app's own Server Action path — a client calling the Supabase Storage
-- API directly with their own authenticated session is bound only by RLS.
-- Confirmed: a workspace viewer could upload, overwrite, or delete raw
-- storage objects for any workspace they belong to.
--
-- This migration closes that gap by tightening INSERT/UPDATE/DELETE on
-- the `assets` bucket to workspace editors (owner/admin/marketer), reusing
-- the is_workspace_editor() helper already introduced by the Brand domain
-- migration (20260915153033) for the same write-role split. SELECT is
-- left untouched — any workspace member may still read/download assets.
--
-- Additive only: drops and recreates the INSERT/UPDATE/DELETE policies by
-- name (idempotent, no duplicate/conflicting policies); does not modify
-- the Foundation or Storage Foundation migration files.

drop policy if exists "assets_insert_workspace_members" on storage.objects;
drop policy if exists "assets_update_workspace_members" on storage.objects;
drop policy if exists "assets_delete_workspace_members" on storage.objects;

create policy "assets_insert_workspace_editors"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'assets'
  and public.is_workspace_editor(public.storage_object_workspace_id(name))
);

create policy "assets_update_workspace_editors"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'assets'
  and public.is_workspace_editor(public.storage_object_workspace_id(name))
)
with check (
  bucket_id = 'assets'
  and public.is_workspace_editor(public.storage_object_workspace_id(name))
);

create policy "assets_delete_workspace_editors"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'assets'
  and public.is_workspace_editor(public.storage_object_workspace_id(name))
);
