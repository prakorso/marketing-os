import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MediaContainerCreateResult, MediaContainerStatusResult, MediaPublishResult, StagedMediaPublisher } from "@/lib/social/provider";
import { runInstagramImageDryRun, DRY_RUN_STOP_CODE } from "@/server/services/instagram-image-dry-run";
import { createAttemptStore, runStagedImagePublish, type AttemptStore } from "@/server/services/instagram-image-publishing";
import { loadVariantPublishAssets } from "@/server/services/publication-media";
import { markFailedAsSystem, markPublishedAsSystem } from "@/server/services/publications";
import { DEFAULT_EXECUTION_BUDGET, ExecutionDeadline } from "@/server/services/publish-execution-budget";
import type { ContentVariant, SocialAccount } from "@/types/database";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.35C-D — Level 4 readiness: execution-deadline behavior of the real
 * engine and the structurally publish-free dry run. LOCAL Supabase only; an
 * in-memory fake provider (no Meta call is possible). Fake identifiers only.
 */

const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-L4-0001";
const FAKE_TOKEN = "IGAAfakeLevel4Token000000000000000001";
const FAKE_IG_ID = "17849990000000042";

type Script = {
  create?: () => MediaContainerCreateResult;
  status?: () => MediaContainerStatusResult;
  publish?: () => MediaPublishResult;
  onPublish?: () => void;
};

function fakeProvider(script: Script = {}) {
  const calls = { create: 0, status: 0, publish: 0, timeouts: [] as { op: string; timeoutMs: number | undefined }[] };
  const provider: StagedMediaPublisher = {
    async createMediaContainer(input) {
      calls.create += 1;
      calls.timeouts.push({ op: "create", timeoutMs: input.timeoutMs });
      return script.create ? script.create() : { ok: true, containerId: "17900000000000000777" };
    },
    async getMediaContainerStatus(input) {
      calls.status += 1;
      calls.timeouts.push({ op: "status", timeoutMs: input.timeoutMs });
      return script.status ? script.status() : { ok: true, status: "FINISHED" };
    },
    async publishMediaContainer(input) {
      calls.publish += 1;
      calls.timeouts.push({ op: "publish", timeoutMs: input.timeoutMs });
      script.onPublish?.();
      return script.publish ? script.publish() : { ok: true, mediaId: "18000000000000000555" };
    },
    async listRecentMedia() {
      return { ok: true, items: [] };
    },
  };
  return { provider, calls };
}

const fail = (outcome?: "unknown") => ({
  ok: false as const,
  ...(outcome ? { outcome } : {}),
  code: "transport_error",
  message: "fixture",
  httpStatus: null,
  providerCode: null,
  providerSubcode: null,
  fbtraceId: null,
});

