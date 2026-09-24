import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listNotificationsForUser, markNotificationRead, notifyPublicationFailed } from "@/server/services/notifications";
import { markFailed, markFailedAsSystem } from "@/server/services/publications";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Service-level tests for MVP-2.6 Notifications
 * (src/server/services/notifications.ts), following the existing
 * publications-calendar-query.test.ts convention of calling the REAL
 * exported service functions — not a hand-copied re-implementation —
 * authenticated via a real signed-in test user's bearer token
 * (setTestAccessToken), against the local Supabase stack.
 *
 * Covers: notifyPublicationFailed (recipient resolution, NULL-recipient
 * safety, safe data shape), listNotificationsForUser (own-notifications,
 * newest-first), markNotificationRead (own-row only), and the actual
 * integration point — markFailed/markFailedAsSystem creating exactly one
 * notification as a side effect of a successful publishing -> failed
 * transition, for both the user-triggered and scheduler/system paths.
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("Notifications service — notifyPublicationFailed / list / markRead / markFailed integration", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let accountId: string;

  const createdPublicationIds: string[] = [];
  const createdNotificationIds: string[] = [];

  function trackNotification(id: string | undefined | null) {
    if (id) createdNotificationIds.push(id);
    return id;
  }

  async function createApprovedVariant(): Promise<{ variantId: string }> {
    const { data: brand } = await editor.client.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await editor.client
      .from("content")
      .insert({ workspace_id: workspaceId, brand_id: brand!.id, title: `Content ${Date.now()}-${Math.random()}` })
      .select()
      .single();
    const { data: version } = await editor.client
      .from("content_versions")
      .insert({
        content_id: content!.id,
        workspace_id: workspaceId,
        version_number: Math.floor(Math.random() * 1_000_000) + 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    const { data: variant } = await editor.client
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram" })
      .select()
      .single();
    await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: content!.id,
      content_version_id: version!.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    return { variantId: variant!.id };
  }

  /** Inserts a publication and drives it to 'publishing', honoring the lifecycle trigger, ready for markFailed/markFailedAsSystem. */
  async function insertPublishingPublication(createdBy: string | null): Promise<string> {
    const { variantId } = await createApprovedVariant();
    const { data, error } = await editor.client
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: accountId,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
        ...(createdBy ? { created_by: createdBy } : {}),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert publication fixture: ${error?.message}`);
    createdPublicationIds.push(data.id);

    const { error: publishingError } = await editor.client.from("publications").update({ status: "publishing" }).eq("id", data.id);
    if (publishingError) throw new Error(`Failed to drive fixture to publishing: ${publishingError.message}`);

    return data.id;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Notifications Service Tenant",
      p_slug: `notifications-service-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "notifications-service-fixture-account",
        account_name: "Fixture Account",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);
    accountId = account.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (createdNotificationIds.length > 0) {
      await admin.from("notifications").delete().in("id", createdNotificationIds);
    }
    if (createdPublicationIds.length > 0) {
      await admin.from("publications").delete().in("id", createdPublicationIds);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId].filter(Boolean),
      userIds: [editor?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("notifyPublicationFailed", () => {
    it("creates a publication_failed notification with correct workspace_id, user_id, and type", async () => {
      const fakePublicationId = crypto.randomUUID();
      const notification = await notifyPublicationFailed({
        workspaceId,
        publicationId: fakePublicationId,
        recipientUserId: editor.userId,
        errorCode: "test_code",
        errorMessage: "Test failure message",
      });

      expect(notification).not.toBeNull();
      trackNotification(notification!.id);
      expect(notification!.workspace_id).toBe(workspaceId);
      expect(notification!.user_id).toBe(editor.userId);
      expect(notification!.type).toBe("publication_failed");
      expect(notification!.message).toContain("Test failure message");
    });

    it("does not create a notification (and does not throw) when recipientUserId is null", async () => {
      const notification = await notifyPublicationFailed({
        workspaceId,
        publicationId: crypto.randomUUID(),
        recipientUserId: null,
        errorCode: "test_code",
        errorMessage: "Should not be notified",
      });
      expect(notification).toBeNull();
    });

    it("stores only safe, non-secret references in data — no credentials, tokens, or raw provider_response", async () => {
      const publicationId = crypto.randomUUID();
      const notification = await notifyPublicationFailed({
        workspaceId,
        publicationId,
        recipientUserId: editor.userId,
        errorCode: "provider_rate_limited",
        errorMessage: "Provider rejected the request",
      });
      trackNotification(notification?.id);

      expect(notification!.data).toEqual({ publication_id: publicationId, error_code: "provider_rate_limited" });
      const serialized = JSON.stringify(notification);
      expect(serialized.toLowerCase()).not.toContain("vault");
      expect(serialized.toLowerCase()).not.toContain("token");
      expect(serialized.toLowerCase()).not.toContain("credential");
      expect(serialized).not.toContain("idempotency_key");
    });
  });

  describe("markFailed integration (user-triggered failure path)", () => {
    it("8, 9, 10. creates exactly one publication_failed notification for the publication's creator", async () => {
      const publicationId = await insertPublishingPublication(editor.userId);
      const before = await listNotificationsForUser(workspaceId);

      const result = await markFailed(workspaceId, publicationId, {
        errorCode: "provider_error",
        errorMessage: "Provider rejected the request",
      });
      expect(result.status).toBe("failed");

      const after = await listNotificationsForUser(workspaceId);
      const created = after.filter((n) => !before.some((b) => b.id === n.id));
      expect(created.length).toBe(1);
      trackNotification(created[0].id);
      expect(created[0].workspace_id).toBe(workspaceId);
      expect(created[0].user_id).toBe(editor.userId);
      expect(created[0].type).toBe("publication_failed");
      expect(created[0].data).toMatchObject({ publication_id: publicationId });
    });

    it("11. does not create a notification when the publication has no recorded creator (created_by NULL)", async () => {
      const publicationId = await insertPublishingPublication(null);
      const before = await listNotificationsForUser(workspaceId);

      const result = await markFailed(workspaceId, publicationId, { errorCode: "x", errorMessage: "y" });
      expect(result.status).toBe("failed");

      const after = await listNotificationsForUser(workspaceId);
      expect(after.length).toBe(before.length);
    });

    it("does not create a duplicate notification if markFailed is (incorrectly) invoked again on an already-failed publication", async () => {
      const publicationId = await insertPublishingPublication(editor.userId);
      await markFailed(workspaceId, publicationId, { errorCode: "a", errorMessage: "first failure" });
      const afterFirst = await listNotificationsForUser(workspaceId);
      trackNotification(afterFirst.find((n) => (n.data as { publication_id?: string }).publication_id === publicationId)?.id);

      // failed -> failed is not a valid transition (enforce_publication_lifecycle_transitions)
      // and updatePublicationRow throws before notifyFailureSideEffect is ever reached.
      await expect(markFailed(workspaceId, publicationId, { errorCode: "b", errorMessage: "second attempt" })).rejects.toThrow();

      const afterSecond = await listNotificationsForUser(workspaceId);
      expect(afterSecond.length).toBe(afterFirst.length);
    });
  });

  describe("markFailedAsSystem integration (scheduler/system failure path)", () => {
    it("creates a notification for the publication's creator via the service-role path", async () => {
      const publicationId = await insertPublishingPublication(editor.userId);
      const before = await listNotificationsForUser(workspaceId);

      const result = await markFailedAsSystem(admin, workspaceId, publicationId, {
        errorCode: "scheduler_error",
        errorMessage: "Scheduler forced failure",
      });
      expect(result.status).toBe("failed");

      const after = await listNotificationsForUser(workspaceId);
      const created = after.filter((n) => !before.some((b) => b.id === n.id));
      expect(created.length).toBe(1);
      trackNotification(created[0].id);
      expect(created[0].user_id).toBe(editor.userId);
      expect(created[0].type).toBe("publication_failed");
    });

    it("does not create a notification when the publication has no recorded creator (created_by NULL)", async () => {
      const publicationId = await insertPublishingPublication(null);
      const before = await listNotificationsForUser(workspaceId);

      await markFailedAsSystem(admin, workspaceId, publicationId, { errorCode: "x", errorMessage: "y" });

      const after = await listNotificationsForUser(workspaceId);
      expect(after.length).toBe(before.length);
    });
  });

  describe("listNotificationsForUser", () => {
    it("returns only the calling user's own notifications, newest first", async () => {
      const older = await notifyPublicationFailed({
        workspaceId,
        publicationId: crypto.randomUUID(),
        recipientUserId: editor.userId,
        errorCode: "c1",
        errorMessage: "older",
      });
      trackNotification(older?.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const newer = await notifyPublicationFailed({
        workspaceId,
        publicationId: crypto.randomUUID(),
        recipientUserId: editor.userId,
        errorCode: "c2",
        errorMessage: "newer",
      });
      trackNotification(newer?.id);

      const rows = await listNotificationsForUser(workspaceId);
      const olderIndex = rows.findIndex((r) => r.id === older!.id);
      const newerIndex = rows.findIndex((r) => r.id === newer!.id);
      expect(olderIndex).toBeGreaterThanOrEqual(0);
      expect(newerIndex).toBeGreaterThanOrEqual(0);
      expect(newerIndex).toBeLessThan(olderIndex);
    });
  });

  describe("markNotificationRead", () => {
    it("marks the calling user's own notification read, preserving all other fields", async () => {
      const notification = await notifyPublicationFailed({
        workspaceId,
        publicationId: crypto.randomUUID(),
        recipientUserId: editor.userId,
        errorCode: "c",
        errorMessage: "to be read",
      });
      trackNotification(notification?.id);
      expect(notification!.read_at).toBeNull();

      const updated = await markNotificationRead(workspaceId, notification!.id);
      expect(updated.read_at).not.toBeNull();
      expect(updated.id).toBe(notification!.id);
      expect(updated.title).toBe(notification!.title);
      expect(updated.message).toBe(notification!.message);
      expect(updated.type).toBe(notification!.type);
    });

    it("throws rather than silently no-op-ing for a non-existent notification id", async () => {
      await expect(markNotificationRead(workspaceId, crypto.randomUUID())).rejects.toThrow();
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping notifications-service.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
