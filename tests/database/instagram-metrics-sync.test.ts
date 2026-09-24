import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { InstagramProviderAdapter } from "@/lib/social/instagram-adapter";
import { MockProviderAdapter } from "@/lib/social/provider";
import { REAL_CREDENTIAL_METADATA_KEY, REAL_CREDENTIAL_METADATA_VALUE, resolveProviderAdapter } from "@/lib/social/registry";
import { recordPublicationMetricSnapshot } from "@/server/services/analytics";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * MVP-5.23 — proves the backend pipeline (REAL INSTAGRAM ACCOUNT -> ADAPTER
 * -> NORMALIZER -> PERSISTENCE) end to end, calling the REAL, unmodified
 * recordPublicationMetricSnapshot() (src/server/services/analytics.ts) —
 * no code change was needed there: the pipeline has been provider-agnostic
 * since MVP-5.10E/5.19-5.21.
 *
 * Content-linkage decision (MVP-5.23 CTO checkpoint, Phase 2/4): the
 * current lifecycle trigger (enforce_publication_lifecycle_transitions)
 * makes it structurally impossible for any publication to reach
 * status='published' with a real external_publication_id today — that
 * requires InstagramProviderAdapter.publish() to succeed, and it
 * deliberately throws (MVP-5.19: real publishing was never verified).
 * Resolving that is deferred to a follow-up milestone. This suite seeds a
 * publication directly at 'published' with a real (MVP-5.17 evidence)
 * external_publication_id via the service-role client — exactly the same
 * fixture-seeding convention analytics-service.test.ts's own
 * insertPublishedPublication already uses to reach 'published' for
 * testing — so it proves the PERSISTENCE segment, not the linkage
 * mechanism (explicitly out of scope this milestone).
 *
 * All Instagram HTTP is mocked with the real MVP-5.17 Feed/Reel Insights
 * evidence shapes already used in tests/unit/instagram-normalizer.test.ts
 * and tests/unit/provider-registry.test.ts — no real Instagram account or
 * token is used in this suite.
 */
