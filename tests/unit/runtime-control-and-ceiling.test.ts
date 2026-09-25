import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { StagedMediaPublisher } from "@/lib/social/provider";
import { isEnvPublishingGateEnabled, readRuntimeControl } from "@/server/runtime/runtime-control";
import { withoutPublishCapability, withRuntimeCallCeiling } from "@/server/runtime/runtime-provider-ceiling";
import { runScheduledPublishingRuntime } from "@/server/runtime/scheduled-publishing";
import type { Database } from "@/types/database";

/** MVP-5.36 (Decision #44) — fail-closed controls and the per-invocation provider ceiling. */

function controlClient(result: { data?: unknown; error?: unknown; throws?: boolean }) {
  const calls: string[] = [];
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => {
      if (result.throws) throw new Error("network down");
      return { data: result.data ?? null, error: result.error ?? null };
    },
  };
  const client = {
    from: (table: string) => {
      calls.push(`from:${table}`);
      return chain;
    },
    rpc: async (fn: string) => {
      calls.push(`rpc:${fn}`);
      return { data: [], error: null };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, calls };
}

describe("readRuntimeControl — fail closed", () => {
  it("missing row, read error, thrown read, null client and enabled≠true are all OFF", async () => {
    expect(await readRuntimeControl(controlClient({ data: null }).client)).toEqual({ on: false, reason: "missing" });
    expect(await readRuntimeControl(controlClient({ error: { message: "denied" } }).client)).toEqual({ on: false, reason: "unreadable" });
    expect(await readRuntimeControl(controlClient({ throws: true }).client)).toEqual({ on: false, reason: "unreadable" });
    expect(await readRuntimeControl(null)).toEqual({ on: false, reason: "unreadable" });
    for (const enabled of [false, null, "true", 1]) {
      expect(await readRuntimeControl(controlClient({ data: { enabled, mode: "publish" } }).client)).toEqual({ on: false, reason: "disabled" });
    }
  });

  it("mode is 'publish' only when exactly 'publish'; anything else is dry_run", async () => {
    expect(await readRuntimeControl(controlClient({ data: { enabled: true, mode: "publish" } }).client)).toEqual({ on: true, mode: "publish" });
    for (const mode of ["dry_run", "PUBLISH", null, "publish "]) {
      expect(await readRuntimeControl(controlClient({ data: { enabled: true, mode } }).client)).toEqual({ on: true, mode: "dry_run" });
    }
  });
});

describe("env gate", () => {
  it("is ON only for exactly 'enabled'", () => {
    expect(isEnvPublishingGateEnabled({ MARQOS_INSTAGRAM_STAGED_PUBLISHING: "enabled" })).toBe(true);
    for (const value of [undefined, "", "true", "Enabled", " enabled", "enabled ", "1"]) {
      expect(isEnvPublishingGateEnabled({ MARQOS_INSTAGRAM_STAGED_PUBLISHING: value })).toBe(false);
    }
  });
});

describe("runtime OFF paths touch nothing but the control read", () => {
  it("DB control OFF → only the control is read (no RPC: no reconcile, claim or Vault)", async () => {
    const { client, calls } = controlClient({ data: { enabled: false, mode: "publish" } });
    const logs: string[] = [];
    const summary = await runScheduledPublishingRuntime({ client, env: { MARQOS_INSTAGRAM_STAGED_PUBLISHING: "enabled" }, log: (l) => logs.push(l) });
    expect(summary.outcome).toBe("runtime_disabled");
    expect(calls).toEqual(["from:publishing_runtime_control"]);
    expect(summary.vaultReads).toBe(0);
    expect(summary.providerCalls).toEqual({ create: 0, status: 0, publish: 0 });
    expect(logs.map((l) => JSON.parse(l).event)).toEqual(["scheduler_start", "runtime_disabled", "final"]);
  });

  it("env gate OFF with DB control ON → only the control is read", async () => {
    const { client, calls } = controlClient({ data: { enabled: true, mode: "publish" } });
    const summary = await runScheduledPublishingRuntime({ client, env: { MARQOS_INSTAGRAM_STAGED_PUBLISHING: "true" }, log: () => {} });
    expect(summary.outcome).toBe("env_gate_disabled");
    expect(calls).toEqual(["from:publishing_runtime_control"]);
  });
});

