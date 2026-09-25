import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MediaContainerCreateResult, MediaContainerStatusResult, MediaPublishResult, StagedMediaPublisher } from "@/lib/social/provider";
import { runScheduledPublishingRuntime, type RuntimeDeps } from "@/server/runtime/scheduled-publishing";
import type { ContentVariant, SocialAccount } from "@/types/database";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.36H2 — the hardened (leased, resumable, single-flight) Level-6
 * runtime against the LOCAL schema with H1 RPCs and a scripted fake
 * provider. No Meta call, no hosted Vault. A fake monotonic clock drives the
 * runtime budget so multi-invocation resume scenarios are deterministic.
 * Synthetic ids only.
 */

const FAKE_TOKEN = "IGAAfakeHardenedRuntimeToken0000000001";
const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-H2-0001";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ON_ENV = { MARQOS_INSTAGRAM_STAGED_PUBLISHING: "enabled", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const MIN = 60 * 1000;
const SLOT_MS = 5 * MIN;
const CONTAINER = "17900000000000000701";
const MEDIA = "18000000000000000701";

const failure = (fields: Partial<{ outcome: "rejected" | "unknown"; code: string; httpStatus: number | null }> = {}) => ({
  ok: false as const,
  code: fields.code ?? "transport_error",
  message: "fixture",
  httpStatus: fields.httpStatus ?? null,
  providerCode: null,
  providerSubcode: null,
  fbtraceId: null,
  ...(fields.outcome ? { outcome: fields.outcome } : {}),
});

type Script = {
  create?: () => MediaContainerCreateResult;
  status?: (n: number) => Promise<MediaContainerStatusResult> | MediaContainerStatusResult;
  publish?: () => MediaPublishResult;
};

/** One fake per scenario: its counters accumulate ACROSS invocations (provider-total evidence). */
function fakeProvider(script: Script = {}) {
  const calls = { create: 0, status: 0, publish: 0, recent: 0 };
  const provider: StagedMediaPublisher = {
    async createMediaContainer() {
      calls.create += 1;
      return script.create ? script.create() : { ok: true, containerId: CONTAINER };
    },
    async getMediaContainerStatus() {
      calls.status += 1;
      return script.status ? script.status(calls.status) : { ok: true, status: "FINISHED" };
    },
    async publishMediaContainer() {
      calls.publish += 1;
      return script.publish ? script.publish() : { ok: true, mediaId: MEDIA };
    },
    async listRecentMedia() {
      calls.recent += 1;
      return { ok: true, items: [] };
    },
  };
  return { provider, calls };
}

