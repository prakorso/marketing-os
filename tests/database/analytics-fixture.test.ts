import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FixtureProviderAdapter } from "@/lib/analytics/fixtures/fixture-provider-adapter";
import { recordPublicationMetricSnapshot, syncWorkspacePublicationMetrics } from "@/server/services/analytics";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * MVP-5.10E: production-shaped fixture-scenario and freshness/timestamp/
 * persistence coverage for the Analytics Normalizer pipeline (Decisions
 * #32, #33, #37, #38, #39, #40, #41). Every scenario here flows through
 * the real recordPublicationMetricSnapshot/syncWorkspacePublicationMetrics
 * — a FixtureProviderAdapter is injected via `deps.adapter` (mirroring
 * src/server/services/ai.ts's existing test-only dependency-injection
 * seam), never a direct table insert (Decision #36).
 */
describe.skipIf(!hasLocalSupabase)("Analytics fixture scenarios — Normalizer + freshness integration", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let accountId: string;

  const vaultSecretIds: string[] = [];
  const publicationIds: string[] = [];
  const snapshotIds: string[] = [];

  async function createVaultSecret(secret: string): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: secret,
      p_description: "analytics-fixture-test",
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
      p_name: "Analytics Fixture Tenant",
      p_slug: `analytics-fixture-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const secretId = await createVaultSecret("dev-only-fixture-secret-analytics-fixture");
    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        // MVP-5.20: "tiktok", not "instagram" — this suite tests the
        // generic FixtureProviderAdapter/mock-normalizer pipeline.
        // "instagram" now dispatches to the real, registered Instagram
        // normalizer; any still-mock platform is equally valid here.
        platform: "tiktok",
        external_account_id: "analytics-fixture-account",
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

  describe("fixture scenarios flow through the real normalizer + service path", () => {
    it("STABLE: repeated calls report the same metric values", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("stable");
      const first = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      const second = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(first.id, second.id);
      expect(first.impressions).toBe(second.impressions);
      expect(first.metric_states.impressions.state).toBe("reported");
    });

    it("GROWTH: successive calls report increasing impressions", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("growth");
      const first = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      const second = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(first.id, second.id);
      expect(second.impressions!).toBeGreaterThan(first.impressions!);
    });

    it("DECLINE: successive calls report decreasing impressions, never negative", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("decline");
      const first = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      const second = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(first.id, second.id);
      expect(second.impressions!).toBeLessThanOrEqual(first.impressions!);
      expect(second.impressions!).toBeGreaterThanOrEqual(0);
    });

    it("ZERO ACTIVITY: reported zero is persisted as a real zero, not null and not unavailable", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("zero_activity");
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);
      expect(snapshot.impressions).toBe(0);
      expect(snapshot.metric_states.impressions.state).toBe("reported");
    });

    it("MISSING/UNAVAILABLE METRIC: an unavailable metric persists as null with state 'unavailable'", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("missing_metric", { metric: "reach" });
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);
      expect(snapshot.reach).toBeNull();
      expect(snapshot.metric_states.reach.state).toBe("unavailable");
      expect(snapshot.metric_states.impressions.state).toBe("reported");
    });

    it("UNSUPPORTED METRIC: an unsupported metric persists as null with state 'unsupported'", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("unsupported_metric", { metric: "saves" });
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);
      expect(snapshot.saves).toBeNull();
      expect(snapshot.metric_states.saves.state).toBe("unsupported");
    });

    it("TIMESTAMP PRESENT: captured_at_provenance is 'provider' when the fixture supplies an observation time", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("timestamp_present");
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);
      expect(snapshot.captured_at_provenance).toBe("provider");
    });

    it("TIMESTAMP ABSENT/FALLBACK: captured_at_provenance is 'marqos_fallback' when the fixture omits an observation time", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("timestamp_fallback");
      const before = new Date();
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);
      expect(snapshot.captured_at_provenance).toBe("marqos_fallback");
      expect(new Date(snapshot.captured_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("PROVIDER FAILURE: no snapshot row is created", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("provider_failure");
      await expect(recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter })).rejects.toThrow(/forced failure/);
      const { data: rows } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", publicationId);
      expect(rows).toEqual([]);
    });

    it("MALFORMED RESPONSE: rejected by the normalizer, no snapshot row is created", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("malformed");
      await expect(recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter })).rejects.toThrow();
      const { data: rows } = await admin.from("publication_metric_snapshots").select("id").eq("publication_id", publicationId);
      expect(rows).toEqual([]);
    });
  });

  describe("persistence contract", () => {
    it("stores the raw provider payload, normalized columns, metric state, captured_at, and provenance together", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("stable");
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);

      expect(snapshot.provider_metrics).toMatchObject({ fixture: true, platform: "tiktok", scenario: "stable" });
      expect(typeof snapshot.impressions).toBe("number");
      expect(snapshot.metric_states.impressions.state).toBe("reported");
      expect(snapshot.captured_at).toBeTruthy();
      expect(["provider", "marqos_fallback"]).toContain(snapshot.captured_at_provenance);
    });

    it("provisional score remains the unchanged engagement_rate passthrough for fixture-sourced snapshots too", async () => {
      const publicationId = await insertPublishedPublication();
      const adapter = new FixtureProviderAdapter("stable");
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);
      expect(snapshot.engagement_rate).not.toBeNull();
    });
  });

  describe("freshness (Decision #40)", () => {
    it("a successful direct recording advances social_accounts.last_synced_at", async () => {
      const secretId = await createVaultSecret("dev-only-fixture-secret-freshness-1");
      const { data: freshAccount } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "analytics-fixture-freshness-1",
          account_name: "Freshness Account",
          vault_secret_id: secretId,
          status: "connected",
        })
        .select()
        .single();
      const freshAccountId = freshAccount!.id;

      const { data: before } = await admin.from("social_accounts").select("last_synced_at").eq("id", freshAccountId).single();
      expect(before?.last_synced_at).toBeNull();

      const publicationId = await insertPublishedPublication(freshAccountId);
      const adapter = new FixtureProviderAdapter("stable");
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter });
      snapshotIds.push(snapshot.id);

      const { data: after } = await admin.from("social_accounts").select("last_synced_at").eq("id", freshAccountId).single();
      expect(after?.last_synced_at).not.toBeNull();
      expect(after?.last_synced_at).toBe(snapshot.captured_at);
    });

    it("a failed collection does not advance freshness", async () => {
      const secretId = await createVaultSecret("dev-only-fixture-secret-freshness-2");
      const { data: failAccount } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "analytics-fixture-freshness-2",
          account_name: "Freshness Fail Account",
          vault_secret_id: secretId,
          status: "connected",
        })
        .select()
        .single();
      const failAccountId = failAccount!.id;

      const publicationId = await insertPublishedPublication(failAccountId);
      const adapter = new FixtureProviderAdapter("provider_failure");
      await expect(recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter })).rejects.toThrow();

      const { data: after } = await admin.from("social_accounts").select("last_synced_at").eq("id", failAccountId).single();
      expect(after?.last_synced_at).toBeNull();
    });

    it("an older successful observation cannot regress an already-later last_synced_at", async () => {
      const secretId = await createVaultSecret("dev-only-fixture-secret-freshness-3");
      const { data: account3 } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "analytics-fixture-freshness-3",
          account_name: "Freshness Monotonic Account",
          vault_secret_id: secretId,
          status: "connected",
        })
        .select()
        .single();
      const account3Id = account3!.id;

      const publicationId = await insertPublishedPublication(account3Id);

      const laterAdapter = new FixtureProviderAdapter("timestamp_present");
      const laterSnapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter: laterAdapter });
      snapshotIds.push(laterSnapshot.id);

      const { data: afterLater } = await admin.from("social_accounts").select("last_synced_at").eq("id", account3Id).single();
      const laterTimestamp = afterLater!.last_synced_at!;

      // Force-advance last_synced_at further into the future to simulate an
      // already-later value, then record an observation with an earlier
      // provider timestamp and confirm it does not regress the column.
      const future = new Date(Date.now() + 60_000).toISOString();
      await admin.from("social_accounts").update({ last_synced_at: future }).eq("id", account3Id);

      const earlierAdapter = new FixtureProviderAdapter("timestamp_present");
      const earlierSnapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId, { adapter: earlierAdapter });
      snapshotIds.push(earlierSnapshot.id);

      const { data: afterEarlier } = await admin.from("social_accounts").select("last_synced_at").eq("id", account3Id).single();
      expect(new Date(afterEarlier!.last_synced_at!).getTime()).toBe(new Date(future).getTime());
      expect(new Date(afterEarlier!.last_synced_at!).getTime()).toBeGreaterThan(new Date(laterTimestamp).getTime());
    });

    it("batch sync (syncWorkspacePublicationMetrics) advances freshness through the same write path as a direct call", async () => {
      const secretId = await createVaultSecret("dev-only-fixture-secret-freshness-4");
      const { data: account4 } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "analytics-fixture-freshness-4",
          account_name: "Freshness Batch Account",
          vault_secret_id: secretId,
          status: "connected",
        })
        .select()
        .single();
      const account4Id = account4!.id;

      await insertPublishedPublication(account4Id);

      const { data: before } = await admin.from("social_accounts").select("last_synced_at").eq("id", account4Id).single();
      expect(before?.last_synced_at).toBeNull();

      const adapter = new FixtureProviderAdapter("stable");
      const summary = await syncWorkspacePublicationMetrics(workspaceId, { adapter });
      snapshotIds.push(...summary.snapshotIds.filter((id) => !snapshotIds.includes(id)));

      const { data: after } = await admin.from("social_accounts").select("last_synced_at").eq("id", account4Id).single();
      expect(after?.last_synced_at).not.toBeNull();
    });
  });
});
