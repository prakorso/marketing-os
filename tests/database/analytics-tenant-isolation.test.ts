import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, metricStatesFixture, serviceRoleClient } from "./helpers";

// MVP-5.10E: these RLS/CHECK-constraint tests raw-insert snapshot rows
// directly and only ever exercise `impressions` — every other metric is
// fixture-neutral (see metricStatesFixture's doc comment in helpers.ts).
const IMPRESSIONS_ONLY_METRIC_STATES = metricStatesFixture(["impressions"]);

/**
 * RLS / tenant isolation / historical-immutability tests for the MVP-3.1
 * Analytics Foundation migration (publication_metric_snapshots,
 * content_performance_scores), per Database Architecture §9, §16, §19-21
 * and Engineering Blueprint §18/§23.
 *
 * Fixture chain per workspace: brand -> content -> content_version ->
 * content_variant -> social_account -> publication (kept at 'draft' — a
 * valid FK target for snapshot/score rows does not require driving the
 * publication through its full approval/scheduling lifecycle; that
 * business logic is exercised by publications-tenant-isolation.test.ts and
 * this file's companion, analytics-service.test.ts).
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning.
 */
describe.skipIf(!hasLocalSupabase)("Analytics RLS — tenant isolation + historical immutability", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let publicationId: string;
  let otherPublicationId: string;

  const createdSnapshotIds: string[] = [];
  const createdScoreIds: string[] = [];

  async function createDraftPublication(ws: string, client = editor.client): Promise<string> {
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
    const { data: account } = await client
      .from("social_accounts")
      .insert({
        workspace_id: ws,
        platform: "instagram",
        external_account_id: `analytics-fixture-${Date.now()}-${Math.random()}`,
        account_name: "Fixture Account",
      })
      .select()
      .single();
    const { data: publication, error } = await client
      .from("publications")
      .insert({
        workspace_id: ws,
        content_variant_id: variant!.id,
        social_account_id: account!.id,
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !publication) throw new Error(`Failed to create draft publication fixture: ${error?.message}`);
    return publication.id;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Analytics Tenant A",
      p_slug: `analytics-a-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { error: viewerError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (viewerError) throw new Error(`Failed to add viewer to workspace: ${viewerError.message}`);

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Analytics Tenant B",
      p_slug: `analytics-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    publicationId = await createDraftPublication(workspaceId, editor.client);
    otherPublicationId = await createDraftPublication(otherWorkspaceId, outsider.client);
  });

  afterAll(async () => {
    if (createdSnapshotIds.length > 0) {
      await admin.from("publication_metric_snapshots").delete().in("id", createdSnapshotIds);
    }
    if (createdScoreIds.length > 0) {
      await admin.from("content_performance_scores").delete().in("id", createdScoreIds);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("publication_metric_snapshots", () => {
    let snapshotId: string;

    it("allows a workspace editor to insert a snapshot", async () => {
      const { data, error } = await editor.client
        .from("publication_metric_snapshots")
        .insert({
          workspace_id: workspaceId,
          publication_id: publicationId,
          impressions: 100,
          metric_states: IMPRESSIONS_ONLY_METRIC_STATES,
          captured_at_provenance: "marqos_fallback",
        })
        .select()
        .single();
      expect(error).toBeNull();
      snapshotId = data!.id;
      createdSnapshotIds.push(snapshotId);
    });

    it("denies a viewer from inserting a snapshot", async () => {
      const { data, error } = await viewer.client
        .from("publication_metric_snapshots")
        .insert({
          workspace_id: workspaceId,
          publication_id: publicationId,
          impressions: 1,
          metric_states: IMPRESSIONS_ONLY_METRIC_STATES,
          captured_at_provenance: "marqos_fallback",
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows a workspace member (viewer included) to SELECT snapshots", async () => {
      const { data, error } = await viewer.client
        .from("publication_metric_snapshots")
        .select("*")
        .eq("id", snapshotId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(snapshotId);
    });

    it("hides snapshots from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("publication_metric_snapshots")
        .select("*")
        .eq("id", snapshotId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("rejects a cross-workspace publication_id via the composite tenant FK", async () => {
      const { data, error } = await editor.client
        .from("publication_metric_snapshots")
        .insert({
          workspace_id: workspaceId,
          publication_id: otherPublicationId,
          impressions: 1,
          metric_states: IMPRESSIONS_ONLY_METRIC_STATES,
          captured_at_provenance: "marqos_fallback",
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("has no UPDATE grant/policy: not even an editor can modify a snapshot", async () => {
      const { error } = await editor.client
        .from("publication_metric_snapshots")
        .update({ impressions: 999999 } as never)
        .eq("id", snapshotId)
        .select();
      expect(error).not.toBeNull();
    });

    it("has no DELETE grant/policy: not even an editor can delete a snapshot", async () => {
      const { error } = await editor.client.from("publication_metric_snapshots").delete().eq("id", snapshotId).select();
      expect(error).not.toBeNull();

      const { data: stillThere } = await admin.from("publication_metric_snapshots").select("id").eq("id", snapshotId).single();
      expect(stillThere?.id).toBe(snapshotId);
    });

    it("outsider cannot read or write into workspaceId's snapshots at all", async () => {
      const { data: readAttempt } = await outsider.client
        .from("publication_metric_snapshots")
        .select("*")
        .eq("id", snapshotId)
        .maybeSingle();
      expect(readAttempt).toBeNull();

      const { data: writeAttempt, error: writeError } = await outsider.client
        .from("publication_metric_snapshots")
        .insert({
          workspace_id: workspaceId,
          publication_id: publicationId,
          impressions: 1,
          metric_states: IMPRESSIONS_ONLY_METRIC_STATES,
          captured_at_provenance: "marqos_fallback",
        })
        .select();
      expect(writeAttempt).toBeNull();
      expect(writeError).not.toBeNull();
    });
  });

  describe("content_performance_scores", () => {
    let scoreId: string;

    it("allows a workspace editor to insert a publication-scoped score", async () => {
      const { data, error } = await editor.client
        .from("content_performance_scores")
        .insert({
          workspace_id: workspaceId,
          score_scope: "publication",
          publication_id: publicationId,
          score_type: "engagement_rate",
          score: 0.05,
          calculation_version: "v1",
        })
        .select()
        .single();
      expect(error).toBeNull();
      scoreId = data!.id;
      createdScoreIds.push(scoreId);
    });

    it("denies a viewer from inserting a score", async () => {
      const { data, error } = await viewer.client
        .from("content_performance_scores")
        .insert({
          workspace_id: workspaceId,
          score_scope: "publication",
          publication_id: publicationId,
          score_type: "engagement_rate",
          score: 0.05,
          calculation_version: "v1",
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows a workspace member (viewer included) to SELECT scores", async () => {
      const { data, error } = await viewer.client.from("content_performance_scores").select("*").eq("id", scoreId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(scoreId);
    });

    it("hides scores from a non-member", async () => {
      const { data, error } = await outsider.client.from("content_performance_scores").select("*").eq("id", scoreId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("has no UPDATE grant/policy: not even an editor can modify a score", async () => {
      const { error } = await editor.client
        .from("content_performance_scores")
        .update({ score: 999 } as never)
        .eq("id", scoreId)
        .select();
      expect(error).not.toBeNull();
    });

    it("has no DELETE grant/policy: not even an editor can delete a score", async () => {
      const { error } = await editor.client.from("content_performance_scores").delete().eq("id", scoreId).select();
      expect(error).not.toBeNull();

      const { data: stillThere } = await admin.from("content_performance_scores").select("id").eq("id", scoreId).single();
      expect(stillThere?.id).toBe(scoreId);
    });

    describe("exactly-one-of score_scope CHECK constraint", () => {
      it("rejects score_scope='publication' with content_id also set", async () => {
        const { data, error } = await admin
          .from("content_performance_scores")
          .insert({
            workspace_id: workspaceId,
            score_scope: "publication",
            publication_id: publicationId,
            content_id: crypto.randomUUID(),
            score_type: "engagement_rate",
            score: 0.05,
            calculation_version: "v1",
          } as never)
          .select();
        expect(data).toBeNull();
        expect(error).not.toBeNull();
      });

      it("rejects score_scope='publication' with neither publication_id nor content_id set", async () => {
        const { data, error } = await admin
          .from("content_performance_scores")
          .insert({
            workspace_id: workspaceId,
            score_scope: "publication",
            score_type: "engagement_rate",
            score: 0.05,
            calculation_version: "v1",
          })
          .select();
        expect(data).toBeNull();
        expect(error).not.toBeNull();
      });

      it("rejects score_scope='content' with publication_id set instead of content_id", async () => {
        const { data, error } = await admin
          .from("content_performance_scores")
          .insert({
            workspace_id: workspaceId,
            score_scope: "content",
            publication_id: publicationId,
            score_type: "engagement_rate",
            score: 0.05,
            calculation_version: "v1",
          } as never)
          .select();
        expect(data).toBeNull();
        expect(error).not.toBeNull();
      });
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping analytics-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
