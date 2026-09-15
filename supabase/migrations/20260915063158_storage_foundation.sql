-- Marketing OS — MVP-0 Foundation: Storage
--
-- Bucket: `assets` (private). Object path convention:
--   {workspace_id}/{asset_id}.{extension}
-- The first path segment is always the owning workspace's UUID; RLS on
-- storage.objects enforces isolation on that segment. No `assets` business
-- table exists yet (that belongs to MVP-1) — this migration establishes
-- storage-layer tenant isolation only.

-- =============================================================================
-- Bucket
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

-- =============================================================================
-- Path parsing helper
--
-- storage.foldername(name) returns the path segments as text; casting the
-- first segment directly to uuid inside an RLS predicate would raise an
-- exception (and abort the whole query, not just deny that row) for any
-- object whose path doesn't start with a valid UUID. This function
-- swallows that failure and returns NULL instead, so malformed paths are
-- cleanly denied rather than erroring.
-- =============================================================================

create or replace function public.storage_object_workspace_id(p_name text)
returns uuid
language plpgsql
stable
as $$
declare
  v_segment text;
  v_workspace_id uuid;
begin
  v_segment := (storage.foldername(p_name))[1];
  if v_segment is null then
    return null;
  end if;

  begin
    v_workspace_id := v_segment::uuid;
  exception when invalid_text_representation then
    return null;
  end;

  return v_workspace_id;
end;
$$;

grant execute on function public.storage_object_workspace_id(text) to authenticated, service_role;

-- =============================================================================
-- RLS on storage.objects, scoped to the `assets` bucket
--
-- storage.objects already has RLS enabled by the Storage system; these
-- policies are additive. Any member of the workspace named in the object's
-- path may read/write; per-role granularity (e.g. viewer = read-only) is
-- deferred until the Assets domain (MVP-1) defines real business rules —
-- Phase 0's requirement is tenant isolation, not RBAC on file operations.
-- =============================================================================

create policy "assets_select_workspace_members"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'assets'
  and public.is_workspace_member(public.storage_object_workspace_id(name))
);

create policy "assets_insert_workspace_members"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'assets'
  and public.is_workspace_member(public.storage_object_workspace_id(name))
);

create policy "assets_update_workspace_members"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'assets'
  and public.is_workspace_member(public.storage_object_workspace_id(name))
)
with check (
  bucket_id = 'assets'
  and public.is_workspace_member(public.storage_object_workspace_id(name))
);

create policy "assets_delete_workspace_members"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'assets'
  and public.is_workspace_member(public.storage_object_workspace_id(name))
);
