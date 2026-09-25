import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MediaPublishResult, StagedMediaPublisher } from "@/lib/social/provider";
import { runScheduledPublishingRuntime, type RuntimeDeps } from "@/server/runtime/scheduled-publishing";
import { createAttemptStore } from "@/server/services/instagram-image-publishing";
import { closeUnknownAsNotPublished } from "@/server/services/publication-reconciliation";
import { markFailedAsSystem } from "@/server/services/publication-transitions";
import type { ContentVariant, Database, SocialAccount } from "@/types/database";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.36 (Decision #44) — the Level-6 scheduled publishing runtime
 * against the LOCAL Supabase schema (real RPCs, triggers and grants) with
 * an in-memory fake provider. No Meta call is possible. Synthetic ids only.
 *
 * The runtime control is a singleton row; this file owns it while it runs
 * (files run sequentially) and deletes it afterwards (a missing row = OFF).
 */

const FAKE_TOKEN = "IGAAfakeRuntimeTestToken000000000000001";
const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-RUNTIME-0001";
const IG_ID = "17849990000000062";
const OTHER_IG_ID = "17849990000000072";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ON_ENV = { MARQOS_INSTAGRAM_STAGED_PUBLISHING: "enabled", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const MIN = 60 * 1000;

type Calls = { create: number; status: number; publish: number; recent: number };

function fakeProvider(script: { status?: () => Promise<void>; publish?: () => MediaPublishResult } = {}) {
  const calls: Calls = { create: 0, status: 0, publish: 0, recent: 0 };
  const provider: StagedMediaPublisher = {
    async createMediaContainer() {
      calls.create += 1;
      return { ok: true, containerId: "17900000000000000621" };
    },
    async getMediaContainerStatus() {
      calls.status += 1;
      await script.status?.();
      return { ok: true, status: "FINISHED" };
    },
    async publishMediaContainer() {
      calls.publish += 1;
      return script.publish ? script.publish() : { ok: true, mediaId: "18000000000000000621" };
    },
    async listRecentMedia() {
      calls.recent += 1;
      return { ok: true, items: [] };
    },
  };
  return { provider, calls };
}

/** Wraps the service client so a test can act right after a given RPC returns. */
function clientWithRpcHook(base: SupabaseClient<Database>, fn: string, after: () => Promise<void>): SupabaseClient<Database> {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "rpc") {
        return async (...args: Parameters<SupabaseClient<Database>["rpc"]>) => {
          const result = await (target.rpc as unknown as (...a: unknown[]) => Promise<unknown>)(...args);
          if (args[0] === fn) await after();
          return result;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe.skipIf(!hasLocalSupabase)("MVP-5.36 Level-6 scheduled publishing runtime (local DB)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, SERVICE_KEY) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let contentId: string;
  let allowlisted: SocialAccount;
  let notAllowlisted: SocialAccount;
  let legacyAllowlisted: SocialAccount;
  const vaultIds: string[] = [];
  let logs: string[] = [];

  async function setControl(enabled: boolean, mode: "dry_run" | "publish" = "publish") {
    const { error } = await admin.from("publishing_runtime_control").upsert({ key: "instagram_scheduled_publishing", enabled, mode });
    if (error) throw new Error(`control: ${error.message}`);
  }

  async function removeControl() {
    await admin.from("publishing_runtime_control").delete().eq("key", "instagram_scheduled_publishing");
  }

  /** H2: each natural invocation owns a DB-clock slot lease; clearing leases simulates the next slot. */
  async function newSlot() {
    await admin.from("publishing_runtime_slot_lease").delete().eq("runtime_key", "instagram_scheduled_publishing");
  }

  /** H2 single-flight: close in-flight rows of this workspace between tests so the next claim is not blocked. */
  async function closeInflight() {
    await admin
      .from("publication_attempts")
      .update({ stage: "failed", error_code: "test_cleanup" })
      .eq("workspace_id", workspaceId)
      .in("stage", ["validating", "container_created", "container_ready", "publish_requested"]);
    await admin.from("publications").update({ status: "failed", error_code: "test_cleanup" }).eq("workspace_id", workspaceId).eq("status", "publishing");
  }

  async function account(externalId: string, metadata: Record<string, unknown>, allow: boolean): Promise<SocialAccount> {
    const { data: secret, error: secretError } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "runtime test" });
    if (secretError || !secret) throw new Error(`vault: ${secretError?.message}`);
    vaultIds.push(secret as string);
    const { data, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: externalId,
        account_name: "runtime fixture",
        status: "connected",
        vault_secret_id: secret as string,
        metadata,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`account: ${error?.message}`);
    if (allow) {
      const { error: allowError } = await admin.from("publishing_runtime_allowlist").insert({ social_account_id: data.id, workspace_id: workspaceId });
      if (allowError) throw new Error(`allowlist: ${allowError.message}`);
    }
    return data;
  }

  async function variant(opts: { withAsset?: boolean } = {}): Promise<ContentVariant> {
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
    const { data: row, error } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "Runtime check #marqos" })
      .select()
      .single();
    if (error || !row) throw new Error(`variant: ${error?.message}`);
    await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: contentId,
      content_version_id: version!.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    if (opts.withAsset !== false) {
      const id = crypto.randomUUID();
      const { error: assetError } = await admin.from("marqos_assets").insert({
        id,
        workspace_id: workspaceId,
        storage_path: `${workspaceId}/${id}.jpg`,
        file_name: `${id}.jpg`,
        mime_type: "image/jpeg",
        asset_type: "image",
        file_size: 400_000,
        width: 1080,
        height: 1350,
      });
      if (assetError) throw new Error(`asset: ${assetError.message}`);
      await admin.from("marqos_content_variant_assets").insert({ content_variant_id: row.id, asset_id: id, workspace_id: workspaceId, sort_order: 0 });
    }
    return row;
  }

  /** scheduled_at is compared with the DATABASE clock; ±minutes margins are immune to host/DB skew. */
  async function scheduled(v: ContentVariant, acct: SocialAccount, offsetMs = -5 * MIN): Promise<string> {
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: v.id,
        social_account_id: acct.id,
        status: "scheduled",
        scheduled_at: new Date(Date.now() + offsetMs).toISOString(),
        idempotency_key: crypto.randomUUID(),
        created_by: editor.userId,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`publication: ${error?.message}`);
    return data.id;
  }

  async function publishing(v: ContentVariant, acct: SocialAccount): Promise<string> {
    const id = await scheduled(v, acct);
    const { error } = await admin.from("publications").update({ status: "publishing" }).eq("id", id);
    if (error) throw new Error(`publishing: ${error.message}`);
    return id;
  }

  const pub = async (id: string) => (await admin.from("publications").select("*").eq("id", id).single()).data!;
  const attempts = async (id: string) => (await admin.from("publication_attempts").select("*").eq("publication_id", id).order("attempt_number")).data ?? [];
  const audits = async (id: string) => (await admin.from("audit_logs").select("*").eq("entity_id", id)).data ?? [];

  /** No stray due rows between tests: scheduled rows of this workspace are removed. */
  async function clearScheduled() {
    await admin.from("publications").delete().eq("workspace_id", workspaceId).eq("status", "scheduled");
  }

  function deps(extra: Partial<RuntimeDeps> = {}): RuntimeDeps {
    return {
      client: admin,
      env: ON_ENV,
      signMediaUrl: async () => SIGNED_URL,
      sleep: async () => {},
      log: (line) => logs.push(line),
      ...extra,
    };
  }

  const events = () => logs.map((line) => JSON.parse(line).event as string);

  beforeAll(async () => {
    await removeControl();
    editor = await createSignedInTestUser(admin);
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "Runtime Level 6", p_slug: `runtime-l6-${Date.now()}` });
    workspaceId = ws!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "C" }).select().single();
    contentId = content!.id;
    const modelB = { credentialKind: "real", instagramScopedUserId: "38281000000006201", instagramAppScopedId: "38281000000006201" };
    allowlisted = await account(IG_ID, modelB, true);
    notAllowlisted = await account(OTHER_IG_ID, { ...modelB, instagramScopedUserId: "38281000000007201" }, false);
    legacyAllowlisted = await account("38281000000008200", { credentialKind: "real" }, true);
  });

  beforeEach(async () => {
    logs = [];
    await newSlot();
  });

  afterAll(async () => {
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

  // ---------------------------------------------------------------------------
  // OFF: zero mutation (B–G)
  // ---------------------------------------------------------------------------
  describe("OFF paths", () => {
    it("B/C/D/E: missing row, enabled=false, unreadable control and env≠enabled change nothing", async () => {
      const due = await scheduled(await variant(), allowlisted);
      const { provider, calls } = fakeProvider();
      const badClient = createClient<Database>(supabaseUrl!, "not-a-valid-key");
      const cases: Array<[string, () => Promise<void>, Partial<RuntimeDeps>, string]> = [
        ["missing", removeControl, {}, "runtime_disabled"],
        ["disabled", () => setControl(false), {}, "runtime_disabled"],
        ["unreadable", () => setControl(true), { client: badClient }, "runtime_disabled"],
        ["null client", () => setControl(true), { client: null }, "runtime_disabled"],
        ["env absent", () => setControl(true), { env: { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY } }, "env_gate_disabled"],
        ["env 'true'", () => setControl(true), { env: { ...ON_ENV, MARQOS_INSTAGRAM_STAGED_PUBLISHING: "true" } }, "env_gate_disabled"],
      ];
      for (const [label, arrange, extra, expected] of cases) {
        await arrange();
        const summary = await runScheduledPublishingRuntime(deps({ provider, ...extra }));
        expect(summary.outcome, label).toBe(expected);
        expect(summary.claimed, label).toBe(0);
        expect(summary.reconciled, label).toBe(0);
        expect(summary.vaultReads, label).toBe(0);
      }
      expect(calls).toEqual({ create: 0, status: 0, publish: 0, recent: 0 });
      expect((await pub(due)).status).toBe("scheduled");
      expect(await attempts(due)).toEqual([]);
      expect(await audits(due)).toEqual([]);
      await clearScheduled();
    });

    it("F/G: with the control OFF the claim and reconcile RPCs themselves do nothing", async () => {
      await setControl(false);
      const due = await scheduled(await variant(), allowlisted);
      const claim = await admin.rpc("claim_runtime_publications", { p_cap: 1 });
      expect(claim.error).toBeNull();
      expect(claim.data).toEqual([]);
      const reconcile = await admin.rpc("reconcile_stale_runtime_publications", { p_stale_seconds: 60 });
      expect(reconcile.error).toBeNull();
      expect(reconcile.data).toEqual([]);
      expect((await pub(due)).status).toBe("scheduled");
      await clearScheduled();
    });

    it("browser roles cannot read or change the control/allowlist, nor execute the runtime RPCs", async () => {
      const read = await editor.client.from("publishing_runtime_control").select("*");
      expect(read.error ?? (read.data ?? []).length === 0).toBeTruthy();
      const write = await editor.client.from("publishing_runtime_control").upsert({ key: "instagram_scheduled_publishing", enabled: true, mode: "publish" });
      expect(write.error).not.toBeNull();
      const allow = await editor.client.from("publishing_runtime_allowlist").insert({ social_account_id: notAllowlisted.id, workspace_id: workspaceId });
      expect(allow.error).not.toBeNull();
      expect((await editor.client.rpc("claim_runtime_publications", { p_cap: 1 })).error).not.toBeNull();
      expect((await editor.client.rpc("reconcile_stale_runtime_publications", { p_stale_seconds: 600 })).error).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Claim v2 (H–M)
  // ---------------------------------------------------------------------------
  describe("claim_runtime_publications", () => {
    beforeEach(async () => {
      await setControl(true);
      await clearScheduled();
    });

    it("H: the cap must be exactly 1", async () => {
      for (const cap of [0, 2, 50]) {
        expect((await admin.rpc("claim_runtime_publications", { p_cap: cap })).error).not.toBeNull();
      }
    });

    it("I/L: only due rows of allowlisted accounts are claimed", async () => {
      const notAllowed = await scheduled(await variant(), notAllowlisted);
      const future = await scheduled(await variant(), allowlisted, 60 * MIN);
      const { data } = await admin.rpc("claim_runtime_publications", { p_cap: 1 });
      expect(data).toEqual([]);
      expect((await pub(notAllowed)).status).toBe("scheduled");
      expect((await pub(future)).status).toBe("scheduled");
    });

    it("J/K: at most one row per call, oldest first; concurrent calls never share a row; a skipped row stays claimable", async () => {
      const first = await scheduled(await variant(), allowlisted, -20 * MIN);
      const second = await scheduled(await variant(), allowlisted, -10 * MIN);
      const third = await scheduled(await variant(), allowlisted, -5 * MIN);
      const one = await admin.rpc("claim_runtime_publications", { p_cap: 1 });
      expect(one.error).toBeNull();
      expect((one.data ?? []).map((row) => row.id)).toEqual([first]);

      // Safety, not liveness: SKIP LOCKED guarantees concurrent callers never
      // share a row, but NOT that each caller gets one — the PL/pgSQL cursor
      // may lock both candidates, so the other caller can legitimately get
      // nothing. Both schedules (1 + 1, or 1 + 0 then a later claim) are valid.
      const [a, b] = await Promise.all([
        admin.rpc("claim_runtime_publications", { p_cap: 1 }),
        admin.rpc("claim_runtime_publications", { p_cap: 1 }),
      ]);
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      const rowsA = a.data ?? [];
      const rowsB = b.data ?? [];
      // A/H: cap = 1 per call.
      expect(rowsA.length).toBeLessThanOrEqual(1);
      expect(rowsB.length).toBeLessThanOrEqual(1);
      const concurrent = [...rowsA, ...rowsB];
      // D: the pair claims at least one eligible row.
      expect(concurrent.length).toBeGreaterThanOrEqual(1);
      // B: never the same publication twice.
      expect(new Set(concurrent.map((row) => row.id)).size).toBe(concurrent.length);
      // C: every returned row is an eligible candidate (allowlisted, same workspace, claimed).
      for (const row of concurrent) {
        expect([second, third]).toContain(row.id);
        expect(row).toMatchObject({ status: "publishing", workspace_id: workspaceId, social_account_id: allowlisted.id });
      }

      // E: after both settle, any remaining eligible row is claimable by a later invocation.
      const later: string[] = [];
      if (concurrent.length === 1) {
        const next = await admin.rpc("claim_runtime_publications", { p_cap: 1 });
        expect(next.error).toBeNull();
        expect((next.data ?? []).length).toBe(1);
        later.push(...(next.data ?? []).map((row) => row.id));
      }
      const all = [first, ...concurrent.map((row) => row.id), ...later];
      // F: each publication was transitioned exactly once across every call.
      expect(all.slice().sort()).toEqual([first, second, third].sort());
      const drained = await admin.rpc("claim_runtime_publications", { p_cap: 1 });
      expect(drained.data).toEqual([]);
      for (const id of [first, second, third]) {
        expect((await pub(id)).status).toBe("publishing");
        // G: claiming never creates an attempt.
        expect(await attempts(id)).toEqual([]);
      }
    });

    it("M: a row whose approval was superseded is skipped (stays scheduled) and the next candidate is claimed", async () => {
      const revokedVariant = await variant();
      const revoked = await scheduled(revokedVariant, allowlisted, -30 * MIN);
      const { data: version } = await admin.from("content_variants").select("content_version_id").eq("id", revokedVariant.id).single();
      await admin.from("content_approvals").insert({
        workspace_id: workspaceId,
        content_id: contentId,
        content_version_id: version!.content_version_id,
        status: "changes_requested",
        reviewed_at: new Date().toISOString(),
      });
      const next = await scheduled(await variant(), allowlisted, -5 * MIN);
      const { data, error } = await admin.rpc("claim_runtime_publications", { p_cap: 1 });
      expect(error).toBeNull();
      expect((data ?? []).map((row) => row.id)).toEqual([next]);
      expect((await pub(revoked)).status).toBe("scheduled");
      await clearScheduled();
    });
  });

  // ---------------------------------------------------------------------------
  // Runtime end to end (engine, re-checks, dry run, budget, redaction)
  // ---------------------------------------------------------------------------
  describe("runtime execution", () => {
    beforeEach(async () => {
      await closeInflight();
      await setControl(true, "publish");
      await clearScheduled();
    });

    afterEach(async () => {
      await closeInflight();
    });

    it("publishes exactly one allowlisted due publication: G1 = 1, G3 = 1, one Vault read, audit + safe logs (Z)", async () => {
      const id = await scheduled(await variant(), allowlisted);
      const extra = await scheduled(await variant(), allowlisted, -1 * MIN);
      const { provider, calls } = fakeProvider();
      const summary = await runScheduledPublishingRuntime(deps({ provider }));
      expect(summary).toMatchObject({ outcome: "completed", result: "published", claimed: 1, publicationId: id, vaultReads: 1, mode: "publish" });
      expect(calls).toMatchObject({ create: 1, publish: 1, recent: 0 });
      const row = await pub(id);
      expect(row.status).toBe("published");
      expect(row.external_publication_id).toBe("18000000000000000621");
      expect((await attempts(id)).map((a) => a.stage)).toEqual(["published"]);
      expect((await pub(extra)).status).toBe("scheduled");

      const audit = (await audits(id)).find((entry) => entry.action === "publication.runtime_final");
      expect(audit).toMatchObject({ actor_user_id: null, entity_type: "publication", workspace_id: workspaceId });
      expect((audit!.metadata as Record<string, unknown>).runId).toBe(summary.runId);

      const seen = events();
      for (const event of [
        "scheduler_start",
        "lease",
        "reconcile",
        "work_selected",
        "load",
        "control_recheck",
        "vault",
        "attempt_started",
        "g1_dispatch",
        "g1_result",
        "g2_poll",
        "publish_requested",
        "g3_dispatch",
        "g3_result",
        "lease_complete",
        "final",
      ]) {
        expect(seen, event).toContain(event);
      }
      // Z: every line is JSON with the runId; no credential, signed URL or service-role key anywhere.
      const persisted = JSON.stringify([row, audit, await attempts(id)]);
      for (const line of logs) expect(JSON.parse(line).runId).toBe(summary.runId);
      for (const secret of [FAKE_TOKEN, SIGNED_URL, SERVICE_KEY]) {
        expect(logs.join("\n")).not.toContain(secret);
        expect(persisted).not.toContain(secret);
      }
      await clearScheduled();
    });

    it("ineligible publication fails before Vault: no Vault read, no signed URL, no provider call, no attempt", async () => {
      const noMedia = await scheduled(await variant({ withAsset: false }), allowlisted);
      const { provider, calls } = fakeProvider();
      let signed = 0;
      const summary = await runScheduledPublishingRuntime(deps({ provider, signMediaUrl: async () => (signed++, SIGNED_URL) }));
      expect(summary).toMatchObject({ outcome: "ineligible", code: "no_publish_media", vaultReads: 0 });
      expect(signed).toBe(0);
      expect(calls).toEqual({ create: 0, status: 0, publish: 0, recent: 0 });
      expect((await pub(noMedia)).status).toBe("failed");
      expect(await attempts(noMedia)).toEqual([]);

      const legacy = await scheduled(await variant(), legacyAllowlisted);
      await newSlot();
      const again = await runScheduledPublishingRuntime(deps({ provider }));
      expect(again).toMatchObject({ outcome: "ineligible", code: "account_not_publish_ready", vaultReads: 0 });
      expect((await pub(legacy)).status).toBe("failed");
    });

    it("9: control switched OFF after the claim → no Vault, no attempt, no provider; the claimed row is left untouched", async () => {
      const id = await scheduled(await variant(), allowlisted);
      const { provider, calls } = fakeProvider();
      const client = clientWithRpcHook(admin, "claim_runtime_publications", () => setControl(false));
      const summary = await runScheduledPublishingRuntime(deps({ provider, client }));
      expect(summary).toMatchObject({ outcome: "runtime_disabled_after_selection", claimed: 1, vaultReads: 0, leaseCompleted: true });
      expect(calls).toEqual({ create: 0, status: 0, publish: 0, recent: 0 });
      expect((await pub(id)).status).toBe("publishing");
      expect(await attempts(id)).toEqual([]);
    });

    it("N: control switched OFF after Vault → stopped before G1 (no container), known not published", async () => {
      const id = await scheduled(await variant(), allowlisted);
      const { provider, calls } = fakeProvider();
      const client = clientWithRpcHook(admin, "read_social_account_vault_secret", () => setControl(false));
      const summary = await runScheduledPublishingRuntime(deps({ provider, client }));
      expect(summary).toMatchObject({ outcome: "completed", result: "failed_known", code: "runtime_disabled_before_create", vaultReads: 1 });
      expect(calls.create).toBe(0);
      expect(calls.publish).toBe(0);
      expect((await pub(id)).status).toBe("failed");
      expect((await attempts(id)).map((a) => [a.stage, a.error_code])).toEqual([["failed", "runtime_disabled_before_create"]]);
    });

    it("O: control switched OFF during polling → no publish request; container_ready preserved (resumable, H0 §13)", async () => {
      const id = await scheduled(await variant(), allowlisted);
      const { provider, calls } = fakeProvider({ status: () => setControl(false) });
      const summary = await runScheduledPublishingRuntime(deps({ provider }));
      expect(summary).toMatchObject({ outcome: "completed", result: "deferred", code: "runtime_disabled", terminal: false });
      expect(calls).toMatchObject({ create: 1, publish: 0 });
      expect(events()).not.toContain("g3_dispatch");
      expect(events()).not.toContain("publish_requested");
      expect((await pub(id)).status).toBe("publishing");
      expect((await attempts(id)).map((a) => a.stage)).toEqual(["container_ready"]);
    });

    it("Y: dry_run mode can never reach G3", async () => {
      await setControl(true, "dry_run");
      const id = await scheduled(await variant(), allowlisted);
      const { provider, calls } = fakeProvider();
      const summary = await runScheduledPublishingRuntime(deps({ provider }));
      expect(summary).toMatchObject({ outcome: "completed", result: "dry_run_container_ready", mode: "dry_run" });
      expect(calls).toMatchObject({ create: 1, publish: 0 });
      expect(events()).not.toContain("g3_dispatch");
      expect((await pub(id)).error_code).toBe("dry_run_container_ready");
    });

    it("W: when polling consumes the budget, G3 is not started; container_ready is deferred (no publish_requested)", async () => {
      const id = await scheduled(await variant(), allowlisted);
      let t = 0;
      const { provider, calls } = fakeProvider({
        status: async () => {
          t += 18_000;
        },
      });
      const summary = await runScheduledPublishingRuntime(deps({ provider, now: () => t }));
      expect(summary).toMatchObject({ result: "deferred", code: "g3_budget", terminal: false });
      expect(calls.publish).toBe(0);
      expect(events()).not.toContain("publish_requested");
      expect((await attempts(id)).map((a) => a.stage)).toEqual(["container_ready"]);
      expect((await pub(id)).status).toBe("publishing");
    });

    it("a publish timeout is outcome_unknown and is never retried (a later run claims nothing)", async () => {
      const id = await scheduled(await variant(), allowlisted);
      const timeout: MediaPublishResult = {
        ok: false,
        outcome: "unknown",
        code: "timeout",
        message: "fixture timeout",
        httpStatus: null,
        providerCode: null,
        providerSubcode: null,
        fbtraceId: null,
      };
      const { provider, calls } = fakeProvider({ publish: () => timeout });
      const summary = await runScheduledPublishingRuntime(deps({ provider }));
      expect(summary).toMatchObject({ result: "publish_outcome_unknown" });
      await newSlot();
      const second = await runScheduledPublishingRuntime(deps({ provider }));
      // Single-flight: the unresolved outcome_unknown publication blocks new claims; resume never selects it.
      expect(second).toMatchObject({ outcome: "no_work", claimed: 0, vaultReads: 0 });
      expect(calls.publish).toBe(1);
      expect((await pub(id)).status).toBe("publishing");
      expect((await attempts(id)).map((a) => a.stage)).toEqual(["outcome_unknown"]);

      // B7: closing it requires an explicit confirmed not-published determination.
      const closeDeps = {
        client: admin,
        attempts: createAttemptStore(admin),
        markFailed: (ws: string, pid: string, input: Parameters<typeof markFailedAsSystem>[3]) => markFailedAsSystem(admin, ws, pid, input),
      };
      const [attempt] = await attempts(id);
      const refused = await closeUnknownAsNotPublished(workspaceId, id, { attemptId: attempt.id, confirmation: "maybe" as never, evidenceRef: "x" }, closeDeps);
      expect(refused).toEqual({ kind: "refused", reason: "missing_confirmation" });
      expect(await closeUnknownAsNotPublished(workspaceId, id, { attemptId: attempt.id, confirmation: "confirmed_not_published", evidenceRef: " " }, closeDeps)).toEqual({
        kind: "refused",
        reason: "missing_evidence_ref",
      });
      expect((await pub(id)).status).toBe("publishing");
      const closed = await closeUnknownAsNotPublished(
        workspaceId,
        id,
        { attemptId: attempt.id, confirmation: "confirmed_not_published", evidenceRef: "operator-review-fixture" },
        closeDeps,
      );
      expect(closed).toEqual({ kind: "closed_not_published", attemptId: attempt.id });
      expect(await pub(id)).toMatchObject({ status: "failed", error_code: "publish_outcome_unknown" });
      expect((await attempts(id)).map((a) => a.stage)).toEqual(["outcome_unknown"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Provider-free stale reconciliation (R–V). Staleness uses the DB clock, and
  // the minimum threshold is 60 s, so fixtures are aged by a real wait.
  // ---------------------------------------------------------------------------
  describe("stale reconciliation", () => {
    const ids: Record<string, string> = {};
    const attemptIds: Record<string, string> = {};

    async function attempt(publicationId: string, fields: Record<string, unknown>) {
      const old = new Date(Date.now() - 30 * MIN).toISOString();
      const { data, error } = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram", started_at: old, updated_at: old, ...fields })
        .select()
        .single();
      if (error || !data) throw new Error(`attempt: ${error?.message}`);
      return data.id;
    }

    beforeAll(async () => {
      await setControl(false);
      await clearScheduled();
      ids.noAttempt = await publishing(await variant(), allowlisted);
      ids.prePublish = await publishing(await variant(), allowlisted);
      attemptIds.prePublish = await attempt(ids.prePublish, { stage: "container_created", container_ids: ["17900000000000000631"] });
      ids.publishRequested = await publishing(await variant(), allowlisted);
      attemptIds.publishRequested = await attempt(ids.publishRequested, { stage: "publish_requested", container_ids: ["17900000000000000632"] });
      ids.published = await publishing(await variant(), allowlisted);
      attemptIds.published = await attempt(ids.published, {
        stage: "published",
        container_ids: ["17900000000000000633"],
        external_media_id: "18000000000000000633",
      });
      ids.failedAttempt = await publishing(await variant(), allowlisted);
      await attempt(ids.failedAttempt, { stage: "failed", error_code: "container_error", error_message: "fixture" });
      ids.unknown = await publishing(await variant(), allowlisted);
      await attempt(ids.unknown, { stage: "outcome_unknown", error_code: "timeout" });
      ids.recentAttempt = await publishing(await variant(), allowlisted);
      await attempt(ids.recentAttempt, { stage: "validating", updated_at: new Date(Date.now() + 5 * MIN).toISOString() });
      ids.notAllowlisted = await publishing(await variant(), notAllowlisted);
      // Age every publication past the 60 s minimum threshold (DB clock).
      await new Promise((resolve) => setTimeout(resolve, 62_000));
      ids.fresh = await publishing(await variant(), allowlisted);
    }, 180_000);

    it("R–V: OFF leaves stale rows alone; ON reconciles them provider-free by the locked rules", async () => {
      const before = await Promise.all(Object.values(ids).map(pub));
      const off = await runScheduledPublishingRuntime(deps({ staleSeconds: 60 }));
      expect(off.outcome).toBe("runtime_disabled");
      expect(await Promise.all(Object.values(ids).map(pub))).toEqual(before);

      expect((await admin.rpc("reconcile_stale_runtime_publications", { p_stale_seconds: 59 })).error).not.toBeNull();

      await setControl(true);
      const { provider, calls } = fakeProvider();
      const summary = await runScheduledPublishingRuntime(deps({ provider, staleSeconds: 60 }));
      expect(summary).toMatchObject({ outcome: "no_work", vaultReads: 0 });
      expect(calls).toEqual({ create: 0, status: 0, publish: 0, recent: 0 });

      const reconcileLine = logs.map((line) => JSON.parse(line)).find((line) => line.event === "reconcile");
      const actions = Object.fromEntries(
        (reconcileLine.rows as Array<{ publicationId: string; action: string }>).map((row) => [row.publicationId, row.action]),
      );
      expect(actions[ids.noAttempt]).toBe("failed_no_attempt");
      expect(actions[ids.prePublish]).toBe("failed_pre_publish");
      expect(actions[ids.publishRequested]).toBe("marked_outcome_unknown");
      expect(actions[ids.published]).toBe("finalized_published");
      expect(actions[ids.failedAttempt]).toBe("failed_from_attempt");
      expect(actions[ids.unknown]).toBe("outcome_unknown_requires_operator");
      expect(actions[ids.recentAttempt]).toBe("skipped_attempt_recent");
      expect(actions[ids.notAllowlisted]).toBeUndefined();
      expect(actions[ids.fresh]).toBe("skipped_publication_recent");

      // R: no attempt → known pre-provider failure (+ notification, audit); never an attempt created.
      expect(await pub(ids.noAttempt)).toMatchObject({ status: "failed", error_code: "runtime_interrupted_before_attempt" });
      expect(await attempts(ids.noAttempt)).toEqual([]);
      const { data: notes } = await admin.from("notifications").select("data").eq("workspace_id", workspaceId).eq("type", "publication_failed");
      expect((notes ?? []).some((n) => (n.data as Record<string, unknown>).publication_id === ids.noAttempt)).toBe(true);
      expect((await audits(ids.noAttempt)).map((a) => a.action)).toContain("publication.runtime_reconciled");
      // S: pre-publish stage → attempt + publication failed.
      expect(await pub(ids.prePublish)).toMatchObject({ status: "failed", error_code: "interrupted_before_publish" });
      expect((await attempts(ids.prePublish))[0].stage).toBe("failed");
      // T: publish_requested → outcome_unknown; publication stays publishing; no provider retry.
      expect((await pub(ids.publishRequested)).status).toBe("publishing");
      expect((await attempts(ids.publishRequested))[0]).toMatchObject({ stage: "outcome_unknown", error_code: "interrupted_during_publish" });
      // U: durable media id → finalized.
      expect(await pub(ids.published)).toMatchObject({ status: "published", external_publication_id: "18000000000000000633" });
      // V: failed attempt → publication failed; unknown / recent / not allowlisted / fresh untouched.
      expect(await pub(ids.failedAttempt)).toMatchObject({ status: "failed", error_code: "container_error" });
      for (const key of ["unknown", "recentAttempt", "notAllowlisted", "fresh"]) {
        expect((await pub(ids[key])).status, key).toBe("publishing");
      }
      expect((await attempts(ids.unknown)).length).toBe(1);
    });
  });
});
