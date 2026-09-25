import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MediaContainerCreateResult, MediaContainerStatusResult, MediaPublishResult, StagedMediaPublisher } from "@/lib/social/provider";
import { runScheduledPublishingRuntime, type RuntimeDeps, type RuntimeSummary } from "@/server/runtime/scheduled-publishing";
import type { ContentVariant, Database, PublicationAttemptStage, SocialAccount } from "@/types/database";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.36H3 — adversarial verification of the hardened Level-6 runtime
 * (H1 lease/resume DB contract + H2 engine) against the LOCAL schema.
 *
 * Techniques (test-scoped only; no production bypass):
 *   - every invocation uses its OWN Supabase client whose `fetch` can be
 *     instrumented: a barrier forces real overlap at lease acquisition,
 *     PostgREST-level failures are injected (HTTP 500), and a "crash" is a
 *     request whose response never returns — the durable DB state stays
 *     exactly at that boundary and the run never proceeds;
 *   - restarts are NEW runs (new runId) after the lease history is shifted
 *     into the past (`advanceSlot`), i.e. legitimate next-slot semantics
 *     through the real acquire RPC and its overlap guard;
 *   - a fake budget clock drives deadlines deterministically; DB time stays
 *     authoritative for slots, staleness and readiness.
 * Fake provider only; synthetic ids; no hosted system is touched.
 */

const FAKE_TOKEN = "IGAAfakeAdversarialToken00000000000001";
const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-H3-0001";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ON_ENV = { MARQOS_INSTAGRAM_STAGED_PUBLISHING: "enabled", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const CONTAINER = "17900000000000000801";
const MEDIA = "18000000000000000801";
const N = 8;

type Req = { method: string; path: string; body: string };
type Hook = (req: Req, next: () => Promise<Response>) => Promise<Response>;

const rpc = (req: Req, name: string) => req.method === "POST" && req.path.startsWith(`/rest/v1/rpc/${name}`);
const table = (req: Req, name: string, method: string) => req.method === method && req.path.startsWith(`/rest/v1/${name}`);
const attemptPatch = (req: Req, fragment: string) => table(req, "publication_attempts", "PATCH") && req.body.includes(fragment);
const injected500 = () => new Response(JSON.stringify({ message: "injected failure", code: "XX000" }), { status: 500, headers: { "content-type": "application/json" } });
const never = <T,>() => new Promise<T>(() => {});

function instrumentedClient(hook?: Hook): SupabaseClient<Database> {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const req: Req = { method: (init?.method ?? "GET").toUpperCase(), path: url.pathname + url.search, body: typeof init?.body === "string" ? init.body : "" };
    const next = () => fetch(input, init);
    return hook ? hook(req, next) : next();
  }) as typeof fetch;
  return createClient<Database>(supabaseUrl!, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: wrapped } });
}

/** Resolves when `n` callers have arrived; all callers are released together. */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await gate;
  };
}

/** Crash = the response to the boundary request (or the provider call) never returns. */
function crashPoint() {
  let reached!: () => void;
  const crashed = new Promise<void>((resolve) => (reached = resolve));
  return { crashed, crash: <T,>() => (reached(), never<T>()) };
}

type Script = {
  create?: () => MediaContainerCreateResult | Promise<MediaContainerCreateResult>;
  status?: (containerId: string) => MediaContainerStatusResult | Promise<MediaContainerStatusResult>;
  publish?: (containerId: string) => MediaPublishResult | Promise<MediaPublishResult>;
};

/** Counters accumulate across invocations: provider-total evidence for restarts. */
function fakeProvider(script: Script = {}) {
  const calls = { create: 0, status: 0, publish: 0, statusContainers: [] as string[], publishContainers: [] as string[] };
  const provider: StagedMediaPublisher = {
    async createMediaContainer() {
      calls.create += 1;
      return script.create ? script.create() : { ok: true, containerId: CONTAINER };
    },
    async getMediaContainerStatus(input) {
      calls.status += 1;
      calls.statusContainers.push(input.containerId);
      return script.status ? script.status(input.containerId) : { ok: true, status: "FINISHED" };
    },
    async publishMediaContainer(input) {
      calls.publish += 1;
      calls.publishContainers.push(input.containerId);
      return script.publish ? script.publish(input.containerId) : { ok: true, mediaId: MEDIA };
    },
    async listRecentMedia() {
      return { ok: true, items: [] };
    },
  };
  return { provider, calls };
}

const unknown = (code: string, httpStatus: number | null = null) => ({
  ok: false as const,
  outcome: "unknown" as const,
  code,
  message: "fixture",
  httpStatus,
  providerCode: null,
  providerSubcode: null,
  fbtraceId: null,
});

function fakeClock(start = 0) {
  let first = true;
  const state = { t: start };
  return {
    state,
    // The budget's origin is the first reading (0); later readings return state.t.
    now: () => {
      if (first) {
        first = false;
        return 0;
      }
      return state.t;
    },
    sleep: async (ms: number) => void (state.t += ms),
  };
}