/** Deterministic budget clock: sleeps advance it; `advance` simulates slow provider calls. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

async function awayFromSlotBoundary() {
  const into = Date.now() % SLOT_MS;
  if (into > SLOT_MS - 25_000) await new Promise((r) => setTimeout(r, SLOT_MS - into + 2_000));
  else if (into < 2_000) await new Promise((r) => setTimeout(r, 2_000 - into));
}

describe.skipIf(!hasLocalSupabase)("MVP-5.36H2 hardened runtime engine (local DB, fake provider)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, SERVICE_KEY) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let contentId: string;
  let allowlisted: SocialAccount;
  const vaultIds: string[] = [];

  const setControl = async (enabled: boolean, mode: "dry_run" | "publish" = "dry_run") => {
    const { error } = await admin.from("publishing_runtime_control").upsert({ key: "instagram_scheduled_publishing", enabled, mode });
    if (error) throw new Error(`control: ${error.message}`);
  };
  const removeControl = () => admin.from("publishing_runtime_control").delete().eq("key", "instagram_scheduled_publishing");
  /** Each natural invocation owns a slot lease; clearing leases simulates the next scheduler slot. */
  const newSlot = () => admin.from("publishing_runtime_slot_lease").delete().eq("runtime_key", "instagram_scheduled_publishing");
  const leases = async () => (await admin.from("publishing_runtime_slot_lease").select("*").eq("runtime_key", "instagram_scheduled_publishing")).data ?? [];

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
      .insert({ content_id: contentId, workspace_id: workspaceId, version_number: Math.floor(Math.random() * 1e9) + 1, generation_method: "human", content_payload: { text: "h2" } })
      .select()
      .single();
    const { data: row, error } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "H2 fixture" })
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
        social_account_id: allowlisted.id,
        status: "scheduled",
        scheduled_at: new Date(Date.now() + offsetMs).toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`publication: ${error?.message}`);
    return data.id;
  }

  const pub = async (id: string) => (await admin.from("publications").select("*").eq("id", id).single()).data!;
  const attempts = async (id: string) => (await admin.from("publication_attempts").select("*").eq("publication_id", id).order("attempt_number")).data ?? [];

  /** One natural invocation with its own budget clock and log capture. */
  async function invoke(provider: StagedMediaPublisher, extra: Partial<RuntimeDeps> = {}, clock = fakeClock()) {
    const logs: string[] = [];
    const summary = await runScheduledPublishingRuntime({
      client: admin,
      env: ON_ENV,
      provider,
      signMediaUrl: async () => SIGNED_URL,
      now: clock.now,
      sleep: clock.sleep,
      log: (line) => logs.push(line),
      ...extra,
    });
    const events = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    return { summary, logs, events, names: events.map((e) => e.event as string) };
  }

  /** IN_PROGRESS forever, each poll costing 500 ms of budget clock → the invocation defers. */
  const slowContainer = (clock: ReturnType<typeof fakeClock>) => async (): Promise<MediaContainerStatusResult> => {
    clock.advance(500);
    return { ok: true, status: "IN_PROGRESS" };
  };

  beforeAll(async () => {
    await removeControl();
    await newSlot();
    editor = await createSignedInTestUser(admin);
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "Runtime H2", p_slug: `runtime-h2-${Date.now()}` });
    workspaceId = ws!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "C" }).select().single();
    contentId = content!.id;
    const { data: secret } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "h2 test" });
    vaultIds.push(secret as string);
    const { data: acct, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "17849990000000102",
        account_name: "h2 fixture",
        status: "connected",
        vault_secret_id: secret as string,
        metadata: { credentialKind: "real", instagramScopedUserId: "38281000000010201", instagramAppScopedId: "38281000000010201" },
      })
      .select()
      .single();
    if (error || !acct) throw new Error(`account: ${error?.message}`);
    allowlisted = acct;
    await admin.from("publishing_runtime_allowlist").insert({ social_account_id: acct.id, workspace_id: workspaceId });
  });

  beforeEach(async () => {
    await newSlot();
    await closeInflight();
    await setControl(true, "dry_run");
  });

  afterAll(async () => {
    await closeInflight();
    await removeControl();
    await newSlot();
    for (const id of vaultIds) {
      try {
        await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
      } catch {
        // best-effort
      }
    }
    await cleanupTestData(admin, { workspaceIds: [workspaceId].filter(Boolean), userIds: [editor?.userId].filter((id): id is string => Boolean(id)) });
  });

  it("A/B: control missing or env off → no lease, no mutation, no provider", async () => {
    const due = await scheduled();
    const { provider, calls } = fakeProvider();
    await removeControl();
    expect((await invoke(provider)).summary.outcome).toBe("runtime_disabled");
    await setControl(true);
    expect((await invoke(provider, { env: { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY } })).summary.outcome).toBe("env_gate_disabled");
    expect(await leases()).toEqual([]);
    expect(calls).toEqual({ create: 0, status: 0, publish: 0, recent: 0 });
    expect((await pub(due)).status).toBe("scheduled");
  });

  it("C/X: dry-run fast path — one lease, one claim, one attempt, G1 = 1, G2 ready, G3 = 0; lease completed once", async () => {
    await awayFromSlotBoundary();
    const id = await scheduled();
    const { provider, calls } = fakeProvider();
    const run = await invoke(provider);
    expect(run.summary).toMatchObject({ outcome: "completed", workKind: "claim", result: "dry_run_container_ready", claimed: 1, vaultReads: 1, terminal: true, leaseCompleted: true });
    expect(calls).toEqual({ create: 1, status: 1, publish: 0, recent: 0 });
    expect(await pub(id)).toMatchObject({ status: "failed", error_code: "dry_run_container_ready", external_publication_id: null, published_at: null });
    const [attempt] = await attempts(id);
    expect(attempt).toMatchObject({ stage: "failed", error_code: "dry_run_container_ready", external_media_id: null, status_poll_count: 1, last_run_id: run.summary.runId });
    expect(attempt.container_create_requested_at).not.toBeNull();
    expect(attempt.container_created_at).not.toBeNull();
    expect(run.names).not.toContain("g3_dispatch");
    const [lease] = await leases();
    expect(lease).toMatchObject({ run_id: run.summary.runId, outcome: "dry_run_container_ready", duplicate_count: 0 });
    expect(lease.completed_at).not.toBeNull();

    // D/X: a same-slot duplicate is suppressed before any work and cannot overwrite the outcome.
    const dup = await invoke(provider);
    expect(dup.summary).toMatchObject({ outcome: "duplicate_suppressed", reconciled: 0, claimed: 0, vaultReads: 0, leaseCompleted: false });
    expect(dup.names).toContain("scheduler_duplicate_suppressed");
    expect(dup.names).not.toContain("reconcile");
    expect(calls).toEqual({ create: 1, status: 1, publish: 0, recent: 0 });
    const [after] = await leases();
    expect(after).toMatchObject({ run_id: run.summary.runId, outcome: "dry_run_container_ready", duplicate_count: 1 });
  }, 60_000);

  it("E: overlapping duplicate deliveries → exactly one worker; the other is suppressed provider-free", async () => {
    await awayFromSlotBoundary();
    await scheduled();
    const { provider, calls } = fakeProvider();
    const [a, b] = await Promise.all([invoke(provider), invoke(provider)]);
    const outcomes = [a.summary.outcome, b.summary.outcome].sort();
    expect(outcomes).toEqual(["completed", "duplicate_suppressed"]);
    const dup = a.summary.outcome === "duplicate_suppressed" ? a : b;
    expect(dup.summary).toMatchObject({ reconciled: 0, claimed: 0, vaultReads: 0 });
    expect(calls.create).toBe(1);
    expect((await leases())[0].duplicate_count).toBe(1);
  }, 60_000);

  it("F/G/H: slow container defers; next slot RESUMES (G1 stays 1) and never claims #2 while #1 is in flight", async () => {
    const first = await scheduled(-20 * MIN);
    const second = await scheduled(-10 * MIN);
    const clock1 = fakeClock();
    const slow = fakeProvider({ status: slowContainer(clock1) });
    const inv1 = await invoke(slow.provider, {}, clock1);
    expect(inv1.summary).toMatchObject({ workKind: "claim", result: "deferred", code: "not_ready", terminal: false, attemptStage: "container_created" });
    expect(inv1.names).toContain("deferred");
    expect((await pub(first)).status).toBe("publishing");
    expect((await pub(second)).status).toBe("scheduled");
    const [pending] = await attempts(first);
    expect(pending.stage).toBe("container_created");
    expect(pending.status_poll_count).toBe(slow.calls.status);
    expect(inv1.summary.providerCalls).toMatchObject({ create: 1, publish: 0 });

    await newSlot();
    const ready = fakeProvider(); // FINISHED
    const inv2 = await invoke(ready.provider);
    expect(inv2.summary).toMatchObject({ workKind: "resume", publicationId: first, result: "dry_run_container_ready", claimed: 0 });
    expect(inv2.names).toContain("attempt_resumed");
    expect(inv2.names).not.toContain("g1_dispatch");
    expect(slow.calls.create + ready.calls.create).toBe(1); // G1 total across invocations
    expect(ready.calls.publish).toBe(0);
    expect(await attempts(first)).toHaveLength(1);
    expect((await pub(second)).status).toBe("scheduled");

    await newSlot();
    const inv3 = await invoke(fakeProvider().provider);
    expect(inv3.summary).toMatchObject({ workKind: "claim", publicationId: second });
  });

  it("I: resumed container_ready in dry_run terminates without G3", async () => {
    await setControl(true, "publish");
    const id = await scheduled();
    const clock = fakeClock();
    const first = fakeProvider({
      status: () => {
        clock.advance(18_000); // leaves < 8 s G3 + 3 s reserve
        return { ok: true, status: "FINISHED" };
      },
    });
    const inv1 = await invoke(first.provider, {}, clock);
    expect(inv1.summary).toMatchObject({ result: "deferred", code: "g3_budget", attemptStage: "container_ready" });
    await setControl(true, "dry_run");
    await newSlot();
    const second = fakeProvider();
    const inv2 = await invoke(second.provider);
    expect(inv2.summary).toMatchObject({ workKind: "resume", result: "dry_run_container_ready" });
    expect(first.calls.publish + second.calls.publish).toBe(0);
    expect(second.calls.create + second.calls.status).toBe(0);
    expect((await pub(id)).error_code).toBe("dry_run_container_ready");
  });

  describe("G1 classification (never auto-retried)", () => {
    const cases: Array<[string, MediaContainerCreateResult, string, string]> = [
      ["J structured rejection", failure({ outcome: "rejected", code: "OAuthException", httpStatus: 400 }), "failed_known", "container_create_failed"],
      ["K timeout", failure({ outcome: "unknown", code: "transport_error" }), "g1_outcome_unknown", "container_create_outcome_unknown"],
      ["L 5xx", failure({ outcome: "unknown", code: "container_create_failed", httpStatus: 503 }), "g1_outcome_unknown", "container_create_outcome_unknown"],
      ["M malformed 2xx", failure({ outcome: "unknown", code: "malformed_response", httpStatus: 200 }), "g1_outcome_unknown", "container_create_outcome_unknown"],
      ["M' unclassified (no outcome) ⇒ unknown", failure({ code: "weird" }), "g1_outcome_unknown", "container_create_outcome_unknown"],
    ];
    for (const [label, result, kind, code] of cases) {
      it(label, async () => {
        const id = await scheduled();
        const fake = fakeProvider({ create: () => result });
        const inv1 = await invoke(fake.provider);
        expect(inv1.summary).toMatchObject({ result: kind, code, terminal: true });
        const [attempt] = await attempts(id);
        expect(attempt).toMatchObject({ stage: "failed", error_code: code, container_ids: [] });
        expect(attempt.container_create_requested_at).not.toBeNull(); // dispatch evidence
        expect((await pub(id)).status).toBe("failed");
        await newSlot();
        const inv2 = await invoke(fake.provider);
        expect(inv2.summary.outcome).toBe("no_work");
        expect(fake.calls).toMatchObject({ create: 1, status: 0, publish: 0 });
      });
    }
  });

  it("O: control OFF during G2 → polling stops, container_created preserved (resumable), G3 = 0", async () => {
    await setControl(true, "publish");
    const id = await scheduled();
    const fake = fakeProvider({
      status: async () => {
        await setControl(false);
        return { ok: true, status: "IN_PROGRESS" };
      },
    });
    const run = await invoke(fake.provider);
    expect(run.summary).toMatchObject({ result: "deferred", code: "runtime_disabled", terminal: false });
    expect(fake.calls).toMatchObject({ create: 1, status: 1, publish: 0 });
    expect((await attempts(id)).map((a) => a.stage)).toEqual(["container_created"]);
    expect((await pub(id)).status).toBe("publishing");
  });

  it("P: G2 ERROR / EXPIRED → known failure", async () => {
    for (const [status, code] of [["ERROR", "container_error"], ["EXPIRED", "container_expired"]] as const) {
      await newSlot();
      const id = await scheduled();
      const fake = fakeProvider({ status: () => ({ ok: true, status }) });
      const run = await invoke(fake.provider);
      expect(run.summary).toMatchObject({ result: "failed_known", code });
      expect(await pub(id)).toMatchObject({ status: "failed", error_code: code });
    }
  });

  it("Q: unexpected G2 PUBLISHED → outcome_unknown anomaly; publication stays publishing and blocks new claims; G3 = 0", async () => {
    await setControl(true, "publish");
    const id = await scheduled();
    const fake = fakeProvider({ status: () => ({ ok: true, status: "PUBLISHED" }) });
    const run = await invoke(fake.provider);
    expect(run.summary).toMatchObject({ result: "container_outcome_unknown", code: "container_state_anomaly" });
    expect((await attempts(id))[0]).toMatchObject({ stage: "outcome_unknown", error_code: "container_state_anomaly" });
    expect((await pub(id)).status).toBe("publishing");
    await scheduled();
    await newSlot();
    expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
    expect(fake.calls.publish).toBe(0);
  });

  it("R/S/T: publish — insufficient G3 budget defers at container_ready; the next slot resumes and publishes exactly once", async () => {
    await setControl(true, "publish");
    const id = await scheduled();
    const clock = fakeClock();
    const fake = fakeProvider({
      status: () => {
        clock.advance(18_000);
        return { ok: true, status: "FINISHED" };
      },
    });
    const inv1 = await invoke(fake.provider, {}, clock);
    expect(inv1.summary).toMatchObject({ result: "deferred", code: "g3_budget" });
    expect(inv1.names).not.toContain("publish_requested");
    expect(fake.calls.publish).toBe(0);

    await newSlot();
    const inv2 = await invoke(fake.provider);
    expect(inv2.summary).toMatchObject({ workKind: "resume", result: "published", terminal: true });
    expect(inv2.names.indexOf("publish_requested")).toBeLessThan(inv2.names.indexOf("g3_dispatch"));
    expect(fake.calls).toMatchObject({ create: 1, publish: 1 });
    expect((await attempts(id))[0]).toMatchObject({ stage: "published", external_media_id: MEDIA });
    expect(await pub(id)).toMatchObject({ status: "published", external_publication_id: MEDIA });
  });

  it("U: G3 structured rejection → known failed; never retried", async () => {
    await setControl(true, "publish");
    const id = await scheduled();
    const fake = fakeProvider({ publish: () => failure({ outcome: "rejected", code: "OAuthException", httpStatus: 400 }) as MediaPublishResult });
    const run = await invoke(fake.provider);
    expect(run.summary).toMatchObject({ result: "failed_known", code: "publish_rejected" });
    expect(await pub(id)).toMatchObject({ status: "failed", error_code: "publish_rejected" });
    await newSlot();
    await invoke(fake.provider);
    expect(fake.calls.publish).toBe(1);
  });

  it("V: G3 timeout → publish_outcome_unknown; later invocations never G3 again", async () => {
    await setControl(true, "publish");
    const id = await scheduled();
    const fake = fakeProvider({ publish: () => failure({ outcome: "unknown", code: "timeout" }) as MediaPublishResult });
    expect((await invoke(fake.provider)).summary).toMatchObject({ result: "publish_outcome_unknown" });
    expect((await attempts(id))[0].stage).toBe("outcome_unknown");
    await newSlot();
    expect((await invoke(fake.provider)).summary.outcome).toBe("no_work");
    expect(fake.calls.publish).toBe(1);
  });

  it("W: crash-like publish_requested is never resumed; the reconciler marks it outcome_unknown; G3 = 0", async () => {
    await setControl(true, "publish");
    const id = await scheduled();
    await admin.from("publications").update({ status: "publishing" }).eq("id", id);
    const old = new Date(Date.now() - 30 * MIN).toISOString();
    await admin.from("publication_attempts").insert({
      workspace_id: workspaceId,
      publication_id: id,
      provider: "instagram",
      stage: "publish_requested",
      container_ids: [CONTAINER],
      container_created_at: old,
      started_at: old,
      updated_at: old,
    });
    const fake = fakeProvider();
    const run = await invoke(fake.provider, { staleSeconds: 60 });
    const reconcile = run.events.find((e) => e.event === "reconcile") as { rows: Array<{ publicationId: string; action: string }> };
    expect(reconcile.rows.find((r) => r.publicationId === id)?.action).toBe("marked_outcome_unknown");
    expect(run.summary).toMatchObject({ outcome: "no_work", vaultReads: 0 });
    expect(fake.calls).toEqual({ create: 0, status: 0, publish: 0, recent: 0 });
    expect((await attempts(id))[0].stage).toBe("outcome_unknown");
  });

  it("Y: a budget too small for G1 + reserve never starts G1; durable state closed known-not-published", async () => {
    const id = await scheduled();
    const fake = fakeProvider();
    const run = await invoke(fake.provider, { budget: { totalMs: 12_000 } });
    expect(run.summary).toMatchObject({ result: "failed_known", code: "execution_budget_exhausted" });
    expect(fake.calls.create).toBe(0);
    const [attempt] = await attempts(id);
    expect(attempt.container_create_requested_at).toBeNull();
    expect((await pub(id)).status).toBe("failed");
  });

  it("logs: runId + logicalSlot on every post-lease line; no credential, signed URL or service key", async () => {
    await scheduled();
    const run = await invoke(fakeProvider().provider);
    const leaseIdx = run.names.indexOf("lease");
    for (const e of run.events) expect(e.runId).toBe(run.summary.runId);
    for (const e of run.events.slice(leaseIdx)) expect(e.logicalSlot).toBe(run.summary.logicalSlot);
    for (const secret of [FAKE_TOKEN, SIGNED_URL, SERVICE_KEY]) expect(run.logs.join("\n")).not.toContain(secret);
    const final = run.events.at(-1)!;
    expect(final).toMatchObject({ event: "final", workKind: "claim", terminal: true, providerCalls: { create: 1, status: 1, publish: 0 } });
    expect(typeof final.remainingMs).toBe("number");
  });
});
