import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL } from "@/lib/social/provider";
import { syncWorkspacePublicationMetrics } from "@/server/services/analytics";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Service-level tests for MVP-3.2's syncWorkspacePublicationMetrics
 * (src/server/services/analytics.ts), following the existing
 * analytics-service.test.ts / publications-calendar-query.test.ts
 * convention of calling the REAL exported service function, authenticated
 * via a real signed-in test user's bearer token (setTestAccessToken), with
 * real Vault secrets (mirroring tests/integration/publication-execution
 * and analytics-service.test.ts), against the local Supabase stack.
 *
 * Covers: multi-publication batch processing, workspace tenant isolation
 * (a second workspace's publications are never touched even though both
 * exist concurrently), per-publication failure isolation (one forced
 * provider failure does not abort the rest of the batch), exclusion of
 * non-published/no-external-id publications, repeated-call historical
 * accumulation (no dedup — this is correct, not a bug), authorization
 * (viewer denied), and that the summary never carries credential material.
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("syncWorkspacePublicationMetrics — workspace-scoped batch orchestration", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let accountId: string;

  const vaultSecretIds: string[] = [];
  const publicationIds: string[] = [];
  const otherPublicationIds: string[] = [];
  const snapshotIds: string[] = [];
  const scoreIds: string[] = [];

  async function createVaultSecret(secret: string): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: secret,
      p_description: "analytics-sync-test",
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

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Analytics Sync Tenant",
      p_slug: `analytics-sync-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { error: viewerError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (viewerError) throw new Error(`Failed to add viewer to workspace: ${viewerError.message}`);

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Analytics Sync Other Tenant",
      p_slug: `analytics-sync-other-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const secretId = await createVaultSecret("dev-only-fixture-secret-analytics-sync");
    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        // MVP-5.20: "tiktok", not "instagram" — this suite exercises the
        // generic mock-adapter/mock-normalizer sync pipeline. "instagram"
        // now dispatches to the real, registered Instagram normalizer;
        // any still-mock platform is equally valid for what's tested here.
        platform: "tiktok",
        external_account_id: "analytics-sync-fixture-account",
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

  it("processes multiple published publications, recording a snapshot + score for each", async () => {
    const idA = await insertPublishedPublication(workspaceId, accountId);
    const idB = await insertPublishedPublication(workspaceId, accountId);
    publicationIds.push(idA, idB);

    const summary = await syncWorkspacePublicationMetrics(workspaceId);

    expect(summary.publicationIds).toEqual(expect.arrayContaining([idA, idB]));
    expect(summary.succeeded).toBeGreaterThanOrEqual(2);
    expect(summary.failed).toBe(0);
    expect(summary.snapshotIds.length).toBe(summary.publicationIds.length);
    expect(summary.scoreIds.length).toBe(summary.publicationIds.length);
    snapshotIds.push(...summary.snapshotIds);
    scoreIds.push(...summary.scoreIds);

    const { data: snapA } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", idA).single();
    expect(summary.snapshotIds).toContain(snapA?.id);
    const { data: scoreA } = await admin.from("content_performance_scores").select("id").eq("publication_id", idA).single();
    expect(summary.scoreIds).toContain(scoreA?.id);
  });

  it("does not process another workspace's publications", async () => {
    const { data: otherAccount } = await outsider.client
      .from("social_accounts")
      .insert({
        workspace_id: otherWorkspaceId,
        // MVP-5.20: "tiktok", not "instagram" — this suite exercises the
        // generic mock-adapter/mock-normalizer sync pipeline. "instagram"
        // now dispatches to the real, registered Instagram normalizer;
        // any still-mock platform is equally valid for what's tested here.
        platform: "tiktok",
        external_account_id: "analytics-sync-other-account",
        account_name: "Other Account",
      })
      .select()
      .single();
    const otherId = await insertPublishedPublication(otherWorkspaceId, otherAccount!.id, outsider.client);
    otherPublicationIds.push(otherId);

    const summary = await syncWorkspacePublicationMetrics(workspaceId);

    expect(summary.publicationIds).not.toContain(otherId);
    snapshotIds.push(...summary.snapshotIds);
    scoreIds.push(...summary.scoreIds);

    const { data: leaked } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", otherId);
    expect(leaked).toEqual([]);
  });

  it("isolates a single publication's forced provider failure without aborting the rest of the batch", async () => {
    const failSecretId = await createVaultSecret(MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL);
    const { data: failAccount } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        // MVP-5.20: "tiktok", not "instagram" — this suite exercises the
        // generic mock-adapter/mock-normalizer sync pipeline. "instagram"
        // now dispatches to the real, registered Instagram normalizer;
        // any still-mock platform is equally valid for what's tested here.
        platform: "tiktok",
        external_account_id: "analytics-sync-fail-account",
        account_name: "Fail Account",
        vault_secret_id: failSecretId,
        status: "connected",
      })
      .select()
      .single();

    const failId = await insertPublishedPublication(workspaceId, failAccount!.id);
    const okId = await insertPublishedPublication(workspaceId, accountId);
    publicationIds.push(failId, okId);

    const summary = await syncWorkspacePublicationMetrics(workspaceId);

    expect(summary.publicationIds).toEqual(expect.arrayContaining([failId, okId]));
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);
    const failure = summary.failures.find((f) => f.publicationId === failId);
    expect(failure).toBeDefined();
    expect(failure!.error).toMatch(/forced failure/);
    snapshotIds.push(...summary.snapshotIds);
    scoreIds.push(...summary.scoreIds);

    const { data: failSnapshots } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", failId);
    expect(failSnapshots).toEqual([]);
    const { data: okSnapshots } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", okId);
    expect(okSnapshots?.length).toBe(1);
  });

  it("skips publications that are not published (or have no external_publication_id)", async () => {
    const { variantId } = await createApprovedVariant(workspaceId);
    const { data: draft } = await editor.client
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: accountId,
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    publicationIds.push(draft!.id);

    const summary = await syncWorkspacePublicationMetrics(workspaceId);

    expect(summary.publicationIds).not.toContain(draft!.id);
  });

  it("repeated calls append new historical rows rather than deduplicating", async () => {
    const id = await insertPublishedPublication(workspaceId, accountId);
    publicationIds.push(id);

    const first = await syncWorkspacePublicationMetrics(workspaceId);
    snapshotIds.push(...first.snapshotIds);
    scoreIds.push(...first.scoreIds);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await syncWorkspacePublicationMetrics(workspaceId);
    snapshotIds.push(...second.snapshotIds);
    scoreIds.push(...second.scoreIds);

    const { data: allSnapshots } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", id);
    const { data: allScores } = await admin.from("content_performance_scores").select("id").eq("publication_id", id);
    expect(allSnapshots?.length).toBeGreaterThanOrEqual(2);
    expect(allScores?.length).toBeGreaterThanOrEqual(2);
  });

  it("denies a viewer from running the sync", async () => {
    const {
      data: { session: viewerSession },
    } = await viewer.client.auth.getSession();
    setTestAccessToken(viewerSession!.access_token);
    try {
      await expect(syncWorkspacePublicationMetrics(workspaceId)).rejects.toThrow(/permission/);
    } finally {
      const {
        data: { session: editorSession },
      } = await editor.client.auth.getSession();
      setTestAccessToken(editorSession!.access_token);
    }
  });

  it("the summary never contains credential values", async () => {
    const id = await insertPublishedPublication(workspaceId, accountId);
    publicationIds.push(id);

    const summary = await syncWorkspacePublicationMetrics(workspaceId);
    snapshotIds.push(...summary.snapshotIds);
    scoreIds.push(...summary.scoreIds);

    const serialized = JSON.stringify(summary);
    expect(serialized.toLowerCase()).not.toContain("vault");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("credential");
    expect(serialized).not.toContain("dev-only-fixture-secret-analytics-sync");
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping analytics-sync.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