describe.skipIf(!hasLocalSupabase)("MVP-5.36H3 adversarial runtime verification (local DB, fake provider)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, SERVICE_KEY) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let contentId: string;
  let account: SocialAccount;
  const vaultIds: string[] = [];

  const setControl = async (enabled: boolean, mode: "dry_run" | "publish" = "dry_run") => {
    const { error } = await admin.from("publishing_runtime_control").upsert({ key: "instagram_scheduled_publishing", enabled, mode });
    if (error) throw new Error(`control: ${error.message}`);
  };
  const removeControl = () => admin.from("publishing_runtime_control").delete().eq("key", "instagram_scheduled_publishing");
  const clearLeases = () => admin.from("publishing_runtime_slot_lease").delete().eq("runtime_key", "instagram_scheduled_publishing");
  const leases = async () =>
    (await admin.from("publishing_runtime_slot_lease").select("*").eq("runtime_key", "instagram_scheduled_publishing").order("acquired_at")).data ?? [];

  /** Legitimate next-slot semantics: push the whole lease history into the past (evidence kept, nothing deleted). */
  async function advanceSlot() {
    for (const row of await leases()) {
      await admin
        .from("publishing_runtime_slot_lease")
        .update({
          acquired_at: new Date(new Date(row.acquired_at).getTime() - DAY).toISOString(),
          slot_start: new Date(new Date(row.slot_start).getTime() - DAY).toISOString(),
        } as never)
        .eq("run_id", row.run_id);
    }
  }

  async function closeInflight() {
    await admin
      .from("publication_attempts")
      .update({ stage: "failed", error_code: "test_cleanup" })
      .eq("workspace_id", workspaceId)
      .in("stage", ["validating", "container_created", "container_ready", "publish_requested"]);
    await admin.from("publications").update({ status: "failed", error_code: "test_cleanup" }).eq("workspace_id", workspaceId).eq("status", "publishing");
    await admin.from("publications").delete().eq("workspace_id", workspaceId).eq("status", "scheduled");
  }

  async function variant(): Promise<ContentVariant> {
    const { data: version } = await admin
      .from("content_versions")
      .insert({ content_id: contentId, workspace_id: workspaceId, version_number: Math.floor(Math.random() * 1e9) + 1, generation_method: "human", content_payload: { text: "h3" } })
      .select()
      .single();
    const { data: row, error } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "H3 fixture" })
      .select()
      .single();
    if (error || !row) throw new Error(`variant: ${error?.message}`);
    await admin.from("content_approvals").insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: version!.id, status: "approved", reviewed_at: new Date().toISOString() });
    const assetId = crypto.randomUUID();
    await admin.from("marqos_assets").insert({
      id: assetId,
      workspace_id: workspaceId,
      storage_path: `${workspaceId}/${assetId}.jpg`,
      file_name: `${assetId}.jpg`,
      mime_type: "image/jpeg",
      asset_type: "image",
      file_size: 400_000,
      width: 1080,
      height: 1350,
    });
    await admin.from("marqos_content_variant_assets").insert({ content_variant_id: row.id, asset_id: assetId, workspace_id: workspaceId, sort_order: 0 });
    return row;
  }

  async function scheduled(offsetMs = -5 * MIN): Promise<string> {
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: (await variant()).id,
        social_account_id: account.id,
        status: "scheduled",
        scheduled_at: new Date(Date.now() + offsetMs).toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`publication: ${error?.message}`);
    return data.id;
  }

  /** Synthetic durable crash state: a 'publishing' publication and (optionally) its attempt. */
  async function crashState(stage: PublicationAttemptStage | null, fields: Record<string, unknown> = {}): Promise<{ publicationId: string; attemptId: string | null }> {
    const publicationId = await scheduled();
    await admin.from("publications").update({ status: "publishing" }).eq("id", publicationId);
    if (!stage) return { publicationId, attemptId: null };
    const old = new Date(Date.now() - 30 * MIN).toISOString();
    const { data, error } = await admin
      .from("publication_attempts")
      .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram", stage, started_at: old, updated_at: old, ...fields } as never)
      .select()
      .single();
    if (error || !data) throw new Error(`attempt: ${error?.message}`);
    return { publicationId, attemptId: (data as { id: string }).id };
  }

  const pub = async (id: string) => (await admin.from("publications").select("*").eq("id", id).single()).data!;
  const attempts = async (id: string) => (await admin.from("publication_attempts").select("*").eq("publication_id", id).order("attempt_number")).data ?? [];

  type Run = { summary: RuntimeSummary; logs: string[]; events: Record<string, unknown>[]; names: string[] };
  async function invoke(provider: StagedMediaPublisher, opts: { hook?: Hook; clock?: ReturnType<typeof fakeClock>; extra?: Partial<RuntimeDeps> } = {}): Promise<Run> {
    const clock = opts.clock ?? fakeClock();
    const logs: string[] = [];
    const summary = await runScheduledPublishingRuntime({
      client: instrumentedClient(opts.hook),
      env: ON_ENV,
      provider,
      signMediaUrl: async () => SIGNED_URL,
      now: clock.now,
      sleep: clock.sleep,
      log: (line) => logs.push(line),
      ...opts.extra,
    });
    const events = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { summary, logs, events, names: events.map((e) => e.event as string) };
  }

  /** Start a run that will "crash" at a boundary; resolves once the boundary is reached (the run never finishes). */
  async function crashRun(provider: StagedMediaPublisher, hook: Hook | undefined, crashed: Promise<void>, clock = fakeClock()) {
    void invoke(provider, { hook, clock });
    await crashed;
  }

  beforeAll(async () => {
    await removeControl();
    await clearLeases();
    editor = await createSignedInTestUser(admin);
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "Runtime H3", p_slug: `runtime-h3-${Date.now()}` });
    workspaceId = ws!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "C" }).select().single();
    contentId = content!.id;
    const { data: secret } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "h3 test" });
    vaultIds.push(secret as string);
    const { data: acct, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "17849990000000112",
        account_name: "h3 fixture",
        status: "connected",
        vault_secret_id: secret as string,
        metadata: { credentialKind: "real", instagramScopedUserId: "38281000000011201", instagramAppScopedId: "38281000000011201" },
      })
      .select()
      .single();
    if (error || !acct) throw new Error(`account: ${error?.message}`);
    account = acct;
    await admin.from("publishing_runtime_allowlist").insert({ social_account_id: acct.id, workspace_id: workspaceId });
  });

  beforeEach(async () => {
    await clearLeases();
    await closeInflight();
    await setControl(true, "dry_run");
  });

  afterAll(async () => {
    await closeInflight();
    await removeControl();
    await clearLeases();
    for (const id of vaultIds) {
      try {
        await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
      } catch {
        // best-effort
      }
    }
    await cleanupTestData(admin, { workspaceIds: [workspaceId].filter(Boolean), userIds: [editor?.userId].filter((id): id is string => Boolean(id)) });
  });

  /** N overlapping deliveries released together at lease acquisition; counts every runtime RPC across all of them. */
  async function deliveries(provider: StagedMediaPublisher, n = N) {
    const gate = barrier(n);
    const rpcCalls: Record<string, number> = {};
    const hook: Hook = async (req, next) => {
      const m = req.path.match(/^\/rest\/v1\/rpc\/([a-z_]+)/);
      if (req.method === "POST" && m) rpcCalls[m[1]] = (rpcCalls[m[1]] ?? 0) + 1;
      if (rpc(req, "acquire_runtime_slot_lease")) await gate();
      return next();
    };
    const runs = await Promise.all(Array.from({ length: n }, () => invoke(provider, { hook })));
    return { runs, rpcCalls };
  }

  // ===========================================================================
  // 3. TRUE CONCURRENCY (I2, I3)
  // ===========================================================================
  it("TRUE CONCURRENCY: 8 overlapping deliveries of one slot → exactly one worker; 7 suppressed with zero work", async () => {
    const a = await scheduled(-30 * MIN);
    const b = await scheduled(-20 * MIN);
    const c = await scheduled(-10 * MIN);
    const fake = fakeProvider();
    const { runs, rpcCalls } = await deliveries(fake.provider);
    const outcomes = runs.map((r) => r.summary.outcome).sort();
    expect(outcomes.filter((o) => o === "completed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate_suppressed")).toHaveLength(N - 1);
    expect(rpcCalls.acquire_runtime_slot_lease).toBe(N);
    expect(rpcCalls.reconcile_stale_runtime_publications).toBe(1);
    expect(rpcCalls.select_runtime_resume).toBe(1);
    expect(rpcCalls.claim_runtime_publications).toBe(1);
    expect(rpcCalls.read_social_account_vault_secret).toBe(1);
    expect(rpcCalls.complete_runtime_slot_lease).toBe(1); // duplicates never complete (nor overwrite) the holder's lease
    expect(fake.calls).toMatchObject({ create: 1, publish: 0 });
    for (const dup of runs.filter((r) => r.summary.outcome === "duplicate_suppressed")) {
      expect(dup.summary).toMatchObject({ reconciled: 0, claimed: 0, vaultReads: 0, providerCalls: { create: 0, status: 0, publish: 0 } });
      expect(dup.names).toContain("scheduler_duplicate_suppressed");
      expect(dup.names.filter((n) => ["reconcile", "work_selected", "vault", "g1_dispatch"].includes(n))).toEqual([]);
    }
    const [lease] = await leases();
    expect(lease.duplicate_count).toBe(N - 1);
    expect((await pub(a)).status).toBe("failed"); // dry-run terminal
    expect((await pub(b)).status).toBe("scheduled");
    expect((await pub(c)).status).toBe("scheduled");
  }, 60_000);

  // ===========================================================================
  // 4. MULTI-DUE SINGLE-FLIGHT (I4, I5)
  // ===========================================================================
  it("MULTI-DUE: A in flight blocks B/C across slots; A resumes first; B only after A is terminal", async () => {
    const a = await scheduled(-30 * MIN);
    const b = await scheduled(-20 * MIN);
    const c = await scheduled(-10 * MIN);
    // Slot 1: A claimed; container never ready within the budget → deferred (clock advanced by sleeps).
    const slow = fakeProvider({ status: () => ({ ok: true, status: "IN_PROGRESS" }) });
    const slot1 = await deliveries(slow.provider);
    expect(slot1.runs.filter((r) => r.summary.workKind === "claim")).toHaveLength(1);
    expect(slot1.runs.find((r) => r.summary.workKind === "claim")!.summary).toMatchObject({ publicationId: a, result: "deferred", code: "not_ready" });
    expect([(await pub(a)).status, (await pub(b)).status, (await pub(c)).status]).toEqual(["publishing", "scheduled", "scheduled"]);

    // Slot 2: A RESUMES (never a claim of B/C); FINISHED → dry-run terminal.
    await advanceSlot();
    const ready = fakeProvider();
    const slot2 = await deliveries(ready.provider);
    const worker2 = slot2.runs.find((r) => r.summary.outcome === "completed")!;
    expect(worker2.summary).toMatchObject({ workKind: "resume", publicationId: a, result: "dry_run_container_ready", claimed: 0 });
    expect(slot2.rpcCalls.claim_runtime_publications).toBeUndefined();
    expect(slow.calls.create + ready.calls.create).toBe(1);
    expect(ready.calls.statusContainers).toEqual([CONTAINER]);
    expect([(await pub(b)).status, (await pub(c)).status]).toEqual(["scheduled", "scheduled"]);

    // Slot 3: now B may be claimed; C still waits.
    await advanceSlot();
    const slot3 = await deliveries(fakeProvider().provider);
    expect(slot3.runs.find((r) => r.summary.outcome === "completed")!.summary).toMatchObject({ workKind: "claim", publicationId: b });
    expect((await pub(c)).status).toBe("scheduled");
  }, 120_000);

  // ===========================================================================
  // 5. SLOT BOUNDARY / OVERLAP (I2)
  // ===========================================================================
  it("SLOT BOUNDARY: an incomplete previous-slot lease < 60 s old blocks every new-slot delivery; after expiry exactly one acquires; no stealing", async () => {
    await scheduled();
    const crashedRun = crypto.randomUUID();
    const prevSlot = new Date(Math.floor(Date.now() / (5 * MIN)) * 5 * MIN - 5 * MIN).toISOString();
    await admin.from("publishing_runtime_slot_lease").insert({
      runtime_key: "instagram_scheduled_publishing",
      slot_start: prevSlot,
      run_id: crashedRun,
      acquired_at: new Date(Date.now() - 30_000).toISOString(),
    });
    const fake = fakeProvider();
    const blocked = await deliveries(fake.provider);
    expect(blocked.runs.every((r) => r.summary.outcome === "duplicate_suppressed")).toBe(true);
    expect(blocked.runs[0].events.find((e) => e.event === "scheduler_duplicate_suppressed")).toMatchObject({ reason: "overlap_active", holderRunId: crashedRun });
    expect(blocked.rpcCalls.reconcile_stale_runtime_publications).toBeUndefined();
    expect(fake.calls.create).toBe(0);
    expect(await leases()).toHaveLength(1);

    await admin.from("publishing_runtime_slot_lease").update({ acquired_at: new Date(Date.now() - 61_000).toISOString() }).eq("run_id", crashedRun);
    const after = await deliveries(fake.provider);
    expect(after.runs.filter((r) => r.summary.outcome === "completed")).toHaveLength(1);
    const rows = await leases();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.run_id === crashedRun)).toMatchObject({ completed_at: null, outcome: null }); // evidence untouched
  }, 60_000);

  // ===========================================================================
  // 6. CRASH MATRIX — real runtime crashes at durable boundaries, then a NEW run
  // ===========================================================================
  describe("crash matrix (real crash at the boundary → restart with a new runId)", () => {
    it("C0 lease acquired, crash before reconcile → same slot stays suppressed; next slot recovers with no provider carry-over", async () => {
      const due = await scheduled();
      const cp = crashPoint();
      await crashRun(fakeProvider().provider, async (req, next) => (rpc(req, "reconcile_stale_runtime_publications") ? cp.crash() : next()), cp.crashed);
      const fake = fakeProvider();
      expect((await invoke(fake.provider)).summary.outcome).toBe("duplicate_suppressed");
      await advanceSlot();
      const restart = await invoke(fake.provider);
      expect(restart.summary).toMatchObject({ outcome: "completed", workKind: "claim", publicationId: due });
      expect(fake.calls.create).toBe(1);
    });

    it("C1 after claim, before attempt → publishing/no attempt; restart does no work (single-flight) and never claims #2; provider 0", async () => {
      const a = await scheduled(-20 * MIN);
      const b = await scheduled(-10 * MIN);
      const cp = crashPoint();
      await crashRun(fakeProvider().provider, async (req, next) => {
        const res = await next();
        return rpc(req, "claim_runtime_publications") ? cp.crash() : res;
      }, cp.crashed);
      expect((await pub(a)).status).toBe("publishing");
      expect(await attempts(a)).toEqual([]);
      await advanceSlot();
      const fake = fakeProvider();
      const restart = await invoke(fake.provider);
      expect(restart.summary).toMatchObject({ outcome: "no_work", claimed: 0 });
      expect((await pub(b)).status).toBe("scheduled");
      expect(fake.calls).toMatchObject({ create: 0, status: 0, publish: 0 });
    });

    it("C2 attempt validating, crash before the pre-G1 marker → restart never dispatches G1", async () => {
      const a = await scheduled();
      const cp = crashPoint();
      await crashRun(fakeProvider().provider, async (req, next) => {
        const res = await next();
        return table(req, "publication_attempts", "POST") ? cp.crash() : res;
      }, cp.crashed);
      expect((await attempts(a))[0]).toMatchObject({ stage: "validating", container_create_requested_at: null });
      await advanceSlot();
      const fake = fakeProvider();
      expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
      expect(fake.calls.create).toBe(0);
    });

    it("C3 marker committed, crash before G1 dispatch → recovery NEVER dispatches G1 (dispatch not provable)", async () => {
      const a = await scheduled();
      const cp = crashPoint();
      const first = fakeProvider();
      await crashRun(first.provider, async (req, next) => {
        const res = await next();
        return attemptPatch(req, "container_create_requested_at") ? cp.crash() : res;
      }, cp.crashed);
      const [attempt] = await attempts(a);
      expect(attempt.stage).toBe("validating");
      expect(attempt.container_create_requested_at).not.toBeNull();
      expect(first.calls.create).toBe(0);
      await advanceSlot();
      const second = fakeProvider();
      expect((await invoke(second.provider)).summary.outcome).toBe("no_work");
      expect(first.calls.create + second.calls.create).toBe(0);
    });

    it("C4 G1 sent, crash before its response is persisted → never a second G1", async () => {
      const a = await scheduled();
      const cp = crashPoint();
      const fake = fakeProvider({ create: () => cp.crash() });
      await crashRun(fake.provider, undefined, cp.crashed);
      expect((await attempts(a))[0]).toMatchObject({ stage: "validating", container_ids: [] });
      await advanceSlot();
      expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
      expect(fake.calls.create).toBe(1);
    });

    it("C5 container id persisted, crash before the first poll → next slot RESUMES the recorded container; G1 stays 1", async () => {
      const a = await scheduled();
      const cp = crashPoint();
      const first = fakeProvider({ create: () => ({ ok: true, containerId: "17900000000000000805" }) });
      await crashRun(first.provider, async (req, next) => {
        const res = await next();
        return attemptPatch(req, '"container_created"') ? cp.crash() : res;
      }, cp.crashed);
      await advanceSlot();
      const second = fakeProvider();
      const restart = await invoke(second.provider);
      expect(restart.summary).toMatchObject({ workKind: "resume", publicationId: a, result: "dry_run_container_ready" });
      expect(second.calls.statusContainers).toEqual(["17900000000000000805"]); // I8
      expect(first.calls.create + second.calls.create).toBe(1);
    });

    it("C6 crash during G2 while IN_PROGRESS → resume with the same container id; G1 total 1", async () => {
      const a = await scheduled();
      const cp = crashPoint();
      const first = fakeProvider({ status: () => cp.crash() });
      await crashRun(first.provider, undefined, cp.crashed);
      expect((await attempts(a))[0].stage).toBe("container_created");
      await advanceSlot();
      const second = fakeProvider();
      const restart = await invoke(second.provider);
      expect(restart.summary).toMatchObject({ workKind: "resume", result: "dry_run_container_ready" });
      expect(second.calls.statusContainers).toEqual([CONTAINER]);
      expect(first.calls.create + second.calls.create).toBe(1);
    });

    it("C7 container_ready persisted, crash before terminalization → dry_run resumes to terminal, G3 0; publish resumes to exactly one G3", async () => {
      for (const mode of ["dry_run", "publish"] as const) {
        await clearLeases();
        await closeInflight();
        await setControl(true, mode);
        const a = await scheduled();
        const cp = crashPoint();
        const first = fakeProvider();
        await crashRun(first.provider, async (req, next) => {
          const res = await next();
          return attemptPatch(req, '"container_ready"') ? cp.crash() : res;
        }, cp.crashed);
        await advanceSlot();
        const second = fakeProvider();
        const restart = await invoke(second.provider);
        expect(restart.summary.workKind).toBe("resume");
        expect(second.calls.status).toBe(0);
        if (mode === "dry_run") {
          expect(restart.summary.result).toBe("dry_run_container_ready");
          expect(first.calls.publish + second.calls.publish).toBe(0);
        } else {
          expect(restart.summary.result).toBe("published");
          expect(second.calls.publishContainers).toEqual([CONTAINER]);
          expect(first.calls.publish + second.calls.publish).toBe(1);
          expect(await pub(a)).toMatchObject({ status: "published", external_publication_id: MEDIA });
        }
      }
    });

    it("C8 publish_requested committed, crash before G3 dispatch → recovery NEVER dispatches G3", async () => {
      await setControl(true, "publish");
      const a = await scheduled();
      const cp = crashPoint();
      const first = fakeProvider();
      await crashRun(first.provider, async (req, next) => {
        const res = await next();
        return attemptPatch(req, '"publish_requested"') ? cp.crash() : res;
      }, cp.crashed);
      expect((await attempts(a))[0].stage).toBe("publish_requested");
      await advanceSlot();
      const second = fakeProvider();
      expect((await invoke(second.provider)).summary.outcome).toBe("no_work");
      expect(first.calls.publish + second.calls.publish).toBe(0);
    });

    it("C9 G3 sent, crash before its response is persisted → never a second G3", async () => {
      await setControl(true, "publish");
      const a = await scheduled();
      const cp = crashPoint();
      const fake = fakeProvider({ publish: () => cp.crash() });
      await crashRun(fake.provider, undefined, cp.crashed);
      expect((await attempts(a))[0].stage).toBe("publish_requested");
      await advanceSlot();
      expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
      expect(fake.calls.publish).toBe(1);
    });

    it("C10 G3 success + attempt published, crash before publication persistence → reconciler finalizes from the durable media id; G3 total 1", async () => {
      await setControl(true, "publish");
      const a = await scheduled();
      const cp = crashPoint();
      const fake = fakeProvider();
      await crashRun(fake.provider, async (req, next) =>
        table(req, "publications", "PATCH") && req.body.includes('"status":"published"') ? cp.crash() : next(), cp.crashed);
      expect((await attempts(a))[0]).toMatchObject({ stage: "published", external_media_id: MEDIA });
      expect((await pub(a)).status).toBe("publishing");
      await advanceSlot();
      const restart = await invoke(fake.provider);
      const reconcile = restart.events.find((e) => e.event === "reconcile") as { rows: Array<{ publicationId: string; action: string }> };
      expect(reconcile.rows.find((r) => r.publicationId === a)?.action).toBe("finalized_published");
      expect(await pub(a)).toMatchObject({ status: "published", external_publication_id: MEDIA });
      expect(fake.calls.publish).toBe(1);
    });

    it("C11 terminal persisted, crash before lease completion → same slot suppressed; next slot repeats no provider work", async () => {
      const a = await scheduled();
      const cp = crashPoint();
      const fake = fakeProvider();
      await crashRun(fake.provider, async (req, next) => (rpc(req, "complete_runtime_slot_lease") ? cp.crash() : next()), cp.crashed);
      expect((await pub(a)).error_code).toBe("dry_run_container_ready");
      const [lease] = await leases();
      expect(lease.completed_at).toBeNull();
      expect((await invoke(fake.provider)).summary.outcome).toBe("duplicate_suppressed");
      await advanceSlot();
      expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
      expect(fake.calls).toMatchObject({ create: 1, status: 1, publish: 0 });
      expect((await leases()).find((l) => l.run_id === lease.run_id)!.completed_at).toBeNull(); // evidence kept, never stolen
    });
  });

  // ===========================================================================
  // 6b. Provider-free recovery of the unprovable boundaries (DB-clock staleness)
  // ===========================================================================
  describe("crash recovery by the provider-free reconciler (C1/C2/C3/C4/C8/C9 states)", () => {
    it("classifies every unprovable boundary known-safe without any provider call; outcome_unknown then blocks new claims (I11)", async () => {
      const ids: Record<string, string> = {};
      await setControl(false);
      const old = new Date(Date.now() - 30 * MIN).toISOString();
      ids.c1 = (await crashState(null)).publicationId;
      ids.c2 = (await crashState("validating")).publicationId;
      ids.c3 = (await crashState("validating", { container_create_requested_at: old })).publicationId;
      ids.c4 = (await crashState("validating", { container_create_requested_at: old })).publicationId;
      ids.c8 = (await crashState("publish_requested", { container_ids: [CONTAINER], container_created_at: old, container_create_requested_at: old })).publicationId;
      ids.c9 = (await crashState("publish_requested", { container_ids: [CONTAINER], container_created_at: old, container_create_requested_at: old })).publicationId;
      await new Promise((r) => setTimeout(r, 62_000)); // age the attempt-less publication (DB clock)
      await setControl(true, "publish");
      const due = await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { extra: { staleSeconds: 60 } });
      const rows = (run.events.find((e) => e.event === "reconcile") as { rows: Array<{ publicationId: string; action: string }> }).rows;
      const action = Object.fromEntries(rows.map((r) => [r.publicationId, r.action]));
      expect(action[ids.c1]).toBe("failed_no_attempt");
      expect(action[ids.c2]).toBe("failed_pre_provider");
      expect(action[ids.c3]).toBe("failed_g1_unknown");
      expect(action[ids.c4]).toBe("failed_g1_unknown");
      expect(action[ids.c8]).toBe("marked_outcome_unknown");
      expect(action[ids.c9]).toBe("marked_outcome_unknown");
      expect(run.summary).toMatchObject({ outcome: "no_work", vaultReads: 0 });
      expect(fake.calls).toMatchObject({ create: 0, status: 0, publish: 0 });
      expect((await pub(due)).status).toBe("scheduled"); // blocked by the two outcome_unknown publications
      expect(await pub(ids.c3)).toMatchObject({ status: "failed", error_code: "container_create_outcome_unknown" });
    }, 180_000);
  });

  // ===========================================================================
  // 7. FAILURE INJECTION (PostgREST-level HTTP 500)
  // ===========================================================================
  describe("failure injection", () => {
    it("lease completion failure → logged, lease left incomplete; the next slot repeats no provider work", async () => {
      await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (rpc(req, "complete_runtime_slot_lease") ? injected500() : next()) });
      expect(run.summary).toMatchObject({ result: "dry_run_container_ready", leaseCompleted: false });
      expect(run.events.find((e) => e.event === "lease_complete")).toMatchObject({ completed: false });
      await advanceSlot();
      expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
      expect(fake.calls.create).toBe(1);
    });

    it("audit write failure → outcome unaffected", async () => {
      await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (table(req, "audit_logs", "POST") ? injected500() : next()) });
      expect(run.summary).toMatchObject({ result: "dry_run_container_ready", leaseCompleted: true });
      expect(fake.calls.create).toBe(1);
    });

    it("media checkpoint failure → known failure, G1 0", async () => {
      await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (attemptPatch(req, "media_asset_ids") ? injected500() : next()) });
      expect(run.summary).toMatchObject({ result: "failed_known", code: "checkpoint_failed" });
      expect(fake.calls.create).toBe(0);
    });

    it("pre-G1 marker persistence failure → no G1", async () => {
      await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (attemptPatch(req, "container_create_requested_at") ? injected500() : next()) });
      expect(run.summary).toMatchObject({ result: "failed_known", code: "checkpoint_failed" });
      expect(fake.calls.create).toBe(0);
    });

    it("container checkpoint failure after G1 success → pending_reconcile; restart never re-dispatches G1", async () => {
      const a = await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (attemptPatch(req, '"container_created"') ? injected500() : next()) });
      expect(run.summary).toMatchObject({ result: "pending_reconcile", code: "container_checkpoint_failed", terminal: false });
      expect((await attempts(a))[0]).toMatchObject({ stage: "validating", container_ids: [] });
      await advanceSlot();
      expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
      expect(fake.calls.create).toBe(1);
    });

    it("control read failure at the pre-G1 re-check → fail closed, G1 0", async () => {
      await scheduled();
      let reads = 0;
      const fake = fakeProvider();
      const run = await invoke(fake.provider, {
        hook: async (req, next) => (table(req, "publishing_runtime_control", "GET") && ++reads >= 4 ? injected500() : next()),
      });
      expect(run.summary).toMatchObject({ result: "failed_known", code: "runtime_disabled_before_create" });
      expect(fake.calls.create).toBe(0);
    });

    it("Vault failure → credential_unavailable, provider 0", async () => {
      const a = await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (rpc(req, "read_social_account_vault_secret") ? injected500() : next()) });
      expect(run.summary).toMatchObject({ outcome: "credential_unavailable", terminal: true });
      expect(fake.calls).toMatchObject({ create: 0, status: 0, publish: 0 });
      expect((await pub(a)).error_code).toBe("credential_unavailable");
    });

    it("G2 poll-count persistence failure → observability only; polling result still applied", async () => {
      const a = await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (attemptPatch(req, "status_poll_count") ? injected500() : next()) });
      expect(run.summary.result).toBe("dry_run_container_ready");
      expect((await attempts(a))[0].status_poll_count).toBe(0);
    });

    it("publish_requested persistence failure → deferred (container_ready kept), G3 0; the next slot publishes exactly once", async () => {
      await setControl(true, "publish");
      const a = await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, { hook: async (req, next) => (attemptPatch(req, '"publish_requested"') ? injected500() : next()) });
      expect(run.summary).toMatchObject({ result: "deferred", code: "checkpoint" });
      expect(fake.calls.publish).toBe(0);
      expect((await attempts(a))[0].stage).toBe("container_ready");
      await advanceSlot();
      expect((await invoke(fake.provider)).summary.result).toBe("published");
      expect(fake.calls.publish).toBe(1);
    });

    it("publication final persistence failure → pending_reconcile carrying the media id (audit); restart finalizes; G3 total 1", async () => {
      await setControl(true, "publish");
      const a = await scheduled();
      const fake = fakeProvider();
      const run = await invoke(fake.provider, {
        hook: async (req, next) => (table(req, "publications", "PATCH") && req.body.includes('"status":"published"') ? injected500() : next()),
      });
      expect(run.summary).toMatchObject({ result: "pending_reconcile", code: "publication_published_persistence_failed" });
      const audit = (await admin.from("audit_logs").select("metadata").eq("entity_id", a).eq("action", "publication.runtime_final")).data ?? [];
      expect((audit[0].metadata as Record<string, unknown>).mediaId).toBe(MEDIA);
      await advanceSlot();
      await invoke(fake.provider);
      expect(await pub(a)).toMatchObject({ status: "published", external_publication_id: MEDIA });
      expect(fake.calls.publish).toBe(1);
    });

    it("provider throws during G1 → internal_error (lease completed); marker kept; restart never re-dispatches", async () => {
      const a = await scheduled();
      const fake = fakeProvider({
        create: () => {
          throw new Error("adapter bug");
        },
      });
      const run = await invoke(fake.provider);
      expect(run.summary).toMatchObject({ outcome: "engine_error", leaseCompleted: true });
      expect((await leases())[0].outcome).toBe("internal_error");
      expect((await attempts(a))[0].container_create_requested_at).not.toBeNull();
      await advanceSlot();
      await invoke(fake.provider);
      expect(fake.calls.create).toBe(1);
    });
  });

  // ===========================================================================
  // 8. CONTROL RACES (I10)
  // ===========================================================================
  describe("control races (flip right after a durable boundary)", () => {
    type Race = { label: string; mode: "dry_run" | "publish"; to: "off" | "dry_run" | "publish"; after: (req: Req) => boolean; expect: Partial<RuntimeSummary>; create: number; publish: number; stage?: PublicationAttemptStage | null };
    const races: Race[] = [
      { label: "after lease", mode: "dry_run", to: "off", after: (r) => rpc(r, "acquire_runtime_slot_lease"), expect: { outcome: "no_work" }, create: 0, publish: 0, stage: null },
      { label: "after claim", mode: "dry_run", to: "off", after: (r) => rpc(r, "claim_runtime_publications"), expect: { outcome: "runtime_disabled_after_selection" }, create: 0, publish: 0, stage: null },
      { label: "after attempt start", mode: "dry_run", to: "off", after: (r) => table(r, "publication_attempts", "POST"), expect: { code: "runtime_disabled_before_create" }, create: 0, publish: 0, stage: "failed" },
      { label: "after the pre-G1 marker", mode: "dry_run", to: "off", after: (r) => attemptPatch(r, "container_create_requested_at"), expect: { code: "runtime_disabled_before_create" }, create: 0, publish: 0, stage: "failed" },
      { label: "after G1 success", mode: "dry_run", to: "off", after: (r) => attemptPatch(r, '"container_created"'), expect: { result: "deferred", code: "runtime_disabled" }, create: 1, publish: 0, stage: "container_created" },
      { label: "after container_ready (publish)", mode: "publish", to: "off", after: (r) => attemptPatch(r, '"container_ready"'), expect: { result: "deferred", code: "runtime_disabled" }, create: 1, publish: 0, stage: "container_ready" },
      { label: "after publish_requested (publish)", mode: "publish", to: "off", after: (r) => attemptPatch(r, '"publish_requested"'), expect: { code: "runtime_disabled_before_publish" }, create: 1, publish: 0, stage: "failed" },
      { label: "mode dry_run → publish after claim", mode: "dry_run", to: "publish", after: (r) => rpc(r, "claim_runtime_publications"), expect: { outcome: "runtime_disabled_after_selection" }, create: 0, publish: 0, stage: null },
      { label: "mode dry_run → publish after attempt start", mode: "dry_run", to: "publish", after: (r) => table(r, "publication_attempts", "POST"), expect: { code: "runtime_disabled_before_create" }, create: 0, publish: 0, stage: "failed" },
      { label: "mode publish → dry_run after container_ready", mode: "publish", to: "dry_run", after: (r) => attemptPatch(r, '"container_ready"'), expect: { result: "deferred", code: "runtime_disabled" }, create: 1, publish: 0, stage: "container_ready" },
    ];
    for (const race of races) {
      it(race.label, async () => {
        await setControl(true, race.mode);
        const a = await scheduled();
        let flipped = false;
        const fake = fakeProvider();
        const run = await invoke(fake.provider, {
          hook: async (req, next) => {
            const res = await next();
            if (!flipped && race.after(req)) {
              flipped = true;
              if (race.to === "off") await setControl(false);
              else await setControl(true, race.to);
            }
            return res;
          },
        });
        expect(flipped).toBe(true);
        expect(run.summary).toMatchObject(race.expect);
        expect(fake.calls.create).toBe(race.create);
        expect(fake.calls.publish).toBe(race.publish);
        const list = await attempts(a);
        expect(list[0]?.stage ?? null).toBe(race.stage);
        // A later invocation never adds an unauthorized irreversible action for this publication.
        await setControl(true, race.mode);
        await advanceSlot();
        const later = fakeProvider();
        await invoke(later.provider);
        if (race.stage === "failed") expect(later.calls.create + later.calls.publish).toBe(0);
      });
    }

    it("control OFF between G2 polls → polling stops; state resumable", async () => {
      const a = await scheduled();
      let n = 0;
      const fake = fakeProvider({
        status: async () => {
          n += 1;
          if (n === 1) await setControl(false);
          return { ok: true, status: "IN_PROGRESS" };
        },
      });
      const run = await invoke(fake.provider);
      expect(run.summary).toMatchObject({ result: "deferred", code: "runtime_disabled" });
      expect(fake.calls.status).toBe(1);
      expect((await attempts(a))[0].stage).toBe("container_created");
    });
  });

  // ===========================================================================
  // 9. PROVIDER AMBIGUITY WITH RESTART (I6, I7, I12)
  // ===========================================================================
  describe("provider ambiguity survives restart", () => {
    const g1: Array<[string, MediaContainerCreateResult]> = [
      ["timeout", unknown("transport_error")],
      ["transport", unknown("transport_error")],
      ["5xx", unknown("container_create_failed", 503)],
      ["malformed 2xx", unknown("malformed_response", 200)],
    ];
    for (const [label, result] of g1) {
      it(`G1 ${label} → one G1 maximum, marker retained, no recovery retry`, async () => {
        const a = await scheduled();
        const fake = fakeProvider({ create: () => result });
        expect((await invoke(fake.provider)).summary).toMatchObject({ result: "g1_outcome_unknown" });
        expect((await attempts(a))[0].container_create_requested_at).not.toBeNull();
        for (let i = 0; i < 2; i += 1) {
          await advanceSlot();
          await invoke(fake.provider);
        }
        expect(fake.calls.create).toBe(1);
      });
    }
    const g3: Array<[string, MediaPublishResult]> = [
      ["timeout", unknown("timeout")],
      ["transport", unknown("transport_error")],
      ["5xx", unknown("publish_outcome_unknown", 502)],
      ["malformed success", unknown("malformed_response", 200)],
    ];
    for (const [label, result] of g3) {
      it(`G3 ${label} → one G3 maximum, outcome_unknown, no recovery retry`, async () => {
        await setControl(true, "publish");
        const a = await scheduled();
        const fake = fakeProvider({ publish: () => result });
        expect((await invoke(fake.provider)).summary).toMatchObject({ result: "publish_outcome_unknown" });
        expect((await attempts(a))[0].stage).toBe("outcome_unknown");
        for (let i = 0; i < 2; i += 1) {
          await advanceSlot();
          await invoke(fake.provider);
        }
        expect(fake.calls.publish).toBe(1);
        expect((await pub(a)).status).toBe("publishing"); // operator resolution required
      });
    }
  });

  // ===========================================================================
  // 10. BUDGET BOUNDARIES (fake clock; DB time untouched)
  // ===========================================================================
  describe("budget boundaries", () => {
    // Constant clock: remaining = 25 000 − t for the whole run.
    const constant = (remainingMs: number) => {
      const clock = fakeClock();
      clock.state.t = 25_000 - remainingMs;
      return clock;
    };

    for (const [remaining, g1] of [[12_999, 0], [13_000, 1], [13_001, 1]] as const) {
      it(`G1 needs 10 s + 3 s reserve: remaining ${remaining} → G1 ${g1}`, async () => {
        await scheduled();
        const fake = fakeProvider();
        const run = await invoke(fake.provider, { clock: constant(remaining) });
        expect(fake.calls.create).toBe(g1);
        if (!g1) expect(run.summary).toMatchObject({ code: "execution_budget_exhausted" });
      });
    }

    for (const [remaining, g3] of [[10_999, 0], [11_000, 1], [11_001, 1]] as const) {
      it(`G3 needs 8 s + 3 s reserve: remaining ${remaining} → G3 ${g3}`, async () => {
        await setControl(true, "publish");
        const a = await scheduled();
        // Reach container_ready with the G3 budget refused, then resume at the exact threshold.
        const clock1 = fakeClock();
        const tight = fakeProvider({
          status: () => {
            clock1.state.t = 15_000; // remaining 10 s after G2 → G3 refused
            return { ok: true, status: "FINISHED" };
          },
        });
        await invoke(tight.provider, { clock: clock1 });
        expect((await attempts(a))[0].stage).toBe("container_ready");
        await advanceSlot();
        const fake = fakeProvider();
        const run = await invoke(fake.provider, { clock: constant(remaining) });
        expect(fake.calls.publish).toBe(g3);
        expect(run.summary.result).toBe(g3 ? "published" : "deferred");
      });
    }

    it("the budget is re-checked right before G1 dispatch (time spent signing/marking counts)", async () => {
      await scheduled();
      const clock = constant(13_000);
      const fake = fakeProvider();
      const run = await invoke(fake.provider, {
        clock,
        hook: async (req, next) => {
          const res = await next();
          if (attemptPatch(req, "container_create_requested_at")) clock.state.t += 1_000; // slow marker write
          return res;
        },
      });
      expect(fake.calls.create).toBe(0);
      expect(run.summary).toMatchObject({ code: "execution_budget_exhausted" });
    });

    it("slow Vault/G1/G2/DB: every provider call starts with its full timeout + reserve and the run ends ≤ 25 s", async () => {
      await scheduled();
      const clock = fakeClock();
      const starts: Array<{ kind: string; remaining: number; timeoutMs: number }> = [];
      const consume = (kind: string, timeoutMs = 0) => {
        starts.push({ kind, remaining: 25_000 - clock.state.t, timeoutMs });
        clock.state.t += timeoutMs; // worst case: every call uses its whole timeout
      };
      const provider: StagedMediaPublisher = {
        async createMediaContainer(input) {
          consume("g1", input.timeoutMs);
          return { ok: true, containerId: CONTAINER };
        },
        async getMediaContainerStatus(input) {
          consume("g2", input.timeoutMs);
          return { ok: true, status: "IN_PROGRESS" };
        },
        async publishMediaContainer(input) {
          consume("g3", input.timeoutMs);
          return { ok: true, mediaId: MEDIA };
        },
        async listRecentMedia() {
          return { ok: true, items: [] };
        },
      };
      const run = await invoke(provider, {
        clock,
        hook: async (req, next) => {
          clock.state.t += rpc(req, "read_social_account_vault_secret") ? 900 : 200; // slow Vault and DB
          return next();
        },
      });
      expect(starts.length).toBeGreaterThan(0);
      for (const s of starts) expect(s.remaining - s.timeoutMs, s.kind).toBeGreaterThanOrEqual(3_000);
      expect(run.summary.result).toBe("deferred");
      const final = run.events.at(-1)!;
      expect(final.elapsedMs as number).toBeLessThanOrEqual(25_000);
    });
  });

  // ===========================================================================
  // 11/12. LEASE COMPLETION + OBSERVABILITY
  // ===========================================================================
  it("LEASE: no_work, deferred and terminal runs each complete their lease exactly once", async () => {
    const complete: string[] = [];
    const hook: Hook = async (req, next) => {
      if (rpc(req, "complete_runtime_slot_lease")) complete.push(req.body);
      return next();
    };
    await invoke(fakeProvider().provider, { hook }); // no_work
    await advanceSlot();
    await scheduled();
    await invoke(fakeProvider({ status: () => ({ ok: true, status: "IN_PROGRESS" }) }).provider, { hook }); // deferred
    await advanceSlot();
    await invoke(fakeProvider().provider, { hook }); // resume → terminal
    expect(complete).toHaveLength(3);
    const outcomes = (await leases()).map((l) => l.outcome).sort();
    expect(outcomes).toEqual(["deferred_not_ready", "dry_run_container_ready", "no_work"]);
  });

  it("OBSERVABILITY: logs + audit answer who/what/which boundary for a failure path and a publish path; no secrets", async () => {
    // Failure path: G1 succeeded, container checkpoint failed.
    const a = await scheduled();
    const fail = await invoke(fakeProvider().provider, { hook: async (req, next) => (attemptPatch(req, '"container_created"') ? injected500() : next()) });
    const ev = (name: string) => fail.events.find((e) => e.event === name);
    expect(ev("lease")).toMatchObject({ runId: fail.summary.runId, logicalSlot: fail.summary.logicalSlot });
    expect(ev("work_selected")).toMatchObject({ kind: "claim", publicationId: a });
    expect(ev("g1_dispatch")).toBeDefined();
    expect(ev("g1_result")).toMatchObject({ class: "success", persisted: false });
    expect(ev("final")).toMatchObject({ result: "pending_reconcile", terminal: false, leaseCompleted: true });
    const [attempt] = await attempts(a);
    expect(attempt.container_create_requested_at).not.toBeNull(); // G1 may have been dispatched
    expect(attempt.last_run_id).toBe(fail.summary.runId);

    // Publish path: G2 polls, publish_requested, G3 dispatch, media id, lease completion.
    await closeInflight();
    await advanceSlot();
    await setControl(true, "publish");
    const b = await scheduled();
    const ok = await invoke(fakeProvider().provider);
    const names = ok.names;
    expect(names).toEqual(expect.arrayContaining(["lease", "work_selected", "g1_dispatch", "g1_result", "g2_poll", "publish_requested", "g3_dispatch", "g3_result", "lease_complete", "final"]));
    expect(ok.events.find((e) => e.event === "g3_result")).toMatchObject({ class: "success", mediaId: MEDIA });
    expect(ok.events.find((e) => e.event === "lease_complete")).toMatchObject({ outcome: "published", completed: true });
    const audit = (await admin.from("audit_logs").select("metadata").eq("entity_id", b).eq("action", "publication.runtime_final")).data ?? [];
    expect(audit[0].metadata).toMatchObject({ runId: ok.summary.runId, workKind: "claim", mediaId: MEDIA, terminal: true });
    for (const secret of [FAKE_TOKEN, SIGNED_URL, SERVICE_KEY]) {
      expect(fail.logs.join("\n") + ok.logs.join("\n")).not.toContain(secret);
    }
  });
});