describe.skipIf(!hasLocalSupabase)("Instagram metrics sync — real pipeline, mocked HTTP", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let instagramAccountId: string;

  const vaultSecretIds: string[] = [];
  const publicationIds: string[] = [];
  const snapshotIds: string[] = [];

  const realFetch = globalThis.fetch.bind(globalThis);

  // MVP-5.17 real Feed (CAROUSEL_ALBUM) Insights response — identical
  // fixture already used in tests/unit/instagram-normalizer.test.ts and
  // tests/unit/provider-registry.test.ts.
  const REAL_FEED_INSIGHTS_PAYLOAD = {
    data: [
      { name: "reach", period: "lifetime", values: [{ value: 384 }] },
      { name: "likes", period: "lifetime", values: [{ value: 7 }] },
      { name: "comments", period: "lifetime", values: [{ value: 0 }] },
      { name: "shares", period: "lifetime", values: [{ value: 4 }] },
      { name: "saved", period: "lifetime", values: [{ value: 0 }] },
      { name: "views", period: "lifetime", values: [{ value: 626 }] },
    ],
  };

  // Same shape, plus a synthetic paging block carrying a live-token-shaped
  // URL — Instagram's real /me/media response embeds one this way (MVP-5.17
  // finding). Insights responses have never been observed to include one
  // for real, but Phase 3's security requirement is to prove the blanket
  // redaction net (which redacts by pattern, not by known field name) still
  // catches it wherever it appears, all the way through to the persisted
  // row — not merely at the adapter unit-test level.
  const PAYLOAD_WITH_EMBEDDED_TOKEN = {
    ...REAL_FEED_INSIGHTS_PAYLOAD,
    paging: { next: "https://graph.instagram.com/me/media?after=abc&access_token=LIVE_TOKEN_MUST_NEVER_PERSIST" },
  };

  function mockInsightsResponse(payload: Record<string, unknown>, status = 200) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("graph.instagram.com") && url.includes("/insights")) {
        return new Response(JSON.stringify(payload), { status });
      }
      return realFetch(url, init);
    });
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

  /**
   * Seeds a publication directly at 'published' with a real (MVP-5.17
   * evidence) Instagram media id — via the service-role client, mirroring
   * analytics-service.test.ts's insertPublishedPublication. This is a test
   * fixture only: production has no equivalent path today (the confirmed
   * MVP-5.23 audit finding — see module header comment).
   */
  async function seedPublishedInstagramPublication(externalMediaId: string, accountId = instagramAccountId): Promise<string> {
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
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert publication fixture: ${error?.message}`);
    publicationIds.push(data.id);

    await admin.from("publications").update({ status: "publishing" }).eq("id", data.id);
    const { error: publishedError } = await admin
      .from("publications")
      .update({ status: "published", published_at: new Date().toISOString(), external_publication_id: externalMediaId })
      .eq("id", data.id);
    if (publishedError) throw new Error(`Failed to drive fixture to published: ${publishedError.message}`);

    return data.id;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Instagram Sync Tenant",
      p_slug: `ig-sync-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Instagram Sync Tenant B",
      p_slug: `ig-sync-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const { data: secretId, error: vaultError } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: "fake-long-lived-token-for-testing",
      p_description: "instagram-metrics-sync-test",
    });
    if (vaultError || !secretId) throw new Error(`Failed to create test vault secret: ${vaultError?.message}`);
    vaultSecretIds.push(secretId as string);

    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "38281000000004700",
        account_name: "Instagram 38281000000004700",
        vault_secret_id: secretId,
        status: "connected",
        metadata: { [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE },
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create real-tagged social_account fixture: ${accountError?.message}`);
    instagramAccountId = account.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  it("A. a real Instagram social account routes to InstagramProviderAdapter", () => {
    const adapter = resolveProviderAdapter({ platform: "instagram", metadata: { [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE } });
    expect(adapter).toBeInstanceOf(InstagramProviderAdapter);
  });

  it("B. a mock (non-real-tagged) Instagram social account still routes to MockProviderAdapter", () => {
    const adapter = resolveProviderAdapter({ platform: "instagram", metadata: {} });
    expect(adapter).toBeInstanceOf(MockProviderAdapter);
  });

  it("C-N. recordPublicationMetricSnapshot() persists real-evidence-shaped Instagram metrics via the unmodified production pipeline", async () => {
    vi.stubGlobal("fetch", mockInsightsResponse(REAL_FEED_INSIGHTS_PAYLOAD));
    const publicationId = await seedPublishedInstagramPublication("18100000000033712");

    // C: credential retrieved through the existing Vault mechanism is
    // implicit here — recordPublicationMetricSnapshot throws if Vault
    // resolution fails, and the call below succeeds, proving it worked.
    const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId);
    snapshotIds.push(snapshot.id);

    expect(snapshot.workspace_id).toBe(workspaceId);
    expect(snapshot.publication_id).toBe(publicationId);

    // G-L: canonical metrics.
    expect(snapshot.reach).toBe(384);
    expect(snapshot.views).toBe(626);
    expect(snapshot.likes).toBe(7);
    expect(snapshot.comments).toBe(0); // J: explicit zero, not null/omitted
    expect(snapshot.shares).toBe(4);
    expect(snapshot.saves).toBe(0); // L: Instagram's "saved" -> Marqos "saves"

    // M, N: impressions/clicks remain unsupported, never fabricated.
    expect(snapshot.impressions).toBeNull();
    expect(snapshot.clicks).toBeNull();
    expect(snapshot.metric_states.impressions.state).toBe("unsupported");
    expect(snapshot.metric_states.clicks.state).toBe("unsupported");
    expect(snapshot.metric_states.comments.state).toBe("reported");
    expect(snapshot.metric_states.saves.state).toBe("reported");

    // Captured-at provenance: Instagram Insights never carries an
    // observation timestamp (MVP-5.17/5.18) -> always marqos_fallback.
    expect(snapshot.captured_at_provenance).toBe("marqos_fallback");
    expect(snapshot.captured_at).toBeTruthy();

    // Raw provider_metrics persisted, matching the real evidence shape.
    expect(snapshot.provider_metrics).toMatchObject(REAL_FEED_INSIGHTS_PAYLOAD);
  });

  it("Q. a raw payload containing an embedded access_token (paging.next shape) never reaches persisted provider_metrics", async () => {
    vi.stubGlobal("fetch", mockInsightsResponse(PAYLOAD_WITH_EMBEDDED_TOKEN));
    const publicationId = await seedPublishedInstagramPublication("18100000000516633");

    const snapshot = await recordPublicationMetricSnapshot(workspaceId, publicationId);
    snapshotIds.push(snapshot.id);

    const serializedRaw = JSON.stringify(snapshot.provider_metrics);
    expect(serializedRaw).not.toContain("LIVE_TOKEN_MUST_NEVER_PERSIST");
    expect(serializedRaw).not.toMatch(/access_token=(?!\[REDACTED\])[^&"]+/);
    // The redacted marker itself IS expected to be present, proving the
    // adapter's redaction net ran (not that the field was silently dropped).
    expect(serializedRaw).toContain("[REDACTED]");
  });

  it("O. repeated sync appends new historical snapshots (append-only), never corrupting or blocking on the prior one", async () => {
    vi.stubGlobal("fetch", mockInsightsResponse(REAL_FEED_INSIGHTS_PAYLOAD));
    const publicationId = await seedPublishedInstagramPublication("18100000000033712-repeat");

    const first = await recordPublicationMetricSnapshot(workspaceId, publicationId);
    snapshotIds.push(first.id);
    const second = await recordPublicationMetricSnapshot(workspaceId, publicationId);
    snapshotIds.push(second.id);

    expect(second.id).not.toBe(first.id);

    const { count } = await admin
      .from("publication_metric_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("publication_id", publicationId);
    expect(count).toBe(2);
  });

  it("R. a provider/API failure does not create a fabricated analytics observation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("graph.instagram.com") && url.includes("/insights")) {
          return new Response(JSON.stringify({ error: { message: "Invalid access token", type: "IGApiException", code: 190 } }), { status: 400 });
        }
        return realFetch(url, init);
      }),
    );
    const publicationId = await seedPublishedInstagramPublication("18100000000033712-fail");

    await expect(recordPublicationMetricSnapshot(workspaceId, publicationId)).rejects.toThrow();

    const { count } = await admin
      .from("publication_metric_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("publication_id", publicationId);
    expect(count).toBe(0);
  });

  it("P. workspace B cannot record a metric snapshot for workspace A's Instagram publication", async () => {
    vi.stubGlobal("fetch", mockInsightsResponse(REAL_FEED_INSIGHTS_PAYLOAD));
    const publicationId = await seedPublishedInstagramPublication("18100000000033712-isolation");

    const {
      data: { session: outsiderSession },
    } = await outsider.client.auth.getSession();
    if (!outsiderSession) throw new Error("Outsider test user has no session");
    setTestAccessToken(outsiderSession.access_token);

    try {
      await expect(recordPublicationMetricSnapshot(otherWorkspaceId, publicationId)).rejects.toThrow();
    } finally {
      const {
        data: { session: editorSession },
      } = await editor.client.auth.getSession();
      setTestAccessToken(editorSession?.access_token ?? null);
    }

    const { count } = await admin
      .from("publication_metric_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("publication_id", publicationId);
    expect(count).toBe(0);
  });
});
