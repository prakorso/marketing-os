import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTestData,
  createSignedInTestUser,
  hasLocalSupabase,
  serviceRoleClient,
} from "./helpers";

const BUCKET = "assets";

function textFile(contents: string) {
  return new Blob([contents], { type: "text/plain" });
}

/**
 * RLS tests for the MVP-1 storage RBAC tightening migration
 * (20260916100000_storage_assets_editor_rbac.sql).
 *
 * The Storage Foundation migration originally scoped every storage.objects
 * operation on the `assets` bucket to is_workspace_member(), which let a
 * viewer write/delete raw storage objects directly through the Storage
 * API — bypassing the application-layer assertEditor() check in
 * src/server/services/assets.ts (that check only guards the app's own
 * Server Action path, not a client calling Storage directly with their
 * own session). This suite proves the fix: SELECT stays open to any
 * member, INSERT/UPDATE/DELETE are restricted to workspace editors
 * (owner/admin/marketer), and cross-workspace access remains denied.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning, so `npm test` stays
 * green in environments without Docker.
 */
describe.skipIf(!hasLocalSupabase)("storage.objects RLS — assets bucket RBAC", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;

  const uploadedPaths: string[] = [];

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Storage RBAC Tenant A",
      p_slug: `storage-rbac-a-${Date.now()}`,
    });
    if (error || !workspace) {
      throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    }
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc(
      "create_workspace",
      { p_name: "Storage RBAC Tenant B", p_slug: `storage-rbac-b-${Date.now()}` },
    );
    if (otherError || !otherWorkspace) {
      throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    }
    otherWorkspaceId = otherWorkspace.id;

    // viewer joins workspace A with role = 'viewer'. Direct membership
    // insert requires admin+, so this goes through the service role.
    const { error: memberError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (memberError) {
      throw new Error(`Failed to add viewer to workspace: ${memberError.message}`);
    }

    // Seed one object as the editor (owner), used by the read-access
    // fixtures below.
    const seedPath = `${workspaceId}/${crypto.randomUUID()}.txt`;
    const { error: seedUploadError } = await editor.client.storage
      .from(BUCKET)
      .upload(seedPath, textFile("seed"), { contentType: "text/plain" });
    if (seedUploadError) {
      throw new Error(`Failed to seed storage object: ${seedUploadError.message}`);
    }
    uploadedPaths.push(seedPath);

    (globalThis as { __seedPath?: string }).__seedPath = seedPath;
  });

  afterAll(async () => {
    if (uploadedPaths.length > 0) {
      await admin.storage.from(BUCKET).remove(uploadedPaths);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId, outsider?.userId].filter((id): id is string =>
        Boolean(id),
      ),
    });
  });

  it("allows a member (viewer) to SELECT (download) an object in their workspace", async () => {
    const seedPath = (globalThis as { __seedPath?: string }).__seedPath!;
    const { data, error } = await viewer.client.storage.from(BUCKET).download(seedPath);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it("allows a member (viewer) to SELECT (list) their workspace folder", async () => {
    const { data, error } = await viewer.client.storage.from(BUCKET).list(workspaceId);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("denies a viewer from inserting (uploading) an object", async () => {
    const path = `${workspaceId}/${crypto.randomUUID()}.txt`;
    const { data, error } = await viewer.client.storage
      .from(BUCKET)
      .upload(path, textFile("viewer-attempted"), { contentType: "text/plain" });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("denies a viewer from updating (overwriting) an existing object", async () => {
    const seedPath = (globalThis as { __seedPath?: string }).__seedPath!;
    const { data, error } = await viewer.client.storage
      .from(BUCKET)
      .update(seedPath, textFile("hijacked"), { contentType: "text/plain" });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("denies a viewer from deleting an object", async () => {
    const seedPath = (globalThis as { __seedPath?: string }).__seedPath!;
    const { data, error } = await viewer.client.storage.from(BUCKET).remove([seedPath]);

    // Storage's remove() reports success at the API level but RLS filters
    // the row out of the delete — assert no object was actually removed by
    // confirming it is still readable afterwards, rather than asserting on
    // the response shape alone.
    void data;
    void error;
    const { data: stillThere, error: downloadError } = await editor.client.storage
      .from(BUCKET)
      .download(seedPath);
    expect(downloadError).toBeNull();
    expect(stillThere).not.toBeNull();
  });

  it("allows an editor (owner/admin/marketer) to insert (upload) an object", async () => {
    const path = `${workspaceId}/${crypto.randomUUID()}.txt`;
    const { data, error } = await editor.client.storage
      .from(BUCKET)
      .upload(path, textFile("editor-created"), { contentType: "text/plain" });

    expect(error).toBeNull();
    expect(data?.path).toBe(path);
    uploadedPaths.push(path);
  });

  it("allows an editor to update (overwrite) an existing object", async () => {
    const seedPath = (globalThis as { __seedPath?: string }).__seedPath!;
    const { data, error } = await editor.client.storage
      .from(BUCKET)
      .update(seedPath, textFile("editor-overwritten"), { contentType: "text/plain" });

    expect(error).toBeNull();
    expect(data?.path).toBe(seedPath);
  });

  it("allows an editor to delete an object", async () => {
    const path = `${workspaceId}/${crypto.randomUUID()}.txt`;
    const { error: uploadError } = await editor.client.storage
      .from(BUCKET)
      .upload(path, textFile("to-be-deleted"), { contentType: "text/plain" });
    expect(uploadError).toBeNull();

    const { data, error } = await editor.client.storage.from(BUCKET).remove([path]);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("denies a non-member (outsider) from reading an object in another workspace", async () => {
    const seedPath = (globalThis as { __seedPath?: string }).__seedPath!;
    const { data, error } = await outsider.client.storage.from(BUCKET).download(seedPath);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("denies a non-member (editor of a different workspace) from inserting into another workspace's folder", async () => {
    // outsider is an editor (owner) of otherWorkspaceId, so
    // is_workspace_editor() is true for that workspace — but the path here
    // targets workspaceId, which outsider does not belong to at all.
    const path = `${workspaceId}/${crypto.randomUUID()}.txt`;
    const { data, error } = await outsider.client.storage
      .from(BUCKET)
      .upload(path, textFile("cross-tenant"), { contentType: "text/plain" });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("denies a non-member from deleting an object in another workspace", async () => {
    const seedPath = (globalThis as { __seedPath?: string }).__seedPath!;
    const { data: removeResult, error: removeError } = await outsider.client.storage
      .from(BUCKET)
      .remove([seedPath]);
    void removeResult;
    void removeError;

    const { data: stillThere, error: downloadError } = await editor.client.storage
      .from(BUCKET)
      .download(seedPath);
    expect(downloadError).toBeNull();
    expect(stillThere).not.toBeNull();
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping storage-assets-rbac.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
