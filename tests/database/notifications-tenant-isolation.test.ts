import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";

/**
 * RLS / tenant + recipient isolation tests for the MVP-2.6 Notifications
 * migration (notifications), per Database Architecture §14 and the MVP-2.6
 * approved RLS model: SELECT/UPDATE require BOTH workspace membership
 * (tenant boundary) AND user_id = auth.uid() (recipient boundary) — unlike
 * audit_logs, where any workspace member may read every row. There is no
 * `authenticated` INSERT policy at all; notifications are written only by
 * trusted server-side code (service-role), asserted here directly against
 * the table.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning.
 */
describe.skipIf(!hasLocalSupabase)("Notifications RLS — recipient + tenant isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let memberA: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let memberB: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;

  let notificationForA: string;
  let notificationForB: string;
  let notificationInOtherWorkspace: string;

  const createdNotificationIds: string[] = [];
  function track(id: string | undefined) {
    if (id) createdNotificationIds.push(id);
    return id;
  }

  async function seedNotification(workspace: string, userId: string): Promise<string> {
    const { data, error } = await admin
      .from("notifications")
      .insert({
        workspace_id: workspace,
        user_id: userId,
        type: "publication_failed",
        title: "Publication failed",
        message: "Fixture notification",
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to seed notification fixture: ${error?.message}`);
    return track(data.id)!;
  }

  beforeAll(async () => {
    memberA = await createSignedInTestUser(admin);
    memberB = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await memberA.client.rpc("create_workspace", {
      p_name: "Notifications Tenant A",
      p_slug: `notifications-a-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { error: memberBError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: memberB.userId, role: "viewer" });
    if (memberBError) throw new Error(`Failed to add memberB to workspace: ${memberBError.message}`);

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Notifications Tenant B",
      p_slug: `notifications-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    notificationForA = await seedNotification(workspaceId, memberA.userId);
    notificationForB = await seedNotification(workspaceId, memberB.userId);
    notificationInOtherWorkspace = await seedNotification(otherWorkspaceId, outsider.userId);
  });

  afterAll(async () => {
    if (createdNotificationIds.length > 0) {
      await admin.from("notifications").delete().in("id", createdNotificationIds);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [memberA?.userId, memberB?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("read access", () => {
    it("1. allows a workspace member to read their own notification", async () => {
      const { data, error } = await memberA.client.from("notifications").select("*").eq("id", notificationForA).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(notificationForA);
    });

    it("2. denies a workspace member from reading another member's notification in the SAME workspace", async () => {
      const { data, error } = await memberA.client.from("notifications").select("*").eq("id", notificationForB).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("3. denies a non-member from reading notifications in a workspace they don't belong to", async () => {
      const { data, error } = await memberA.client
        .from("notifications")
        .select("*")
        .eq("id", notificationInOtherWorkspace)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("4. ownership is enforced on a workspace-scoped list query, not only a direct-id lookup", async () => {
      const { data, error } = await memberA.client.from("notifications").select("id").eq("workspace_id", workspaceId);
      expect(error).toBeNull();
      const ids = (data ?? []).map((row) => row.id);
      expect(ids).toContain(notificationForA);
      expect(ids).not.toContain(notificationForB);
    });
  });

  describe("mark-as-read authorization", () => {
    it("5. allows a user to mark their OWN notification's read_at", async () => {
      const id = await seedNotification(workspaceId, memberA.userId);
      const { data, error } = await memberA.client
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.read_at).not.toBeNull();
    });

    it("6. denies a user from marking ANOTHER user's notification as read (same workspace)", async () => {
      const { data, error } = await memberA.client
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", notificationForB)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: stillUnread } = await admin.from("notifications").select("read_at").eq("id", notificationForB).single();
      expect(stillUnread?.read_at).toBeNull();
    });
  });

  describe("insert authorization", () => {
    it("7a. insert succeeds through trusted server-side code (service-role)", async () => {
      const id = await seedNotification(workspaceId, memberA.userId);
      const { data } = await admin.from("notifications").select("id").eq("id", id).single();
      expect(data?.id).toBe(id);
    });

    it("7b. no authenticated INSERT policy exists — a direct client insert is rejected even for the recipient's own user_id", async () => {
      const { data, error } = await memberA.client
        .from("notifications")
        .insert({
          workspace_id: workspaceId,
          user_id: memberA.userId,
          type: "publication_failed",
          title: "Should not be allowed",
          message: "Should not be allowed",
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping notifications-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
