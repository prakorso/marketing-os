import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  MediaContainerCreateResult,
  MediaContainerStatusResult,
  MediaPublishResult,
  RecentMediaResult,
  StagedMediaPublisher,
} from "@/lib/social/provider";
import {
  createAttemptStore,
  runStagedImagePublish,
  type AttemptStore,
  type StagedPublishDeps,
} from "@/server/services/instagram-image-publishing";
import { loadVariantPublishAssets } from "@/server/services/publication-media";
import {
  finalizeWithConfirmedMediaId,
  inspectUnknownPublishOutcome,
  reconcilePublicationLocally,
  resolveUnknownAsNotPublished,
} from "@/server/services/publication-reconciliation";
import { markFailedAsSystem, markPublishedAsSystem } from "@/server/services/publications";
import type { ContentVariant, SocialAccount } from "@/types/database";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.35C-B — IMAGE staged publishing engine against the LOCAL Supabase
 * schema (real triggers/constraints), with a scripted fake provider. No
 * Meta call is possible: the provider is an in-memory fake.
 */

const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-DB-0001";
const FAKE_TOKEN = "IGAAfakeDbTestToken00000000000000001";
const IG_ID = "17849990000000042";

type Script = {
  create?: () => MediaContainerCreateResult;
  status?: () => MediaContainerStatusResult;
  publish?: () => MediaPublishResult;
  recent?: () => RecentMediaResult;
};

function fakeProvider(script: Script = {}) {
  const calls = { create: 0, status: 0, publish: 0, recent: 0, imageUrls: [] as string[] };
  const provider: StagedMediaPublisher = {
    async createMediaContainer(input) {
      calls.create += 1;
      calls.imageUrls.push(input.imageUrl);
      return script.create ? script.create() : { ok: true, containerId: "17900000000000000123" };
    },
    async getMediaContainerStatus() {
      calls.status += 1;
      return script.status ? script.status() : { ok: true, status: "FINISHED" };
    },
    async publishMediaContainer() {
      calls.publish += 1;
      return script.publish ? script.publish() : { ok: true, mediaId: "18000000000000000999" };
    },
    async listRecentMedia() {
      calls.recent += 1;
      return script.recent ? script.recent() : { ok: true, items: [] };
    },
  };
  return { provider, calls };
}

const failure = (outcome?: "rejected" | "unknown") => ({
  ok: false as const,
  ...(outcome ? { outcome } : {}),
  code: outcome === "rejected" ? "OAuthException" : "transport_error",
  message: "fixture",
  httpStatus: outcome === "rejected" ? 400 : null,
  providerCode: null,
  providerSubcode: null,
  fbtraceId: null,
});

