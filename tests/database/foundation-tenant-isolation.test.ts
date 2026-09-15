import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTestData,
  createSignedInTestUser,
  hasLocalSupabase,
  serviceRoleClient,
} from "./helpers";

/**
 * RLS / tenant isolation tests for the MVP-0 Foundation migration
 * (workspaces, workspace_members, audit_logs) and the `assets` storage
 * bucket, per Engineering Blueprint §24 and Database Architecture §20:
 * every exposed workspace-scoped table must prove (a) an authenticated
 * member of the owning workspace can perform the operations their role
 * permits, and (b) an authenticated non-member is denied entirely.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning, so `npm test` stays
 * green in environments without Docker.
 */
describe.skipIf(!hasLocalSupabase)("Foundation RLS — tenant isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let memberA: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let memberB: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceAId: string;

  beforeAll(async () => {
    memberA = await createSignedInTestUser(admin);
    memberB = await createSignedInTestUser(admin);

    const { data: workspace, error } = await memberA.client.rpc("create_workspace", {
      p_name: "Tenant A",
      p_slug: `tenant-a-${Date.now()}`,
    });
    if (error || !workspace) {
      throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    }
    workspaceAId = workspace.id;
  });

  afterAll(async () => {
    await cleanupTestData(admin, {
      workspaceIds: [workspaceAId].filter(Boolean),
      userIds: [memberA?.userId, memberB?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("workspaces", () => {
    it("allows a member to see their own workspace", async () => {
      const { data, error } = await memberA.client
        .from("workspaces")
        .select("*")
        .eq("id", workspaceAId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.id).toBe(workspaceAId);
    });

    it("hides the workspace from a non-member", async () => {
      const { data, error } = await memberB.client
        .from("workspaces")
        .select("*")
        .eq("id", workspaceAId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a non-member's attempt to rename the workspace", async () => {
      const { data, error } = await memberB.client
        .from("workspaces")
        .update({ name: "Hijacked" })
        .eq("id", workspaceAId)
        .select();

      // RLS denial surfaces as zero affected rows, not a thrown error.
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: unchanged } = await admin
        .from("workspaces")
        .select("name")
        .eq("id", workspaceAId)
        .single();
      expect(unchanged?.name).toBe("Tenant A");
    });
  });

  describe("workspace_members", () => {
    it("allows a member to see the membership roster of their workspace", async () => {
      const { data, error } = await memberA.client
        .from("workspace_members")
        .select("*")
        .eq("workspace_id", workspaceAId);

      expect(error).toBeNull();
      expect(data?.some((row) => row.user_id === memberA.userId && row.role === "owner")).toBe(
        true,
      );
    });

    it("hides the membership roster from a non-member", async () => {
      const { data, error } = await memberB.client
        .from("workspace_members")
        .select("*")
        .eq("workspace_id", workspaceAId);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("denies a non-member from inserting themselves as a member", async () => {
      const { data, error } = await memberB.client
        .from("workspace_members")
        .insert({ workspace_id: workspaceAId, user_id: memberB.userId, role: "owner" })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("audit_logs", () => {
    it("allows a member to see audit history for their workspace", async () => {
      const { data, error } = await memberA.client
        .from("audit_logs")
        .select("*")
        .eq("workspace_id", workspaceAId);

      expect(error).toBeNull();
      expect(data?.some((row) => row.action === "workspace.created")).toBe(true);
    });

    it("hides audit history from a non-member", async () => {
      const { data, error } = await memberB.client
        .from("audit_logs")
        .select("*")
        .eq("workspace_id", workspaceAId);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("denies log_audit_event() to a non-member", async () => {
      const { error } = await memberB.client.rpc("log_audit_event", {
        p_workspace_id: workspaceAId,
        p_action: "forged.entry",
        p_entity_type: "workspace",
      });

      expect(error).not.toBeNull();
    });
  });

  describe("storage: assets bucket", () => {
    const objectPathFor = (workspaceId: string) => `${workspaceId}/${crypto.randomUUID()}.txt`;

    it("allows a member to upload into their own workspace folder", async () => {
      const path = objectPathFor(workspaceAId);
      const { error } = await memberA.client.storage
        .from("assets")
        .upload(path, new Blob(["hello"], { type: "text/plain" }));

      expect(error).toBeNull();

      await admin.storage.from("assets").remove([path]);
    });

    it("denies a non-member uploading into someone else's workspace folder", async () => {
      const path = objectPathFor(workspaceAId);
      const { error } = await memberB.client.storage
        .from("assets")
        .upload(path, new Blob(["hello"], { type: "text/plain" }));

      expect(error).not.toBeNull();
    });

    it("denies a non-member reading an object from another workspace's folder", async () => {
      const path = objectPathFor(workspaceAId);
      await admin.storage.from("assets").upload(path, new Blob(["hello"], { type: "text/plain" }));

      const { data, error } = await memberB.client.storage.from("assets").download(path);

      expect(data).toBeNull();
      expect(error).not.toBeNull();

      await admin.storage.from("assets").remove([path]);
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping foundation-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