describe.skipIf(!hasLocalSupabase)("MVP-5.35C-D Level 4 readiness (local DB)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;
  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let contentId: string;
  let account: SocialAccount;
  const vaultIds: string[] = [];

  async function jpegAsset(): Promise<string> {
    const id = crypto.randomUUID();
    const { data, error } = await admin
      .from("marqos_assets")
      .insert({ id, workspace_id: workspaceId, storage_path: `${workspaceId}/${id}.jpg`, file_name: `${id}.jpg`, mime_type: "image/jpeg", asset_type: "image", file_size: 400_000, width: 1080, height: 1350 })
      .select()
      .single();
    if (error || !data) throw new Error(`asset: ${error?.message}`);
    return data.id;
  }

  async function variantWithOneJpeg(): Promise<ContentVariant> {
    const { data: version } = await admin
      .from("content_versions")
      .insert({ content_id: contentId, workspace_id: workspaceId, version_number: Math.floor(Math.random() * 1e9) + 1, generation_method: "human", content_payload: { text: "l4" } })
      .select()
      .single();
    const { data: variant } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "Level 4 readiness" })
      .select()
      .single();
    await admin.from("content_approvals").insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: version!.id, status: "approved", reviewed_at: new Date().toISOString() });
    await admin.from("marqos_content_variant_assets").insert({ content_variant_id: variant!.id, asset_id: await jpegAsset(), workspace_id: workspaceId, sort_order: 0 });
    return variant!;
  }

  async function publishingPublication(variant: ContentVariant) {
    const { data } = await admin
      .from("publications")
      .insert({ workspace_id: workspaceId, content_variant_id: variant.id, social_account_id: account.id, status: "scheduled", scheduled_at: new Date().toISOString(), idempotency_key: crypto.randomUUID() })
      .select()
      .single();
    const moved = await admin.from("publications").update({ status: "publishing" }).eq("id", data!.id).select().single();
    return moved.data!;
  }

  const row = async (id: string) => (await admin.from("publications").select("*").eq("id", id).single()).data!;
  const attempts = async (id: string) => (await admin.from("publication_attempts").select("*").eq("publication_id", id).order("attempt_number")).data ?? [];

  function baseDeps(publicationId: string, opts: { failUpdate?: (patch: Record<string, unknown>) => boolean; signFails?: boolean } = {}) {
    const store = createAttemptStore(admin);
    const stages: string[] = [];
    const logs: string[] = [];
    const attemptsStore: AttemptStore = {
      listForPublication: store.listForPublication,
      start: store.start,
      async update(ws, id, patch) {
        if (opts.failUpdate?.(patch as Record<string, unknown>)) throw new Error("injected");
        const r = await store.update(ws, id, patch);
        if (patch.stage) stages.push(patch.stage);
        return r;
      },
    };
    return {
      stages,
      logs,
      deps: {
        attempts: attemptsStore,
        loadAssets: (ws: string, v: string) => loadVariantPublishAssets(admin, ws, v),
        signMediaUrl: async () => {
          if (opts.signFails) throw new Error("storage down");
          return SIGNED_URL;
        },
        markFailed: (input: Parameters<typeof markFailedAsSystem>[3]) => markFailedAsSystem(admin, workspaceId, publicationId, input),
        markPublished: (input: Parameters<typeof markPublishedAsSystem>[3]) => markPublishedAsSystem(admin, workspaceId, publicationId, input),
        sleep: async () => {},
        log: (line: string) => logs.push(line),
      },
    };
  }

  const ctxFor = (pub: { id: string; content_variant_id: string }, variant: ContentVariant) => ({
    workspaceId,
    publication: pub,
    variant,
    socialAccount: account,
    credential: FAKE_TOKEN,
  });

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "L4 readiness", p_slug: `l4-ready-${Date.now()}` });
    workspaceId = ws!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "C" }).select().single();
    contentId = content!.id;
    const { data: vault } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "l4" });
    vaultIds.push(vault as string);
    const { data: acct } = await admin
      .from("social_accounts")
      .insert({ workspace_id: workspaceId, platform: "instagram", external_account_id: FAKE_IG_ID, account_name: "l4", status: "connected", vault_secret_id: vault as string, metadata: { credentialKind: "real", instagramScopedUserId: "38281234567890123" } })
      .select()
      .single();
    account = acct!;
  });

  afterAll(async () => {
    for (const id of vaultIds) await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
    await cleanupTestData(admin, { workspaceIds: [workspaceId].filter(Boolean), userIds: [editor?.userId].filter((id): id is string => Boolean(id)) });
  });

  // ------------------------------------------------------------ budget: engine
  describe("execution budget (real engine)", () => {
    it("sufficient budget: ordering preserved, every provider timeout within the ceilings, publish timeout ≤ 10 s", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps, stages } = baseDeps(pub.id);
      const { provider, calls } = fakeProvider();
      const clock = { t: 0 };
      const deadline = new ExecutionDeadline({ now: () => clock.t });
      const outcome = await runStagedImagePublish(ctxFor(pub, variant), { ...deps, provider, deadline });
      expect(outcome.kind).toBe("published");
      expect(stages).toEqual(["container_created", "container_ready", "publish_requested", "published"]);
      for (const { timeoutMs } of calls.timeouts) {
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(DEFAULT_EXECUTION_BUDGET.providerRequestTimeoutMs);
      }
      expect(deadline.elapsedMs()).toBeLessThanOrEqual(DEFAULT_EXECUTION_BUDGET.totalMs);
    });

    it("insufficient pre-publish budget: NO publish_requested write, NO media_publish, known-not-published", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps, stages } = baseDeps(pub.id);
      const clock = { t: 0 };
      // Container becomes FINISHED only after the clock has eaten into the publish reserve.
      const { provider, calls } = fakeProvider({
        status: () => {
          clock.t += 20_000; // after this read: remaining 25 s … then 5 s
          return clock.t >= 40_000 ? { ok: true, status: "FINISHED" } : { ok: true, status: "IN_PROGRESS" };
        },
      });
      const deadline = new ExecutionDeadline({ now: () => clock.t, config: { pollBudgetMs: 60_000, minimumProviderCallMs: 0 } });
      // Force the FINISHED observation to arrive with < 17 s remaining.
      clock.t = 20_000;
      const outcome = await runStagedImagePublish(ctxFor(pub, variant), { ...deps, provider, deadline, sleep: async () => {} });
      expect(calls.publish).toBe(0);
      expect(stages).not.toContain("publish_requested");
      expect(outcome.kind).toBe("failed_known");
      const [attempt] = await attempts(pub.id);
      expect(attempt.stage).toBe("failed");
      expect(["insufficient_publish_time_budget", "container_poll_timeout"]).toContain(attempt.error_code);
      expect((await row(pub.id)).status).toBe("failed");
    });

    it("deadline check happens BEFORE publish_requested (container_ready reached with too little time left)", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps, stages } = baseDeps(pub.id);
      const clock = { t: 0 };
      const { provider, calls } = fakeProvider({
        status: () => {
          clock.t = 29_000; // FINISHED observed at 29 s → remaining 16 s < 17 s reserves
          return { ok: true, status: "FINISHED" };
        },
      });
      const deadline = new ExecutionDeadline({ now: () => clock.t });
      const outcome = await runStagedImagePublish(ctxFor(pub, variant), { ...deps, provider, deadline });
      expect(outcome).toMatchObject({ kind: "failed_known", code: "insufficient_publish_time_budget" });
      expect(stages).toEqual(["container_created", "container_ready", "failed"]);
      expect(calls.publish).toBe(0);
      // Safely manually retryable: failed with a certain outcome → rescheduling allowed.
      const reschedule = await admin.from("publications").update({ status: "scheduled", scheduled_at: new Date().toISOString() }).eq("id", pub.id);
      expect(reschedule.error).toBeNull();
    });

    it("polling never consumes the publish/persistence reserves", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps } = baseDeps(pub.id);
      const clock = { t: 0 };
      const pollTimes: number[] = [];
      const { provider, calls } = fakeProvider({
        status: () => {
          pollTimes.push(clock.t);
          return { ok: true, status: "IN_PROGRESS" };
        },
      });
      const deadline = new ExecutionDeadline({ now: () => clock.t, config: { pollBudgetMs: 60_000 } });
      const outcome = await runStagedImagePublish(ctxFor(pub, variant), { ...deps, provider, deadline, sleep: async (ms) => void (clock.t += ms) });
      expect(outcome).toMatchObject({ kind: "failed_known", code: "container_poll_timeout" });
      expect(calls.publish).toBe(0);
      const reserve = DEFAULT_EXECUTION_BUDGET.publishReserveMs + DEFAULT_EXECUTION_BUDGET.finalPersistenceReserveMs;
      for (const at of pollTimes) expect(at).toBeLessThanOrEqual(DEFAULT_EXECUTION_BUDGET.totalMs - reserve);
    });

    it("deadline exhausted AFTER media_publish began → outcome_unknown (publication stays publishing)", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps } = baseDeps(pub.id);
      const clock = { t: 0 };
      const { provider, calls } = fakeProvider({
        onPublish: () => void (clock.t = 60_000),
        publish: () => fail("unknown") as MediaPublishResult,
      });
      const deadline = new ExecutionDeadline({ now: () => clock.t });
      const outcome = await runStagedImagePublish(ctxFor(pub, variant), { ...deps, provider, deadline });
      expect(outcome.kind).toBe("outcome_unknown");
      expect(calls.publish).toBe(1);
      expect((await row(pub.id)).status).toBe("publishing");
      expect((await attempts(pub.id))[0].stage).toBe("outcome_unknown");
    });
  });

  // ------------------------------------------------------------------ dry run
  describe("dry run (structurally publish-free)", () => {
    function spyingProvider(script: Script = {}) {
      const { provider, calls } = fakeProvider(script);
      const accessed = new Set<string>();
      const proxy = new Proxy(provider, {
        get(target, prop, receiver) {
          accessed.add(String(prop));
          return Reflect.get(target, prop, receiver);
        },
      });
      return { proxy, calls, accessed };
    }

    it("valid image: create 1, poll to FINISHED, STOP — publishMediaContainer never even accessed; known-not-published", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps, stages, logs } = baseDeps(pub.id);
      const { proxy, calls, accessed } = spyingProvider();
      const outcome = await runInstagramImageDryRun(ctxFor(pub, variant), { ...deps, provider: proxy });
      expect(outcome).toMatchObject({ kind: "dry_run_container_ready", containerId: "17900000000000000777" });
      expect(calls.create).toBe(1);
      expect(calls.status).toBeGreaterThanOrEqual(1);
      expect(calls.publish).toBe(0);
      expect(accessed.has("publishMediaContainer")).toBe(false);
      expect(stages).toEqual(["container_created", "container_ready", "failed"]);
      const [attempt] = await attempts(pub.id);
      expect(attempt).toMatchObject({ stage: "failed", error_code: DRY_RUN_STOP_CODE, container_ids: ["17900000000000000777"] });
      expect(await row(pub.id)).toMatchObject({ status: "failed", error_code: DRY_RUN_STOP_CODE, external_publication_id: null });
      expect(JSON.stringify([attempt, await row(pub.id), logs])).not.toContain("SIGNEDURLSENTINEL");
      expect(logs.some((line) => line.startsWith("[instagram-dry-run]"))).toBe(true);
    });

    it.each([
      ["create failure", { create: () => fail() as MediaContainerCreateResult }, "container_create_failed"],
      ["poll ERROR", { status: () => ({ ok: true, status: "ERROR" }) as MediaContainerStatusResult }, "container_error"],
      ["poll EXPIRED", { status: () => ({ ok: true, status: "EXPIRED" }) as MediaContainerStatusResult }, "container_expired"],
    ])("%s → known failure, no publish", async (_label, script, code) => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps } = baseDeps(pub.id);
      const { proxy, calls, accessed } = spyingProvider(script as Script);
      const outcome = await runInstagramImageDryRun(ctxFor(pub, variant), { ...deps, provider: proxy });
      expect(outcome).toMatchObject({ kind: "failed_known", code });
      expect(calls.publish).toBe(0);
      expect(accessed.has("publishMediaContainer")).toBe(false);
    });

    it("poll timeout → known failure (not outcome_unknown)", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps } = baseDeps(pub.id);
      const clock = { t: 0 };
      const { proxy, calls } = spyingProvider({ status: () => ({ ok: true, status: "IN_PROGRESS" }) });
      const outcome = await runInstagramImageDryRun(ctxFor(pub, variant), {
        ...deps,
        provider: proxy,
        deadline: new ExecutionDeadline({ now: () => clock.t }),
        sleep: async (ms) => void (clock.t += ms),
      });
      expect(outcome).toMatchObject({ kind: "failed_known", code: "container_poll_timeout" });
      expect(calls.publish).toBe(0);
    });

    it("signed URL failure → known failure before any provider call", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps } = baseDeps(pub.id, { signFails: true });
      const { proxy, calls } = spyingProvider();
      const outcome = await runInstagramImageDryRun(ctxFor(pub, variant), { ...deps, provider: proxy });
      expect(outcome).toMatchObject({ kind: "failed_known", code: "signed_url_failed" });
      expect(calls.create + calls.publish).toBe(0);
    });

    it("checkpoint persistence failure → known failure, no publish", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { deps } = baseDeps(pub.id, { failUpdate: (patch) => patch.stage === "container_ready" });
      const { proxy, calls } = spyingProvider();
      const outcome = await runInstagramImageDryRun(ctxFor(pub, variant), { ...deps, provider: proxy });
      expect(outcome).toMatchObject({ kind: "failed_known", code: "checkpoint_failed" });
      expect(calls.publish).toBe(0);
    });

    it("duplicate dry-run execution: concurrent runs create at most one container; a rerun after completion creates none", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const a = spyingProvider();
      const b = spyingProvider();
      await Promise.all([
        runInstagramImageDryRun(ctxFor(pub, variant), { ...baseDeps(pub.id).deps, provider: a.proxy }),
        runInstagramImageDryRun(ctxFor(pub, variant), { ...baseDeps(pub.id).deps, provider: b.proxy }),
      ]);
      expect(a.calls.create + b.calls.create).toBeLessThanOrEqual(1);
      const c = spyingProvider();
      const rerun = await runInstagramImageDryRun(ctxFor(pub, variant), { ...baseDeps(pub.id).deps, provider: c.proxy });
      expect(rerun.kind).not.toBe("dry_run_container_ready");
      expect(c.calls.create + c.calls.publish).toBe(0);
    });

    it("an intentional dry-run stop is never recorded as outcome_unknown", async () => {
      const variant = await variantWithOneJpeg();
      const pub = await publishingPublication(variant);
      const { proxy } = spyingProvider();
      await runInstagramImageDryRun(ctxFor(pub, variant), { ...baseDeps(pub.id).deps, provider: proxy });
      const all = await attempts(pub.id);
      expect(all.every((attempt) => attempt.stage !== "outcome_unknown" && attempt.stage !== "publish_requested")).toBe(true);
    });
  });
});