describe.skipIf(!hasLocalSupabase)("MVP-5.35C-B IMAGE publishing engine (local DB)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let contentId: string;
  let modelBAccount: SocialAccount;
  let legacyAccount: SocialAccount;
  const vaultIds: string[] = [];

  async function vaultSecret(): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "test" });
    if (error || !data) throw new Error(`vault: ${error?.message}`);
    vaultIds.push(data as string);
    return data as string;
  }

  async function account(externalId: string, metadata: Record<string, unknown>): Promise<SocialAccount> {
    const { data, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: externalId,
        account_name: "fixture",
        status: "connected",
        vault_secret_id: await vaultSecret(),
        metadata,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`account: ${error?.message}`);
    return data;
  }

  async function jpegAsset(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = crypto.randomUUID();
    const { data, error } = await admin
      .from("marqos_assets")
      .insert({
        id,
        workspace_id: workspaceId,
        storage_path: `${workspaceId}/${id}.jpg`,
        file_name: `${id}.jpg`,
        mime_type: "image/jpeg",
        asset_type: "image",
        file_size: 400_000,
        width: 1080,
        height: 1350,
        ...overrides,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`asset: ${error?.message}`);
    return data.id;
  }

  async function variantWith(assetIds: string[], overrides: Record<string, unknown> = {}): Promise<ContentVariant> {
    const { data: version } = await admin
      .from("content_versions")
      .insert({
        content_id: contentId,
        workspace_id: workspaceId,
        version_number: Math.floor(Math.random() * 1_000_000_000) + 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    const { data: variant, error } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "Launch day #marqos", ...overrides })
      .select()
      .single();
    if (error || !variant) throw new Error(`variant: ${error?.message}`);
    await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: contentId,
      content_version_id: version!.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    for (const [index, assetId] of assetIds.entries()) {
      const { error: bindError } = await admin
        .from("marqos_content_variant_assets")
        .insert({ content_variant_id: variant.id, asset_id: assetId, workspace_id: workspaceId, sort_order: index });
      if (bindError) throw new Error(`bind: ${bindError.message}`);
    }
    return variant;
  }

  async function publishingPublication(variant: ContentVariant, socialAccount: SocialAccount) {
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variant.id,
        social_account_id: socialAccount.id,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`publication: ${error?.message}`);
    const moved = await admin.from("publications").update({ status: "publishing" }).eq("id", data.id).select().single();
    if (moved.error) throw new Error(`publishing: ${moved.error.message}`);
    return moved.data!;
  }

  async function publicationRow(id: string) {
    const { data } = await admin.from("publications").select("*").eq("id", id).single();
    return data!;
  }

  async function attemptsFor(id: string) {
    const { data } = await admin.from("publication_attempts").select("*").eq("publication_id", id).order("attempt_number");
    return data ?? [];
  }

  type Harness = {
    deps: StagedPublishDeps;
    calls: ReturnType<typeof fakeProvider>["calls"];
    events: string[];
    logs: string[];
    markFailedCalls: number;
  };

  /** Deps wired to the real schema; `failUpdate`/`failMarkPublished` inject local persistence failures. */
  function harness(
    publicationId: string,
    script: Script = {},
    opts: {
      failUpdate?: (patch: Record<string, unknown>) => boolean;
      failMarkPublished?: boolean;
      clock?: () => number;
      sleep?: (ms: number) => Promise<void>;
      budget?: Record<string, number>;
    } = {},
  ): Harness {
    const { provider, calls } = fakeProvider(script);
    const base = createAttemptStore(admin);
    const events: string[] = [];
    const logs: string[] = [];
    const h: Harness = { deps: null!, calls, events, logs, markFailedCalls: 0 };
    const attempts: AttemptStore = {
      listForPublication: base.listForPublication,
      start: base.start,
      async update(ws, id, patch) {
        if (opts.failUpdate?.(patch as Record<string, unknown>)) throw new Error("injected attempt write failure");
        const row = await base.update(ws, id, patch);
        if (patch.stage) events.push(`attempt:${patch.stage}`);
        return row;
      },
    };
    h.deps = {
      provider,
      attempts,
      loadAssets: (ws, variantId) => loadVariantPublishAssets(admin, ws, variantId),
      signMediaUrl: async () => SIGNED_URL,
      markPublished: async (input) => {
        if (opts.failMarkPublished) throw new Error("injected publication write failure");
        const row = await markPublishedAsSystem(admin, workspaceId, publicationId, input);
        events.push("publication:published");
        return row;
      },
      markFailed: async (input) => {
        h.markFailedCalls += 1;
        return markFailedAsSystem(admin, workspaceId, publicationId, input);
      },
      sleep: opts.sleep ?? (async () => {}),
      now: opts.clock,
      pollIntervalMs: 1000,
      pollBudgetMs: 5000,
      budget: opts.budget,
      log: (line) => logs.push(line),
    };
    return h;
  }

  function ctx(publication: { id: string; content_variant_id: string }, variant: ContentVariant, socialAccount: SocialAccount) {
    return { workspaceId, publication, variant, socialAccount, credential: FAKE_TOKEN };
  }

  const reconcileDeps = (extra: { now?: () => number } = {}) => ({
    client: admin,
    attempts: createAttemptStore(admin),
    markPublished: (ws: string, id: string, input: Parameters<typeof markPublishedAsSystem>[3]) => markPublishedAsSystem(admin, ws, id, input),
    markFailed: (ws: string, id: string, input: Parameters<typeof markFailedAsSystem>[3]) => markFailedAsSystem(admin, ws, id, input),
    ...extra,
  });

  async function reachOutcomeUnknown() {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const h = harness(pub.id, { publish: () => failure("unknown") as MediaPublishResult });
    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
    expect(outcome.kind).toBe("outcome_unknown");
    return { pub, variant, h };
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "IG Publishing Engine", p_slug: `ig-engine-${Date.now()}` });
    workspaceId = ws!.id;
    const { data: other } = await outsider.client.rpc("create_workspace", { p_name: "IG Engine Other", p_slug: `ig-engine-o-${Date.now()}` });
    otherWorkspaceId = other!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "C" }).select().single();
    contentId = content!.id;
    modelBAccount = await account(IG_ID, { credentialKind: "real", instagramScopedUserId: "38281234567890123", instagramAppScopedId: "38281234567890123" });
    legacyAccount = await account("38281234567890120", { credentialKind: "real" });
  });

  afterAll(async () => {
    for (const id of vaultIds) {
      try {
        await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
      } catch {
        // best-effort
      }
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  // ------------------------------------------------------------------ success
  it("valid IMAGE: publishes, attempt 'published' is written BEFORE the publication, analytics-eligible afterwards", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const h = harness(pub.id);

    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);

    expect(outcome).toMatchObject({ kind: "published", mediaId: "18000000000000000999" });
    expect(h.events).toEqual(["attempt:container_created", "attempt:container_ready", "attempt:publish_requested", "attempt:published", "publication:published"]);
    const [attempt] = await attemptsFor(pub.id);
    expect(attempt).toMatchObject({ stage: "published", external_media_id: "18000000000000000999", container_ids: ["17900000000000000123"] });
    expect(attempt.media_asset_ids).toHaveLength(1);
    const row = await publicationRow(pub.id);
    expect(row).toMatchObject({ status: "published", external_publication_id: "18000000000000000999" });
    // Analytics eligibility criteria (analytics.ts): published + external id.
    const { count } = await admin.from("publications").select("id", { count: "exact", head: true }).eq("id", pub.id).eq("status", "published").not("external_publication_id", "is", null);
    expect(count).toBe(1);
    // Signed URL reached only the provider call.
    expect(h.calls.imageUrls).toEqual([SIGNED_URL]);
    const persisted = JSON.stringify([attempt, row]);
    expect(persisted).not.toContain("SIGNEDURLSENTINEL");
    expect(persisted).not.toContain(FAKE_TOKEN);
    expect(h.logs.join("\n")).not.toContain("SIGNEDURLSENTINEL");
    expect(h.logs.join("\n")).not.toContain(FAKE_TOKEN);
    expect(h.logs.every((line) => !line.includes("\n"))).toBe(true);
  });

  // ------------------------------------------------------------- eligibility
  it.each([
    ["unsupported MIME", async () => variantWith([await jpegAsset({ mime_type: "image/png" })]), "unsupported_media_type"],
    ["zero assets", async () => variantWith([]), "no_publish_media"],
    [">1 asset", async () => variantWith([await jpegAsset(), await jpegAsset()]), "unsupported_media_count"],
    ["archived asset", async () => variantWith([await jpegAsset({ archived_at: new Date().toISOString() })]), "asset_archived"],
    ["unsupported format", async () => variantWith([await jpegAsset()], { format: "reel" }), "unsupported_variant_format"],
    ["caption violation", async () => variantWith([await jpegAsset()], { caption: "x".repeat(2201) }), "caption_limit_exceeded"],
  ])("%s → failed (known), zero provider calls", async (_label, makeVariant, code) => {
    const variant = await makeVariant();
    const pub = await publishingPublication(variant, modelBAccount);
    const h = harness(pub.id);
    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
    expect(outcome).toMatchObject({ kind: "failed_known", code });
    expect(h.calls.create + h.calls.publish).toBe(0);
    expect((await publicationRow(pub.id)).status).toBe("failed");
    expect((await attemptsFor(pub.id))[0]).toMatchObject({ stage: "failed", error_code: code });
  });

  it("legacy / non-Model-B account → failed (known), zero provider calls", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, legacyAccount);
    const h = harness(pub.id);
    const outcome = await runStagedImagePublish(ctx(pub, variant, legacyAccount), h.deps);
    expect(outcome).toMatchObject({ kind: "failed_known", code: "account_not_publish_ready" });
    expect(h.calls.create + h.calls.publish).toBe(0);
  });

  // ------------------------------------------------------- pre-publish provider
  it.each([
    ["container create failure", { create: () => failure() as MediaContainerCreateResult }, "container_create_failed"],
    ["container ERROR", { status: () => ({ ok: true, status: "ERROR" }) as MediaContainerStatusResult }, "container_error"],
    ["container EXPIRED", { status: () => ({ ok: true, status: "EXPIRED" }) as MediaContainerStatusResult }, "container_expired"],
    ["media_publish authoritative rejection", { publish: () => failure("rejected") as MediaPublishResult }, "publish_rejected"],
  ])("%s → failed (known)", async (_label, script, code) => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const h = harness(pub.id, script as Script);
    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
    expect(outcome).toMatchObject({ kind: "failed_known", code });
    expect((await publicationRow(pub.id)).status).toBe("failed");
    if (code !== "publish_rejected") expect(h.calls.publish).toBe(0);
  });

  it("polling timeout → failed (known), media_publish never invoked", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    let t = 0;
    const h = harness(
      pub.id,
      { status: () => ({ ok: true, status: "IN_PROGRESS" }) },
      { clock: () => t, sleep: async (ms) => void (t += ms) },
    );
    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
    expect(outcome).toMatchObject({ kind: "failed_known", code: "container_poll_timeout" });
    expect(h.calls.publish).toBe(0);
    expect(h.calls.status).toBeGreaterThan(1);
  });

  it("publish_requested checkpoint failure → media_publish call count = 0", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const h = harness(pub.id, {}, { failUpdate: (patch) => patch.stage === "publish_requested" });
    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
    expect(outcome).toMatchObject({ kind: "failed_known", code: "checkpoint_failed" });
    expect(h.calls.publish).toBe(0);
  });

  // ---------------------------------------------------------- outcome unknown
  it("ambiguous media_publish → outcome_unknown; publication stays publishing; no markFailed; a second execution cannot publish again; scheduling blocked", async () => {
    const { pub, variant, h } = await reachOutcomeUnknown();
    expect(h.markFailedCalls).toBe(0);
    expect((await publicationRow(pub.id)).status).toBe("publishing");
    expect((await attemptsFor(pub.id))[0].stage).toBe("outcome_unknown");

    const again = harness(pub.id);
    const second = await runStagedImagePublish(ctx(pub, variant, modelBAccount), again.deps);
    expect(second).toMatchObject({ kind: "refused" });
    expect(again.calls.create + again.calls.publish).toBe(0);
    expect(h.calls.publish + again.calls.publish).toBe(1);

    const reschedule = await admin.from("publications").update({ status: "scheduled" }).eq("id", pub.id);
    expect(reschedule.error?.message).toMatch(/to scheduled from publishing/);
  });

  it("concurrent duplicate execution: at most one media_publish", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const a = harness(pub.id);
    const b = harness(pub.id);
    const results = await Promise.all([
      runStagedImagePublish(ctx(pub, variant, modelBAccount), a.deps),
      runStagedImagePublish(ctx(pub, variant, modelBAccount), b.deps),
    ]);
    expect(a.calls.publish + b.calls.publish).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r.kind === "published")).toHaveLength(a.calls.publish + b.calls.publish);
  });

  // ------------------------------------------------ post-success persistence
  it("attempt 'published' write failure after provider success → no markFailed, no provider retry, reconciler later marks outcome_unknown", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const h = harness(pub.id, {}, { failUpdate: (patch) => patch.stage === "published" });
    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
    // G-1 (MVP-5.35C-I): provider success is authoritatively known → the exact media id is returned.
    expect(outcome).toEqual({ kind: "pending_reconcile", attemptId: expect.any(String), reason: "attempt_published_persistence_failed", mediaId: "18000000000000000999" });
    expect(h.markFailedCalls).toBe(0);
    expect(h.calls.publish).toBe(1);
    expect(h.logs.some((line) => line.includes("media_published") && line.includes("18000000000000000999"))).toBe(true);
    expect((await publicationRow(pub.id)).status).toBe("publishing");

    const result = await reconcilePublicationLocally(workspaceId, pub.id, reconcileDeps({ now: () => Date.now() + 6 * 60_000 }));
    expect(result.kind).toBe("marked_outcome_unknown");
    expect((await attemptsFor(pub.id))[0].stage).toBe("outcome_unknown");
    expect((await publicationRow(pub.id)).status).toBe("publishing");
  });

  it("publication write failure after durable attempt success → no markFailed; reconciliation finalizes locally", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const h = harness(pub.id, {}, { failMarkPublished: true });
    const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
    expect(outcome).toMatchObject({ kind: "pending_reconcile", reason: "publication_published_persistence_failed", mediaId: "18000000000000000999" });
    expect(h.markFailedCalls).toBe(0);
    expect(h.calls.publish).toBe(1);
    expect((await attemptsFor(pub.id))[0]).toMatchObject({ stage: "published", external_media_id: "18000000000000000999" });

    const result = await reconcilePublicationLocally(workspaceId, pub.id, reconcileDeps());
    expect(result).toMatchObject({ kind: "finalized_published", mediaId: "18000000000000000999" });
    expect(await publicationRow(pub.id)).toMatchObject({ status: "published", external_publication_id: "18000000000000000999" });
  });

  // ----------------------------------------------------------- reconciliation
  it("stale pre-publish attempt → resolved not published (publication failed)", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    await createAttemptStore(admin).start({ workspaceId, publicationId: pub.id, provider: "instagram" });
    const result = await reconcilePublicationLocally(workspaceId, pub.id, reconcileDeps({ now: () => Date.now() + 11 * 60_000 }));
    expect(result.kind).toBe("resolved_not_published");
    expect((await publicationRow(pub.id)).status).toBe("failed");
  });

  it("stale publish_requested → outcome_unknown (publication stays publishing)", async () => {
    const variant = await variantWith([await jpegAsset()]);
    const pub = await publishingPublication(variant, modelBAccount);
    const store = createAttemptStore(admin);
    const attempt = await store.start({ workspaceId, publicationId: pub.id, provider: "instagram" });
    await store.update(workspaceId, attempt.id, { stage: "container_created", container_ids: ["c1"] });
    await store.update(workspaceId, attempt.id, { stage: "publish_requested" });
    const fresh = await reconcilePublicationLocally(workspaceId, pub.id, reconcileDeps());
    expect(fresh.kind).toBe("in_progress");
    const stale = await reconcilePublicationLocally(workspaceId, pub.id, reconcileDeps({ now: () => Date.now() + 6 * 60_000 }));
    expect(stale.kind).toBe("marked_outcome_unknown");
    expect((await publicationRow(pub.id)).status).toBe("publishing");
  });

  const inspectDeps = (script: Script) => {
    const { provider, calls } = fakeProvider(script);
    return {
      deps: { client: admin, attempts: createAttemptStore(admin), provider, resolveCredential: async () => FAKE_TOKEN },
      calls,
    };
  };

  it("unknown + FINISHED → operator decision required; no provider publish/create", async () => {
    const { pub } = await reachOutcomeUnknown();
    const { deps, calls } = inspectDeps({ status: () => ({ ok: true, status: "FINISHED" }) });
    const evidence = await inspectUnknownPublishOutcome(workspaceId, pub.id, deps);
    expect(evidence.kind).toBe("not_published_operator_decision_required");
    expect(calls.publish + calls.create).toBe(0);
    expect((await publicationRow(pub.id)).status).toBe("publishing");
  });

  it("unknown + ERROR/EXPIRED → known-not-published resolution (publication failed)", async () => {
    const { pub } = await reachOutcomeUnknown();
    const { deps, calls } = inspectDeps({ status: () => ({ ok: true, status: "EXPIRED" }) });
    const result = await resolveUnknownAsNotPublished(workspaceId, pub.id, {
      ...deps,
      markFailed: (ws, id, input) => markFailedAsSystem(admin, ws, id, input),
    });
    expect(result.resolved).toBe(true);
    expect(await publicationRow(pub.id)).toMatchObject({ status: "failed", error_code: "container_expired" });
    expect(calls.publish).toBe(0);
    expect((await attemptsFor(pub.id))[0].stage).toBe("outcome_unknown");
  });

  it.each([
    ["zero candidates", [] as { id: string; caption: string | null; timestamp: string | null }[], 0],
    ["one candidate", [{ id: "m-1", caption: "Launch day #marqos", timestamp: "__NOW__" }], 1],
    ["multiple candidates", [
      { id: "m-1", caption: "Launch day #marqos", timestamp: "__NOW__" },
      { id: "m-2", caption: "Launch day #marqos", timestamp: "__NOW__" },
    ], 2],
  ])("unknown + PUBLISHED + %s → never auto-finalized; operator confirmation required", async (_label, items, expected) => {
    const { pub } = await reachOutcomeUnknown();
    const nowIso = new Date().toISOString();
    const { deps, calls } = inspectDeps({
      status: () => ({ ok: true, status: "PUBLISHED" }),
      recent: () => ({ ok: true, items: items.map((item) => ({ ...item, timestamp: nowIso })) }),
    });
    const evidence = await inspectUnknownPublishOutcome(workspaceId, pub.id, deps);
    expect(evidence).toMatchObject({ kind: "published_media_id_unconfirmed", requiresOperatorConfirmation: true });
    expect((evidence as { candidates: unknown[] }).candidates).toHaveLength(expected);
    expect(calls.publish).toBe(0);
    expect(await publicationRow(pub.id)).toMatchObject({ status: "publishing", external_publication_id: null });
    // Not resolvable as not-published either.
    const attempt = await resolveUnknownAsNotPublished(workspaceId, pub.id, { ...deps, markFailed: async () => { throw new Error("must not be called"); } });
    expect(attempt.resolved).toBe(false);
  });

  it("provider read failure during inspection → unchanged", async () => {
    const { pub } = await reachOutcomeUnknown();
    const before = await publicationRow(pub.id);
    const { deps } = inspectDeps({ status: () => failure() as MediaContainerStatusResult });
    const evidence = await inspectUnknownPublishOutcome(workspaceId, pub.id, deps);
    expect(evidence.kind).toBe("provider_read_failed");
    expect(await publicationRow(pub.id)).toEqual(before);
  });


  // ------------------------------------------- G-1 / G-2 (MVP-5.35C-I)
  describe("G-1: authoritative media id survives local persistence failure", () => {
    it("2xx + valid id, attempt 'published' write fails after bounded retries → pending_reconcile carries the exact id; publish 1; no markFailed; publication publishing", async () => {
      const variant = await variantWith([await jpegAsset()]);
      const pub = await publishingPublication(variant, modelBAccount);
      let publishedWrites = 0;
      const h = harness(pub.id, { publish: () => ({ ok: true, mediaId: "18000000000000000321" }) }, {
        failUpdate: (patch) => patch.stage === "published" && (publishedWrites += 1) > 0,
      });
      const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
      expect(outcome).toMatchObject({ kind: "pending_reconcile", reason: "attempt_published_persistence_failed", mediaId: "18000000000000000321" });
      expect(publishedWrites).toBe(3); // bounded local retries, then stop
      expect(h.calls.publish).toBe(1);
      expect(h.markFailedCalls).toBe(0);
      expect((await attemptsFor(pub.id))[0]).toMatchObject({ stage: "publish_requested", external_media_id: null });
      expect((await publicationRow(pub.id)).status).toBe("publishing");
    });
  });

  describe("G-2: finalizeWithConfirmedMediaId (never calls the provider)", () => {
    const finalizeDeps = (events: string[] = [], opts: { failAttempt?: boolean; failPublication?: boolean } = {}) => {
      const base = createAttemptStore(admin);
      return {
        client: admin,
        attempts: {
          listForPublication: base.listForPublication,
          start: base.start,
          async update(ws: string, id: string, patch: Parameters<AttemptStore["update"]>[2]) {
            if (opts.failAttempt) throw new Error("injected");
            const row = await base.update(ws, id, patch);
            events.push(`attempt:${patch.stage}`);
            return row;
          },
        } satisfies AttemptStore,
        markPublished: async (ws: string, id: string, input: Parameters<typeof markPublishedAsSystem>[3]) => {
          if (opts.failPublication) throw new Error("injected");
          const row = await markPublishedAsSystem(admin, ws, id, input);
          events.push("publication:published");
          return row;
        },
      };
    };

    /** publication publishing + attempt publish_requested + the authoritative id from G-1. */
    async function publishRequestedWithKnownId() {
      const variant = await variantWith([await jpegAsset()]);
      const pub = await publishingPublication(variant, modelBAccount);
      const h = harness(pub.id, {}, { failUpdate: (patch) => patch.stage === "published" });
      const outcome = await runStagedImagePublish(ctx(pub, variant, modelBAccount), h.deps);
      if (outcome.kind !== "pending_reconcile" || !outcome.mediaId || !outcome.attemptId) throw new Error("setup");
      return { pub, h, attemptId: outcome.attemptId, mediaId: outcome.mediaId };
    }

    it("publish_requested: attempt published FIRST, then publication published with provenance; provider calls unchanged", async () => {
      const { pub, h, attemptId, mediaId } = await publishRequestedWithKnownId();
      const events: string[] = [];
      const result = await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId, mediaId, evidenceRef: "guard:level5-test.jsonl" }, finalizeDeps(events));
      expect(result).toEqual({ kind: "finalized", path: "publish_requested", attemptId, mediaId });
      expect(events).toEqual(["attempt:published", "publication:published"]);
      expect((await attemptsFor(pub.id))[0]).toMatchObject({ stage: "published", external_media_id: mediaId });
      const row = await publicationRow(pub.id);
      expect(row).toMatchObject({ status: "published", external_publication_id: mediaId });
      expect(row.published_at).not.toBeNull();
      expect(row.provider_response).toMatchObject({ reconciliation: "operator_confirmed", attemptId, mediaId, evidenceRef: "guard:level5-test.jsonl", attemptStageAtConfirmation: "publish_requested" });
      expect(h.calls).toMatchObject({ create: 1, publish: 1, recent: 0 });

      // Repeat: deterministic no-op with the same id; hard refusal with a different id.
      const before = await publicationRow(pub.id);
      expect(await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId, mediaId, evidenceRef: "again" }, finalizeDeps())).toEqual({ kind: "already_finalized", attemptId, mediaId });
      expect(await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId, mediaId: "18000000000000000001", evidenceRef: "x" }, finalizeDeps())).toEqual({ kind: "refused", reason: "published_with_different_media_id" });
      expect(await publicationRow(pub.id)).toEqual(before);
    });

    it("publish_requested: attempt write failure → publication stays publishing, attempt unchanged", async () => {
      const { pub, attemptId, mediaId } = await publishRequestedWithKnownId();
      const events: string[] = [];
      const result = await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId, mediaId, evidenceRef: "e" }, finalizeDeps(events, { failAttempt: true }));
      expect(result).toEqual({ kind: "attempt_persistence_failed", attemptId, mediaId });
      expect(events).toEqual([]);
      expect((await publicationRow(pub.id)).status).toBe("publishing");
      expect((await attemptsFor(pub.id))[0].stage).toBe("publish_requested");
    });

    it("publish_requested: publication write failure after the durable attempt → pending_reconcile; local reconciliation finalizes", async () => {
      const { pub, attemptId, mediaId } = await publishRequestedWithKnownId();
      const result = await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId, mediaId, evidenceRef: "e" }, finalizeDeps([], { failPublication: true }));
      expect(result).toEqual({ kind: "pending_reconcile", attemptId, mediaId, reason: "publication_published_persistence_failed" });
      expect((await reconcilePublicationLocally(workspaceId, pub.id, reconcileDeps())).kind).toBe("finalized_published");
      expect(await publicationRow(pub.id)).toMatchObject({ status: "published", external_publication_id: mediaId });
    });

    it("outcome_unknown: the terminal attempt is NOT modified; only the publication is published with operator provenance", async () => {
      const { pub, h } = await reachOutcomeUnknown();
      const [attemptBefore] = await attemptsFor(pub.id);
      const events: string[] = [];
      const result = await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId: attemptBefore.id, mediaId: "18000000000000000777", evidenceRef: "operator-review-1" }, finalizeDeps(events));
      expect(result).toEqual({ kind: "finalized", path: "outcome_unknown", attemptId: attemptBefore.id, mediaId: "18000000000000000777" });
      expect(events).toEqual(["publication:published"]);
      expect((await attemptsFor(pub.id))[0]).toEqual(attemptBefore);
      expect(await publicationRow(pub.id)).toMatchObject({
        status: "published",
        external_publication_id: "18000000000000000777",
        provider_response: { reconciliation: "operator_confirmed", attemptId: attemptBefore.id, mediaId: "18000000000000000777", evidenceRef: "operator-review-1", attemptStageAtConfirmation: "outcome_unknown" },
      });
      expect(h.calls.publish).toBe(1);
    });

    it("media id validation: only non-empty ASCII digit strings", async () => {
      const { pub, attemptId } = await publishRequestedWithKnownId();
      const before = await publicationRow(pub.id);
      for (const bad of ["", " ", "1.5", "1e21", "-1", "+1", "12a", " 123", "123 ", "１２３", "0x1f"]) {
        expect(await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId, mediaId: bad, evidenceRef: "e" }, finalizeDeps())).toEqual({ kind: "refused", reason: "invalid_media_id" });
      }
      expect(await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId, mediaId: "18000000000000000999", evidenceRef: " " }, finalizeDeps())).toEqual({ kind: "refused", reason: "missing_evidence_ref" });
      expect(await publicationRow(pub.id)).toEqual(before);
    });

    it("relationship guards: wrong workspace, attempt of another publication, unknown attempt, non-latest attempt, provider mismatch", async () => {
      const a = await publishRequestedWithKnownId();
      const b = await publishRequestedWithKnownId();
      const deps = finalizeDeps();
      expect(await finalizeWithConfirmedMediaId(otherWorkspaceId, a.pub.id, { attemptId: a.attemptId, mediaId: a.mediaId, evidenceRef: "e" }, deps)).toEqual({ kind: "refused", reason: "publication_not_found" });
      expect(await finalizeWithConfirmedMediaId(workspaceId, a.pub.id, { attemptId: b.attemptId, mediaId: a.mediaId, evidenceRef: "e" }, deps)).toEqual({ kind: "refused", reason: "attempt_not_found_for_publication" });
      expect(await finalizeWithConfirmedMediaId(workspaceId, a.pub.id, { attemptId: crypto.randomUUID(), mediaId: a.mediaId, evidenceRef: "e" }, deps)).toEqual({ kind: "refused", reason: "attempt_not_found_for_publication" });
      expect(await finalizeWithConfirmedMediaId(workspaceId, a.pub.id, { attemptId: a.attemptId, mediaId: a.mediaId, evidenceRef: "e" }, { ...deps, expectedProvider: "tiktok" })).toEqual({ kind: "refused", reason: "attempt_provider_mismatch" });

      // Non-latest: an older failed attempt followed by a newer one.
      const variant = await variantWith([await jpegAsset()]);
      const pub = await publishingPublication(variant, modelBAccount);
      const store = createAttemptStore(admin);
      const older = await store.start({ workspaceId, publicationId: pub.id, provider: "instagram" });
      await store.update(workspaceId, older.id, { stage: "failed", error_code: "fixture" });
      const newer = await store.start({ workspaceId, publicationId: pub.id, provider: "instagram" });
      await store.update(workspaceId, newer.id, { stage: "publish_requested" });
      expect(await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId: older.id, mediaId: "18000000000000000555", evidenceRef: "e" }, deps)).toEqual({ kind: "refused", reason: "attempt_not_latest" });
      expect((await publicationRow(a.pub.id)).status).toBe("publishing");
      expect((await publicationRow(pub.id)).status).toBe("publishing");
    });

    it("stage/state guards: failed attempt, failed publication, published attempt all refused", async () => {
      // latest attempt 'failed' while the publication is still publishing
      const variant = await variantWith([await jpegAsset()]);
      const pub = await publishingPublication(variant, modelBAccount);
      const store = createAttemptStore(admin);
      const failed = await store.start({ workspaceId, publicationId: pub.id, provider: "instagram" });
      await store.update(workspaceId, failed.id, { stage: "failed", error_code: "fixture" });
      expect(await finalizeWithConfirmedMediaId(workspaceId, pub.id, { attemptId: failed.id, mediaId: "18000000000000000555", evidenceRef: "e" }, finalizeDeps())).toEqual({ kind: "refused", reason: "attempt_stage_failed" });

      // publication failed (known failure path)
      const legacyVariant = await variantWith([await jpegAsset()]);
      const legacyPub = await publishingPublication(legacyVariant, legacyAccount);
      await runStagedImagePublish(ctx(legacyPub, legacyVariant, legacyAccount), harness(legacyPub.id).deps);
      const [legacyAttempt] = await attemptsFor(legacyPub.id);
      expect(await finalizeWithConfirmedMediaId(workspaceId, legacyPub.id, { attemptId: legacyAttempt.id, mediaId: "18000000000000000555", evidenceRef: "e" }, finalizeDeps())).toEqual({ kind: "refused", reason: "publication_failed" });

      // attempt already published while the publication is publishing → local reconciliation, not the finalizer
      const v2 = await variantWith([await jpegAsset()]);
      const p2 = await publishingPublication(v2, modelBAccount);
      await runStagedImagePublish(ctx(p2, v2, modelBAccount), harness(p2.id, {}, { failMarkPublished: true }).deps);
      const [publishedAttempt] = await attemptsFor(p2.id);
      expect(await finalizeWithConfirmedMediaId(workspaceId, p2.id, { attemptId: publishedAttempt.id, mediaId: "18000000000000000999", evidenceRef: "e" }, finalizeDeps())).toEqual({ kind: "refused", reason: "attempt_stage_published" });
    });
  });

  // --------------------------------------------------------- tenant isolation
  it("tenant isolation: attempts are readable by members only; never writable by members", async () => {
    const { pub } = await reachOutcomeUnknown();
    const { data: own } = await editor.client.from("publication_attempts").select("id").eq("publication_id", pub.id);
    expect(own?.length).toBe(1);
    const { data: foreign } = await outsider.client.from("publication_attempts").select("id").eq("publication_id", pub.id);
    expect(foreign).toEqual([]);
    const write = await editor.client.from("publication_attempts").insert({ workspace_id: workspaceId, publication_id: pub.id, provider: "instagram" });
    expect(write.error).not.toBeNull();
  });
});
