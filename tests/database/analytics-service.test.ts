import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL } from "@/lib/social/provider";
import { calculatePublicationPerformanceScore, recordPublicationMetricSnapshot } from "@/server/services/analytics";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Service-level tests for MVP-3.1 Analytics Foundation
 * (src/server/services/analytics.ts), following the existing
 * publications-calendar-query.test.ts / notifications-service.test.ts
 * convention of calling the REAL exported service functions —
 * authenticated via a real signed-in test user's bearer token
 * (setTestAccessToken) — against the local Supabase stack, with a real
 * Vault secret (mirroring tests/integration/publication-execution.test.ts)
 * so credential resolution is exercised for real, not mocked away.
 *
 * Covers: recordPublicationMetricSnapshot (mock metrics persisted,
 * not-published rejection, provider failure propagation without a
 * partial/dangling row, append-only behavior across repeated calls) and
 * calculatePublicationPerformanceScore (publication-scoped only, latest-
 * snapshot selection, no-snapshot rejection, append-only recalculation).
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("Analytics service — recordPublicationMetricSnapshot / calculatePublicationPerformanceScore", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  // Untyped service-role client for the Vault wrapper RPCs, mirroring
  // tests/integration/publication-execution.test.ts's vaultAdmin.
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let accountId: string;

  const vaultSecretIds: string[] = [];
  const publicationIds: string[] = [];
  const snapshotIds: string[] = [];
  const scoreIds: string[] = [];

  async function createVaultSecret(secret: string): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: secret,
      p_description: "analytics-service-test",
    });
    if (error || !data) throw new Error(`Failed to create test vault secret: ${error?.message}`);
    vaultSecretIds.push(data as string);
    return data as string;
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

  /** Inserts a publication and drives it through the real lifecycle to 'published', with an external_publication_id set. */
  async function insertPublishedPublication(socialAccountId = accountId): Promise<string> {
    const { variantId } = await createApprovedVariant();
    const { data, error } = await editor.client
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: socialAccountId,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert publication fixture: ${error?.message}`);
    publicationIds.push(data.id);

    await editor.client.from("publications").update({ status: "publishing" }).eq("id", data.id);
    const { error: publishedError } = await editor.client
      .from("publications")
      .update({ status: "published", published_at: new Date().toISOString(), external_publication_id: `test-ext-${data.id}` })
      .eq("id", data.id);
    if (publishedError) throw new Error(`Failed to drive fixture to published: ${publishedError.message}`);

    return data.id;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Analytics Service Tenant",
      p_slug: `analytics-service-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const secretId = await createVaultSecret("dev-only-fixture-secret-analytics");
    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        // MVP-5.20: "tiktok", not "instagram" — this suite exercises the
        // generic MockProviderAdapter/mock-normalizer pipeline (including
        // `impressions`, which the real, now-registered Instagram
        // normalizer deliberately does not support, MVP-5.18). "instagram"
        // now dispatches to the real normalizer; any still-mock platform
        // works identically for what this suite actually tests.
        platform: "tiktok",
        external_account_id: "analytics-service-fixture-account",
        account_name: "Fixture Account",
        vault_secret_id: secretId,
        status: "connected",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);
    accountId = account.id;
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
    for (const secretId of vaultSecretIds) {
      await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: secretId });
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId].filter(Boolean),
      userIds: [editor?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("recordPublicationMetricSnapshot", () => {
    it("records a snapshot with the mock adapter's normalized metrics and raw provider_metrics", async () => {
      const publicationId = await insertPublishedPublication();
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId);
      snapshotIds.push(snapshot.id);

      expect(snapshot.workspace_id).toBe(workspaceId);
      expect(snapshot.publication_id).toBe(publicationId);
      expect(snapshot.impressions).toBe(1000);
      expect(snapshot.reach).toBe(800);
      expect(snapshot.likes).toBe(50);
      expect(snapshot.engagement_rate).toBe(0.05);
      expect(snapshot.provider_metrics).toMatchObject({ mock: true, platform: "tiktok" });
    });

    it("rejects recording a snapshot for a publication that is not published", async () => {
      const { variantId } = await createApprovedVariant();
      const { data } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      publicationIds.push(data!.id);

      await expect(recordPublicationMetricSnapshot(workspaceId, data!.id)).rejects.toThrow(/not published/);
    });

    it("propagates a provider metrics failure as a thrown error without persisting a snapshot", async () => {
      const failSecretId = await createVaultSecret(MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL);
      const { data: failAccount } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "analytics-service-fail-account",
          account_name: "Fail Account",
          vault_secret_id: failSecretId,
          status: "connected",
        })
        .select()
        .single();

      const publicationId = await insertPublishedPublication(failAccount!.id);
      await expect(recordPublicationMetricSnapshot(workspaceId, publicationId)).rejects.toThrow(/forced failure/);

      const { data: rows } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", publicationId);
      expect(rows).toEqual([]);
    });

    it("does not overwrite a prior snapshot — repeated calls append new rows", async () => {
      const publicationId = await insertPublishedPublication();
      const first = await recordPublicationMetricSnapshot(workspaceId, publicationId);
      snapshotIds.push(first.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await recordPublicationMetricSnapshot(workspaceId, publicationId);
      snapshotIds.push(second.id);

      expect(second.id).not.toBe(first.id);
      const { data: all } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", publicationId);
      expect(all?.length).toBe(2);
    });
  });

  describe("calculatePublicationPerformanceScore", () => {
    it("creates a publication-scoped score carrying through the latest snapshot's engagement_rate unchanged", async () => {
      const publicationId = await insertPublishedPublication();
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId);
      snapshotIds.push(snapshot.id);

      const score = await calculatePublicationPerformanceScore(workspaceId, publicationId);
      scoreIds.push(score.id);

      expect(score.workspace_id).toBe(workspaceId);
      expect(score.score_scope).toBe("publication");
      expect(score.publication_id).toBe(publicationId);
      expect(score.content_id).toBeNull();
      expect(score.score_type).toBe("engagement_rate");
      expect(score.score).toBe(snapshot.engagement_rate);
      expect(score.calculation_version).toBe("v1");
      expect(score.inputs).toEqual({ publication_metric_snapshot_id: snapshot.id });
    });

    it("scores against the MOST RECENT snapshot when multiple exist", async () => {
      const publicationId = await insertPublishedPublication();
      const first = await recordPublicationMetricSnapshot(workspaceId, publicationId);
      snapshotIds.push(first.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await recordPublicationMetricSnapshot(workspaceId, publicationId);
      snapshotIds.push(second.id);

      const score = await calculatePublicationPerformanceScore(workspaceId, publicationId);
      scoreIds.push(score.id);
      expect((score.inputs as { publication_metric_snapshot_id: string }).publication_metric_snapshot_id).toBe(second.id);
    });

    it("rejects calculating a score when no snapshot exists yet", async () => {
      const publicationId = await insertPublishedPublication();
      await expect(calculatePublicationPerformanceScore(workspaceId, publicationId)).rejects.toThrow(/no metric snapshot/i);
    });

    it("recalculating appends a new score row rather than updating the prior one", async () => {
      const publicationId = await insertPublishedPublication();
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId);
      snapshotIds.push(snapshot.id);

      const first = await calculatePublicationPerformanceScore(workspaceId, publicationId);
      scoreIds.push(first.id);
      const second = await calculatePublicationPerformanceScore(workspaceId, publicationId);
      scoreIds.push(second.id);

      expect(second.id).not.toBe(first.id);
      const { data: all } = await admin.from("content_performance_scores").select("id").eq("publication_id", publicationId);
      expect(all?.length).toBe(2);
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping analytics-service.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
