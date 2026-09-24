import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ContentVariant, Database, PublicationAttemptStage, SocialAccount } from "@/types/database";

import { anonKey, cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.36H1 — database foundation for the hardened Level-6 runtime (H0
 * Option C): scheduler slot lease, resumable attempt metadata, lease-aware
 * single-flight claim (v3), resume selection and the resumability-aware
 * reconciler (v2). Local Supabase only; no provider, no Vault. Synthetic ids.
 *
 * The runtime control is a singleton and the lease is keyed by the DB-clock
 * slot; this file owns both while it runs (files run sequentially) and
 * removes the control row and its lease rows afterwards.
 */

const MIN = 60 * 1000;
const SLOT_MS = 5 * MIN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runId = () => crypto.randomUUID();

/** Keep multi-call same-slot assertions away from a 5-minute boundary (local host ≈ DB clock). */
async function awayFromSlotBoundary() {
  const into = Date.now() % SLOT_MS;
  if (into > SLOT_MS - 20_000) await sleep(SLOT_MS - into + 2_000);
  else if (into < 2_000) await sleep(2_000 - into);
}

describe.skipIf(!hasLocalSupabase)("MVP-5.36H1 runtime hardening RPCs (local DB)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const anon = hasLocalSupabase ? createClient<Database>(supabaseUrl!, anonKey!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let contentId: string;
  let allowlisted: SocialAccount;
  let notAllowlisted: SocialAccount;

  async function setControl(enabled: boolean, mode: "dry_run" | "publish" = "dry_run") {
    const { error } = await admin.from("publishing_runtime_control").upsert({ key: "instagram_scheduled_publishing", enabled, mode });
    if (error) throw new Error(`control: ${error.message}`);
  }
  const removeControl = () => admin.from("publishing_runtime_control").delete().eq("key", "instagram_scheduled_publishing");
  const clearLeases = () => admin.from("publishing_runtime_slot_lease").delete().eq("runtime_key", "instagram_scheduled_publishing");

  async function acquire(id: string) {
    const { data, error } = await admin.rpc("acquire_runtime_slot_lease", { p_run_id: id });
    if (error) throw new Error(`acquire: ${error.message}`);
    return data![0];
  }
  async function complete(id: string, outcome = "completed_test") {
    const { data, error } = await admin.rpc("complete_runtime_slot_lease", { p_run_id: id, p_outcome: outcome });
    if (error) throw new Error(`complete: ${error.message}`);
    return data![0];
  }
  const resume = async (id: string) => {
    const { data, error } = await admin.rpc("select_runtime_resume", { p_run_id: id });
    if (error) throw new Error(`resume: ${error.message}`);
    return data ?? [];
  };
  const claim = async (id: string) => {
    const { data, error } = await admin.rpc("claim_runtime_publications", { p_cap: 1, p_run_id: id });
    if (error) throw new Error(`claim: ${error.message}`);
    return data ?? [];
  };
  const leaseRows = async () =>
    (await admin.from("publishing_runtime_slot_lease").select("*").eq("runtime_key", "instagram_scheduled_publishing").order("acquired_at")).data ?? [];

  async function account(externalId: string, allow: boolean): Promise<SocialAccount> {
    const { data, error } = await admin
      .from("social_accounts")
      .insert({ workspace_id: workspaceId, platform: "instagram", external_account_id: externalId, account_name: "h1 fixture", status: "connected", metadata: { credentialKind: "real" } })
      .select()
      .single();
    if (error || !data) throw new Error(`account: ${error?.message}`);
    if (allow) {
      const { error: allowError } = await admin.from("publishing_runtime_allowlist").insert({ social_account_id: data.id, workspace_id: workspaceId });
      if (allowError) throw new Error(`allowlist: ${allowError.message}`);
    }
    return data;
  }

  async function variant(): Promise<ContentVariant> {
    const { data: version } = await admin
      .from("content_versions")
      .insert({ content_id: contentId, workspace_id: workspaceId, version_number: Math.floor(Math.random() * 1e9) + 1, generation_method: "human", content_payload: { text: "h1" } })
      .select()
      .single();
    const { data: row, error } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "H1 fixture" })
      .select()
      .single();
    if (error || !row) throw new Error(`variant: ${error?.message}`);
    await admin.from("content_approvals").insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: version!.id, status: "approved", reviewed_at: new Date().toISOString() });
    return row;
  }

  async function scheduled(acct: SocialAccount = allowlisted, offsetMs = -5 * MIN): Promise<string> {
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: (await variant()).id,
        social_account_id: acct.id,
        status: "scheduled",
        scheduled_at: new Date(Date.now() + offsetMs).toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`publication: ${error?.message}`);
    return data.id;
  }

  async function publishing(acct: SocialAccount = allowlisted): Promise<string> {
    const id = await scheduled(acct);
    const { error } = await admin.from("publications").update({ status: "publishing" }).eq("id", id);
    if (error) throw new Error(`publishing: ${error.message}`);
    return id;
  }

  /** A 'publishing' publication whose (only) attempt is at `stage`. */
  async function inflight(
    stage: PublicationAttemptStage,
    fields: Record<string, unknown> = {},
    acct: SocialAccount = allowlisted,
  ): Promise<{ publicationId: string; attemptId: string }> {
    const publicationId = await publishing(acct);
    const containerStages = ["container_created", "container_ready", "publish_requested", "published"];
    const base: Record<string, unknown> = {
      workspace_id: workspaceId,
      publication_id: publicationId,
      provider: "instagram",
      stage,
      ...(containerStages.includes(stage) ? { container_ids: ["17900000000000000901"], container_created_at: new Date(Date.now() - MIN).toISOString() } : {}),
      ...(stage === "published" ? { external_media_id: "18000000000000000901" } : {}),
      ...fields,
    };
    const { data, error } = await admin
      .from("publication_attempts")
      .insert(base as Database["public"]["Tables"]["publication_attempts"]["Insert"])
      .select()
      .single();
    if (error || !data) throw new Error(`attempt: ${error?.message}`);
    return { publicationId, attemptId: data.id };
  }

  const pub = async (id: string) => (await admin.from("publications").select("*").eq("id", id).single()).data!;
  const attempt = async (id: string) => (await admin.from("publication_attempts").select("*").eq("id", id).single()).data!;

  /** Close every non-terminal row of this workspace so each test starts single-flight clean. */
  async function closeInflight() {
    await admin
      .from("publication_attempts")
      .update({ stage: "failed", error_code: "test_cleanup" })
      .eq("workspace_id", workspaceId)
      .in("stage", ["validating", "container_created", "container_ready", "publish_requested"]);
    await admin.from("publications").update({ status: "failed", error_code: "test_cleanup" }).eq("workspace_id", workspaceId).eq("status", "publishing");
    await admin.from("publications").delete().eq("workspace_id", workspaceId).eq("status", "scheduled");
  }

  beforeAll(async () => {
    await removeControl();
    await clearLeases();
    editor = await createSignedInTestUser(admin);
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "Runtime H1", p_slug: `runtime-h1-${Date.now()}` });
    workspaceId = ws!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "C" }).select().single();
    contentId = content!.id;
    allowlisted = await account("17849990000000082", true);
    notAllowlisted = await account("17849990000000092", false);
  });

  beforeEach(async () => {
    await clearLeases();
    await setControl(true);
  });

  afterEach(async () => {
    await closeInflight();
  });

  afterAll(async () => {
    await removeControl();
    await clearLeases();
    await cleanupTestData(admin, { workspaceIds: [workspaceId].filter(Boolean), userIds: [editor?.userId].filter((id): id is string => Boolean(id)) });
  });

  // ---------------------------------------------------------------------------
  // Slot lease
  // ---------------------------------------------------------------------------
  describe("acquire / complete", () => {
    it("first acquisition holds the DB-clock 5-minute slot", async () => {
      await awayFromSlotBoundary();
      const a = runId();
      const lease = await acquire(a);
      expect(lease).toMatchObject({ acquired: true, reason: "acquired", holder_run_id: a, mode: "dry_run" });
      expect(new Date(lease.slot_start).getTime() % SLOT_MS).toBe(0);
      expect(await leaseRows()).toHaveLength(1);
      expect(await acquire(a)).toMatchObject({ acquired: true, reason: "already_held" });
    });

    it("same-slot duplicates are suppressed and counted; a completed slot stays suppressed", async () => {
      await awayFromSlotBoundary();
      const holder = runId();
      await acquire(holder);
      expect(await acquire(runId())).toMatchObject({ acquired: false, reason: "duplicate_slot", holder_run_id: holder });
      expect(await acquire(runId())).toMatchObject({ acquired: false, reason: "duplicate_slot" });
      expect((await leaseRows())[0].duplicate_count).toBe(2);
      expect(await complete(holder)).toEqual({ completed: true, reason: "completed" });
      expect(await acquire(runId())).toMatchObject({ acquired: false, reason: "duplicate_slot", holder_run_id: holder });
      const [row] = await leaseRows();
      expect(row).toMatchObject({ run_id: holder, outcome: "completed_test", duplicate_count: 3 });
    });

    it("a parallel acquisition race yields exactly one holder", async () => {
      await awayFromSlotBoundary();
      const ids = Array.from({ length: 6 }, runId);
      const results = await Promise.all(ids.map((id) => acquire(id)));
      const holders = results.filter((r) => r.acquired);
      expect(holders).toHaveLength(1);
      expect(results.filter((r) => r.reason === "duplicate_slot")).toHaveLength(5);
      const rows = await leaseRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ run_id: holders[0].holder_run_id, duplicate_count: 5 });
    });

    it("an uncompleted lease < 60 s old blocks a new slot (overlap); after 60 s a new slot acquires and old evidence stays", async () => {
      await awayFromSlotBoundary();
      const prevSlot = new Date(Math.floor(Date.now() / SLOT_MS) * SLOT_MS - SLOT_MS).toISOString();
      const crashed = runId();
      await admin.from("publishing_runtime_slot_lease").insert({
        runtime_key: "instagram_scheduled_publishing",
        slot_start: prevSlot,
        run_id: crashed,
        acquired_at: new Date(Date.now() - 30_000).toISOString(),
      });
      expect(await acquire(runId())).toMatchObject({ acquired: false, reason: "overlap_active", holder_run_id: crashed });
      expect(await leaseRows()).toHaveLength(1);

      await admin.from("publishing_runtime_slot_lease").update({ acquired_at: new Date(Date.now() - 90_000).toISOString() }).eq("run_id", crashed);
      const next = runId();
      expect(await acquire(next)).toMatchObject({ acquired: true, reason: "acquired" });
      const rows = await leaseRows();
      expect(rows.map((r) => r.run_id)).toEqual([crashed, next]);
      expect(rows[0].completed_at).toBeNull(); // no lease stealing / rewriting
    });

    it("only the holder completes; completion is idempotent and first outcome wins; outcomes are validated", async () => {
      await awayFromSlotBoundary();
      const holder = runId();
      await acquire(holder);
      expect(await complete(runId())).toEqual({ completed: false, reason: "not_holder" });
      expect((await leaseRows())[0].completed_at).toBeNull();
      expect(await complete(holder, "first_outcome")).toEqual({ completed: true, reason: "completed" });
      expect(await complete(holder, "second_outcome")).toEqual({ completed: false, reason: "already_completed" });
      expect((await leaseRows())[0].outcome).toBe("first_outcome");
      const bad = await admin.rpc("complete_runtime_slot_lease", { p_run_id: holder, p_outcome: "Bad Outcome!" });
      expect(bad.error).not.toBeNull();
    });

    it("missing or disabled control cannot lease (no row written)", async () => {
      await removeControl();
      expect(await acquire(runId())).toMatchObject({ acquired: false, reason: "control_off", mode: null });
      await setControl(false);
      expect(await acquire(runId())).toMatchObject({ acquired: false, reason: "control_off" });
      expect(await leaseRows()).toEqual([]);
      await setControl(true, "publish");
      expect(await acquire(runId())).toMatchObject({ acquired: true, mode: "publish" });
    });
  });

  // ---------------------------------------------------------------------------
  // Resume selection
  // ---------------------------------------------------------------------------
  describe("select_runtime_resume", () => {
    it("selects container_created (oldest first) and stamps last_run_id; then container_ready", async () => {
      await awayFromSlotBoundary();
      const holder = runId();
      await acquire(holder);
      const created = await inflight("container_created");
      const [row] = await resume(holder);
      expect(row).toMatchObject({ publication_id: created.publicationId, attempt_id: created.attemptId, stage: "container_created" });
      expect((await attempt(created.attemptId)).last_run_id).toBe(holder);
      await closeInflight();
      const ready = await inflight("container_ready");
      expect((await resume(holder))[0]).toMatchObject({ attempt_id: ready.attemptId, stage: "container_ready" });
    });

    it("never selects validating, publish_requested, terminal, expired, legacy or non-allowlisted attempts", async () => {
      await awayFromSlotBoundary();
      const holder = runId();
      await acquire(holder);
      await inflight("validating");
      await inflight("publish_requested", { container_ids: ["17900000000000000902"] });
      await inflight("failed", { error_code: "x" });
      await inflight("outcome_unknown", { error_code: "x" });
      await inflight("container_created", { container_created_at: new Date(Date.now() - 16 * MIN).toISOString() });
      await inflight("container_created", { container_created_at: null });
      await inflight("container_ready", {}, notAllowlisted);
      expect(await resume(holder)).toEqual([]);
    });

    it("requires the valid lease holder and an enabled control", async () => {
      await awayFromSlotBoundary();
      const holder = runId();
      await acquire(holder);
      const created = await inflight("container_created");
      expect(await resume(runId())).toEqual([]);
      await setControl(false);
      expect(await resume(holder)).toEqual([]);
      await setControl(true);
      await complete(holder);
      expect(await resume(holder)).toEqual([]);
      expect((await attempt(created.attemptId)).last_run_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Claim v3 (lease-aware, single-flight)
  // ---------------------------------------------------------------------------
  describe("claim_runtime_publications v3", () => {
    it("requires the lease; cap must be exactly 1", async () => {
      await awayFromSlotBoundary();
      const due = await scheduled();
      expect(await claim(runId())).toEqual([]);
      expect((await pub(due)).status).toBe("scheduled");
      const holder = runId();
      await acquire(holder);
      for (const cap of [0, 2]) {
        expect((await admin.rpc("claim_runtime_publications", { p_cap: cap, p_run_id: holder })).error).not.toBeNull();
      }
      expect((await claim(holder)).map((r) => r.id)).toEqual([due]);
      expect((await pub(due)).status).toBe("publishing");
    });

    it("two due publications: exactly one claimed; a duplicate invocation cannot claim #2", async () => {
      await awayFromSlotBoundary();
      const first = await scheduled(allowlisted, -20 * MIN);
      const second = await scheduled(allowlisted, -10 * MIN);
      const holder = runId();
      await acquire(holder);
      expect((await claim(holder)).map((r) => r.id)).toEqual([first]);
      const duplicate = runId();
      expect(await acquire(duplicate)).toMatchObject({ acquired: false, reason: "duplicate_slot" });
      expect(await claim(duplicate)).toEqual([]);
      expect(await claim(holder)).toEqual([]); // single-flight: #1 is in flight
      expect((await pub(second)).status).toBe("scheduled");
    });

    it("concurrent claims by the holder never claim more than one", async () => {
      await awayFromSlotBoundary();
      await scheduled(allowlisted, -20 * MIN);
      await scheduled(allowlisted, -10 * MIN);
      const holder = runId();
      await acquire(holder);
      const results = await Promise.all([claim(holder), claim(holder), claim(holder)]);
      expect(results.flat()).toHaveLength(1);
    });

    it("an existing in-flight publication blocks any claim", async () => {
      await awayFromSlotBoundary();
      await inflight("container_created");
      const due = await scheduled();
      const holder = runId();
      await acquire(holder);
      expect(await claim(holder)).toEqual([]);
      expect((await pub(due)).status).toBe("scheduled");
    });

    it("ignores due rows of non-allowlisted accounts", async () => {
      await awayFromSlotBoundary();
      const other = await scheduled(notAllowlisted);
      const holder = runId();
      await acquire(holder);
      expect(await claim(holder)).toEqual([]);
      expect((await pub(other)).status).toBe("scheduled");
    });
  });

  // ---------------------------------------------------------------------------
  // Resume / claim exclusivity
  // ---------------------------------------------------------------------------
  describe("resume/claim exclusivity", () => {
    it("with a resumable item: claim yields nothing, resume yields it (resume precedes claim)", async () => {
      await awayFromSlotBoundary();
      const resumable = await inflight("container_ready");
      const due = await scheduled();
      const holder = runId();
      await acquire(holder);
      expect(await claim(holder)).toEqual([]);
      expect((await resume(holder)).map((r) => r.attempt_id)).toEqual([resumable.attemptId]);
      expect(await claim(holder)).toEqual([]);
      expect((await pub(due)).status).toBe("scheduled");
    });

    it("without a resumable item: resume yields nothing, claim yields one, then neither yields a second item", async () => {
      await awayFromSlotBoundary();
      const due = await scheduled();
      const holder = runId();
      await acquire(holder);
      expect(await resume(holder)).toEqual([]);
      expect((await claim(holder)).map((r) => r.id)).toEqual([due]);
      expect(await resume(holder)).toEqual([]);
      expect(await claim(holder)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Reconciler v2 (provider-free, lease + resumability aware)
  // ---------------------------------------------------------------------------
  describe("reconcile_stale_runtime_publications v2", () => {
    const ids: Record<string, { publicationId: string; attemptId?: string }> = {};
    const old = () => new Date(Date.now() - 30 * MIN).toISOString();

    beforeAll(async () => {
      await closeInflight();
      ids.noAttempt = { publicationId: await publishing() };
      ids.preG1 = await inflight("validating", { started_at: old(), updated_at: old() });
      ids.g1Unknown = await inflight("validating", { started_at: old(), updated_at: old(), container_create_requested_at: old() });
      ids.createdFresh = await inflight("container_created", { updated_at: old() });
      ids.createdExpired = await inflight("container_created", { container_created_at: new Date(Date.now() - 16 * MIN).toISOString(), updated_at: old() });
      ids.readyFresh = await inflight("container_ready", { updated_at: old() });
      ids.readyExpired = await inflight("container_ready", { container_created_at: new Date(Date.now() - 16 * MIN).toISOString(), updated_at: old() });
      ids.legacyCreated = await inflight("container_created", { container_created_at: null, started_at: old(), updated_at: old() });
      ids.publishRequested = await inflight("publish_requested", { container_ids: ["17900000000000000903"], updated_at: old() });
      ids.unknown = await inflight("outcome_unknown", { error_code: "timeout" });
      ids.active = await inflight("validating", { started_at: old(), updated_at: old(), container_create_requested_at: old(), last_run_id: null });
      // Age the attempt-less publication past the 60 s minimum (DB clock).
      await sleep(62_000);
    }, 240_000);

    it("applies the locked rules and never touches resumable, unknown or actively owned work", async () => {
      await awayFromSlotBoundary();
      const holder = runId();
      await acquire(holder);
      // The active run owns this attempt (as select_runtime_resume / the engine would stamp it).
      await admin.from("publication_attempts").update({ last_run_id: holder }).eq("id", ids.active.attemptId!);

      expect(await admin.rpc("reconcile_stale_runtime_publications", { p_stale_seconds: 60, p_run_id: runId() })).toMatchObject({ data: [] });

      const { data, error } = await admin.rpc("reconcile_stale_runtime_publications", { p_stale_seconds: 60, p_run_id: holder });
      expect(error).toBeNull();
      const action = Object.fromEntries((data ?? []).map((r) => [r.publication_id, r.action]));
      expect(action[ids.noAttempt.publicationId]).toBe("failed_no_attempt");
      expect(action[ids.preG1.publicationId]).toBe("failed_pre_provider");
      expect(action[ids.g1Unknown.publicationId]).toBe("failed_g1_unknown");
      expect(action[ids.createdFresh.publicationId]).toBe("skipped_resumable");
      expect(action[ids.createdExpired.publicationId]).toBe("failed_container_not_ready");
      expect(action[ids.readyFresh.publicationId]).toBe("skipped_resumable");
      expect(action[ids.readyExpired.publicationId]).toBe("failed_publish_window_expired");
      expect(action[ids.legacyCreated.publicationId]).toBe("failed_pre_publish");
      expect(action[ids.publishRequested.publicationId]).toBe("marked_outcome_unknown");
      expect(action[ids.unknown.publicationId]).toBe("outcome_unknown_requires_operator");
      expect(action[ids.active.publicationId]).toBe("skipped_active_run");

      expect(await pub(ids.g1Unknown.publicationId)).toMatchObject({ status: "failed", error_code: "container_create_outcome_unknown" });
      expect(await attempt(ids.g1Unknown.attemptId!)).toMatchObject({ stage: "failed", error_code: "container_create_outcome_unknown" });
      expect(await pub(ids.preG1.publicationId)).toMatchObject({ status: "failed", error_code: "interrupted_before_publish" });
      expect(await pub(ids.createdExpired.publicationId)).toMatchObject({ status: "failed", error_code: "container_not_ready" });
      expect(await pub(ids.readyExpired.publicationId)).toMatchObject({ status: "failed", error_code: "publish_window_expired" });
      expect((await attempt(ids.createdFresh.attemptId!)).stage).toBe("container_created");
      expect((await attempt(ids.readyFresh.attemptId!)).stage).toBe("container_ready");
      expect((await pub(ids.createdFresh.publicationId)).status).toBe("publishing");
      expect(await attempt(ids.publishRequested.attemptId!)).toMatchObject({ stage: "outcome_unknown", error_code: "interrupted_during_publish" });
      expect((await pub(ids.publishRequested.publicationId)).status).toBe("publishing");
      expect((await attempt(ids.unknown.attemptId!)).stage).toBe("outcome_unknown");
      expect((await attempt(ids.active.attemptId!)).stage).toBe("validating");
      // Provider-free: no attempt was created.
      const { count } = await admin.from("publication_attempts").select("id", { count: "exact", head: true }).eq("publication_id", ids.noAttempt.publicationId);
      expect(count).toBe(0);
    });

    it("does nothing while the control is off", async () => {
      await awayFromSlotBoundary();
      const holder = runId();
      await acquire(holder);
      await setControl(false);
      const { data } = await admin.rpc("reconcile_stale_runtime_publications", { p_stale_seconds: 60, p_run_id: holder });
      expect(data).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Grants
  // ---------------------------------------------------------------------------
  describe("grants", () => {
    it("anon and authenticated can neither use the lease table nor execute any H1 RPC", async () => {
      const r = runId();
      for (const client of [anon, editor.client] as SupabaseClient<Database>[]) {
        expect((await client.rpc("acquire_runtime_slot_lease", { p_run_id: r })).error).not.toBeNull();
        expect((await client.rpc("complete_runtime_slot_lease", { p_run_id: r, p_outcome: "x" })).error).not.toBeNull();
        expect((await client.rpc("select_runtime_resume", { p_run_id: r })).error).not.toBeNull();
        expect((await client.rpc("claim_runtime_publications", { p_cap: 1, p_run_id: r })).error).not.toBeNull();
        expect((await client.rpc("reconcile_stale_runtime_publications", { p_stale_seconds: 600, p_run_id: r })).error).not.toBeNull();
        const read = await client.from("publishing_runtime_slot_lease").select("*");
        expect(read.error !== null || (read.data ?? []).length === 0).toBe(true);
        const write = await client
          .from("publishing_runtime_slot_lease")
          .insert({ runtime_key: "instagram_scheduled_publishing", slot_start: new Date(0).toISOString(), run_id: r });
        expect(write.error).not.toBeNull();
      }
      expect(await leaseRows()).toEqual([]);
    });
  });
});
