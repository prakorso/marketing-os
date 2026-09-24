import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listContentPerformanceScores, listPublicationMetricSnapshots, listSnapshotSummariesForWorkspace } from "@/server/services/analytics";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, metricStatesFixture, serviceRoleClient, supabaseUrl } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Service-level tests for MVP-3.3's read layer
 * (listPublicationMetricSnapshots, listContentPerformanceScores in
 * src/server/services/analytics.ts), following the existing
 * analytics-service.test.ts / analytics-sync.test.ts convention of calling
 * the REAL exported service functions, authenticated via a real signed-in
 * test user's bearer token (setTestAccessToken), against the local
 * Supabase stack.
 *
 * No new RLS policy is introduced by MVP-3.3 (both tables' SELECT policies
 * already exist and are already covered by analytics-tenant-isolation.
 * test.ts), so this file does not repeat workspace-denial RLS coverage —
 * it verifies the service functions' own scoping, ordering, and the
 * explicit absence of an editor-only gate on reads.
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("Analytics read layer — listPublicationMetricSnapshots / listContentPerformanceScores", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let accountId: string;
  let publicationId: string;
  let otherPublicationId: string;
  let emptyPublicationId: string;

  const vaultSecretIds: string[] = [];
  const publicationIds: string[] = [];
  const otherPublicationIds: string[] = [];
  const snapshotIds: string[] = [];
  const scoreIds: string[] = [];

  async function createVaultSecret(secret: string): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: secret,
      p_description: "analytics-query-test",
    });
    if (error || !data) throw new Error(`Failed to create test vault secret: ${error?.message}`);
    vaultSecretIds.push(data as string);
    return data as string;
  }

  async function createApprovedVariant(ws: string, client = editor.client): Promise<{ variantId: string }> {
    const { data: brand } = await client.from("brands").insert({ workspace_id: ws, name: "B" }).select().single();
    const { data: content } = await client
      .from("content")
      .insert({ workspace_id: ws, brand_id: brand!.id, title: `Content ${Date.now()}-${Math.random()}` })
      .select()
      .single();
    const { data: version } = await client
      .from("content_versions")
      .insert({
        content_id: content!.id,
        workspace_id: ws,
        version_number: Math.floor(Math.random() * 1_000_000) + 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    const { data: variant } = await client
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: ws, platform: "instagram" })
      .select()
      .single();
    await admin.from("content_approvals").insert({
      workspace_id: ws,
      content_id: content!.id,
      content_version_id: version!.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    return { variantId: variant!.id };
  }

  /** Inserts a publication and drives it through the real lifecycle to 'published', with an external_publication_id set. */
  async function insertPublishedPublication(
    ws: string,
    socialAccountId: string,
    client = editor.client,
  ): Promise<string> {
    const { variantId } = await createApprovedVariant(ws, client);
    const { data, error } = await client
      .from("publications")
      .insert({
        workspace_id: ws,
        content_variant_id: variantId,
        social_account_id: socialAccountId,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert publication fixture: ${error?.message}`);

    await client.from("publications").update({ status: "publishing" }).eq("id", data.id);
    const { error: publishedError } = await client
      .from("publications")
      .update({ status: "published", published_at: new Date().toISOString(), external_publication_id: `test-ext-${data.id}` })
      .eq("id", data.id);
    if (publishedError) throw new Error(`Failed to drive fixture to published: ${publishedError.message}`);

    return data.id;
  }

  async function seedSnapshot(ws: string, pubId: string, capturedAt: string): Promise<string> {
    const { data, error } = await admin
      .from("publication_metric_snapshots")
      .insert({
        workspace_id: ws,
        publication_id: pubId,
        captured_at: capturedAt,
        captured_at_provenance: "marqos_fallback",
        impressions: 100,
        metric_states: metricStatesFixture(["impressions"]),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to seed snapshot fixture: ${error?.message}`);
    return data.id;
  }

  async function seedPublicationScore(ws: string, pubId: string, calculatedAt: string): Promise<string> {
    const { data, error } = await admin
      .from("content_performance_scores")
      .insert({
        workspace_id: ws,
        score_scope: "publication",
        publication_id: pubId,
        score_type: "engagement_rate",
        score: 0.05,
        calculation_version: "v1",
        calculated_at: calculatedAt,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to seed score fixture: ${error?.message}`);
    return data.id;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Analytics Query Tenant",
      p_slug: `analytics-query-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { error: viewerError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (viewerError) throw new Error(`Failed to add viewer to workspace: ${viewerError.message}`);

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Analytics Query Other Tenant",
      p_slug: `analytics-query-other-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const secretId = await createVaultSecret("dev-only-fixture-secret-analytics-query");
    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "analytics-query-fixture-account",
        account_name: "Fixture Account",
        vault_secret_id: secretId,
        status: "connected",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);
    accountId = account.id;

    publicationId = await insertPublishedPublication(workspaceId, accountId);
    emptyPublicationId = await insertPublishedPublication(workspaceId, accountId);
    publicationIds.push(publicationId, emptyPublicationId);

    const { data: otherAccount } = await outsider.client
      .from("social_accounts")
      .insert({
        workspace_id: otherWorkspaceId,
        platform: "instagram",
        external_account_id: "analytics-query-other-account",
        account_name: "Other Account",
      })
      .select()
      .single();
    otherPublicationId = await insertPublishedPublication(otherWorkspaceId, otherAccount!.id, outsider.client);
    otherPublicationIds.push(otherPublicationId);
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (snapshotIds.length > 0) {
      await admin.from("publication_metric_snapshots").delete().in("id", snapshotIds);
    }
    if (scoreIds.length > 0) {
      await admin.from("content_performance_scores").delete().in("id", scoreIds);
    }
    if (publicationIds.length > 0) {
      await admin.from("publications").delete().in("id", publicationIds);
    }
    if (otherPublicationIds.length > 0) {
      await admin.from("publications").delete().in("id", otherPublicationIds);
    }
    for (const secretId of vaultSecretIds) {
      await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: secretId });
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("listPublicationMetricSnapshots", () => {
    it("returns the snapshots for the requested workspace + publication, in captured_at ascending order", async () => {
      const older = await seedSnapshot(workspaceId, publicationId, "2027-01-01T00:00:00.000Z");
      const newer = await seedSnapshot(workspaceId, publicationId, "2027-01-02T00:00:00.000Z");
      snapshotIds.push(older, newer);

      const rows = await listPublicationMetricSnapshots(workspaceId, publicationId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(older);
      expect(ids).toContain(newer);
      expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
    });

    it("excludes snapshots belonging to a different publication in the same workspace", async () => {
      const otherPubSameWorkspace = await insertPublishedPublication(workspaceId, accountId);
      publicationIds.push(otherPubSameWorkspace);
      const id = await seedSnapshot(workspaceId, otherPubSameWorkspace, "2027-01-01T00:00:00.000Z");
      snapshotIds.push(id);

      const rows = await listPublicationMetricSnapshots(workspaceId, publicationId);
      expect(rows.map((r) => r.id)).not.toContain(id);
    });

    it("excludes snapshots belonging to a different workspace entirely", async () => {
      const id = await seedSnapshot(otherWorkspaceId, otherPublicationId, "2027-01-01T00:00:00.000Z");
      // Not tracked in snapshotIds — cleaned up via otherWorkspaceId cascade on workspace delete.

      const rows = await listPublicationMetricSnapshots(workspaceId, publicationId);
      expect(rows.map((r) => r.id)).not.toContain(id);
    });

    it("returns an empty array, not an error, when no snapshots exist", async () => {
      const rows = await listPublicationMetricSnapshots(workspaceId, emptyPublicationId);
      expect(rows).toEqual([]);
    });

    it("a viewer can read snapshots (no editor-only gate)", async () => {
      const {
        data: { session: viewerSession },
      } = await viewer.client.auth.getSession();
      setTestAccessToken(viewerSession!.access_token);
      try {
        const rows = await listPublicationMetricSnapshots(workspaceId, publicationId);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
      } finally {
        const {
          data: { session: editorSession },
        } = await editor.client.auth.getSession();
        setTestAccessToken(editorSession!.access_token);
      }
    });
  });

  describe("listContentPerformanceScores", () => {
    it("returns publication-scoped scores for the requested workspace + publication, in calculated_at ascending order", async () => {
      const older = await seedPublicationScore(workspaceId, publicationId, "2027-01-01T00:00:00.000Z");
      const newer = await seedPublicationScore(workspaceId, publicationId, "2027-01-02T00:00:00.000Z");
      scoreIds.push(older, newer);

      const rows = await listContentPerformanceScores(workspaceId, publicationId);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(older);
      expect(ids).toContain(newer);
      expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
      for (const row of rows) {
        expect(row.score_scope).toBe("publication");
      }
    });

    it("excludes content-scoped scores", async () => {
      const { data: brand } = await editor.client.from("brands").insert({ workspace_id: workspaceId, name: "B2" }).select().single();
      const { data: content } = await editor.client
        .from("content")
        .insert({ workspace_id: workspaceId, brand_id: brand!.id, title: `Content ${Date.now()}` })
        .select()
        .single();

      const { data: contentScore, error } = await admin
        .from("content_performance_scores")
        .insert({
          workspace_id: workspaceId,
          score_scope: "content",
          content_id: content!.id,
          score_type: "engagement_rate",
          score: 0.1,
          calculation_version: "v1",
        })
        .select()
        .single();
      if (error || !contentScore) throw new Error(`Failed to seed content-scoped score fixture: ${error?.message}`);
      scoreIds.push(contentScore.id);

      const rows = await listContentPerformanceScores(workspaceId, publicationId);
      expect(rows.map((r) => r.id)).not.toContain(contentScore.id);
    });

    it("returns an empty array, not an error, when no scores exist", async () => {
      const rows = await listContentPerformanceScores(workspaceId, emptyPublicationId);
      expect(rows).toEqual([]);
    });

    it("a viewer can read scores (no editor-only gate)", async () => {
      const {
        data: { session: viewerSession },
      } = await viewer.client.auth.getSession();
      setTestAccessToken(viewerSession!.access_token);
      try {
        const rows = await listContentPerformanceScores(workspaceId, publicationId);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
      } finally {
        const {
          data: { session: editorSession },
        } = await editor.client.auth.getSession();
        setTestAccessToken(editorSession!.access_token);
      }
    });
  });

  describe("listSnapshotSummariesForWorkspace", () => {
    it("returns the snapshot count and most recent captured_at per publication", async () => {
      const older = await seedSnapshot(workspaceId, publicationId, "2027-03-01T00:00:00.000Z");
      const newer = await seedSnapshot(workspaceId, publicationId, "2027-03-02T00:00:00.000Z");
      snapshotIds.push(older, newer);

      const summaries = await listSnapshotSummariesForWorkspace(workspaceId);
      const summary = summaries.find((s) => s.publicationId === publicationId);
      expect(summary).toBeDefined();
      expect(summary!.snapshotCount).toBeGreaterThanOrEqual(2);
      expect(new Date(summary!.latestCapturedAt).getTime()).toBe(new Date("2027-03-02T00:00:00.000Z").getTime());
    });

    it("omits a publication with no snapshots entirely, rather than a zero-count row", async () => {
      const summaries = await listSnapshotSummariesForWorkspace(workspaceId);
      expect(summaries.map((s) => s.publicationId)).not.toContain(emptyPublicationId);
    });

    it("never includes another workspace's publications", async () => {
      const summaries = await listSnapshotSummariesForWorkspace(workspaceId);
      expect(summaries.map((s) => s.publicationId)).not.toContain(otherPublicationId);
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping analytics-query.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