describe("withRuntimeCallCeiling (P/Q)", () => {
  function inner() {
    const counts = { create: 0, status: 0, publish: 0, recent: 0 };
    const provider: StagedMediaPublisher = {
      createMediaContainer: async () => (counts.create++, { ok: true, containerId: "17900000000000000001" }),
      getMediaContainerStatus: async () => (counts.status++, { ok: true, status: "FINISHED" }),
      publishMediaContainer: async () => (counts.publish++, { ok: true, mediaId: "18000000000000000001" }),
      listRecentMedia: async () => (counts.recent++, { ok: true, items: [] }),
    };
    return { provider, counts };
  }

  it("P: a second container creation (G1) is refused without any request", async () => {
    const { provider, counts } = inner();
    const counters = { create: 0, status: 0, publish: 0 };
    const guarded = withRuntimeCallCeiling(provider, counters);
    const input = { credential: "c", accountId: "17849990000000042", imageUrl: "https://local.invalid/x.jpg", caption: null };
    expect((await guarded.createMediaContainer(input)).ok).toBe(true);
    const second = await guarded.createMediaContainer(input);
    expect(second).toMatchObject({ ok: false, code: "runtime_call_ceiling" });
    expect(counts.create).toBe(1);
    expect(counters.create).toBe(1);
  });

  it("Q: a second publish request (G3) is refused as a known rejection without any request", async () => {
    const { provider, counts } = inner();
    const guarded = withRuntimeCallCeiling(provider, { create: 0, status: 0, publish: 0 });
    const input = { credential: "c", accountId: "17849990000000042", containerId: "17900000000000000001" };
    expect((await guarded.publishMediaContainer(input)).ok).toBe(true);
    expect(await guarded.publishMediaContainer(input)).toMatchObject({ ok: false, outcome: "rejected", code: "runtime_call_ceiling" });
    expect(counts.publish).toBe(1);
  });

  it("H2: a second G1 refusal is an authoritative 'rejected' (never classified as unknown)", async () => {
    const { provider } = inner();
    const guarded = withRuntimeCallCeiling(provider, { create: 0, status: 0, publish: 0 });
    const input = { credential: "c", accountId: "17849990000000042", imageUrl: "https://local.invalid/x.jpg", caption: null };
    await guarded.createMediaContainer(input);
    expect(await guarded.createMediaContainer(input)).toMatchObject({ ok: false, outcome: "rejected", code: "runtime_call_ceiling" });
  });

  it("H2: dry_run provider has no publish capability (the inner provider is never reached)", async () => {
    const { provider, counts } = inner();
    const dry = withoutPublishCapability(withRuntimeCallCeiling(provider, { create: 0, status: 0, publish: 0 }));
    expect(await dry.publishMediaContainer({ credential: "c", accountId: "17849990000000042", containerId: "17900000000000000001" })).toMatchObject({
      ok: false,
      outcome: "rejected",
    });
    expect(counts.publish).toBe(0);
    expect((await dry.createMediaContainer({ credential: "c", accountId: "17849990000000042", imageUrl: "https://local.invalid/x.jpg", caption: null })).ok).toBe(true);
  });

  it("recent-media reads are not available to the runtime", async () => {
    const { provider, counts } = inner();
    const guarded = withRuntimeCallCeiling(provider, { create: 0, status: 0, publish: 0 });
    expect((await guarded.listRecentMedia({ credential: "c", accountId: "17849990000000042" })).ok).toBe(false);
    expect(counts.recent).toBe(0);
  });
});
