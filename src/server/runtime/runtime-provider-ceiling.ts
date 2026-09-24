import type { ProviderFailureDetails, StagedMediaPublisher } from "@/lib/social/provider";

/**
 * MVP-5.36 (Decision #44) — per-invocation provider MUTATION ceiling for the
 * Level-6 runtime: at most ONE container creation (G1) and at most ONE
 * publish request (G3), in addition to the claim cap of 1. A further
 * mutation is refused WITHOUT any network request (fail closed). Status
 * reads (G2) stay bounded by the execution deadline; recent-media reads are
 * not part of the runtime and are refused.
 */

export type RuntimeCallCounters = { create: number; status: number; publish: number };

const refused = (message: string): ProviderFailureDetails => ({
  code: "runtime_call_ceiling",
  message,
  httpStatus: null,
  providerCode: null,
  providerSubcode: null,
  fbtraceId: null,
});

export function withRuntimeCallCeiling(provider: StagedMediaPublisher, counters: RuntimeCallCounters): StagedMediaPublisher {
  return Object.freeze({
    async createMediaContainer(input) {
      if (counters.create >= 1) return { ok: false, ...refused("Refused: at most one container creation per runtime invocation") };
      counters.create += 1;
      return provider.createMediaContainer(input);
    },
    async getMediaContainerStatus(input) {
      counters.status += 1;
      return provider.getMediaContainerStatus(input);
    },
    async publishMediaContainer(input) {
      // Not dispatched ⇒ an authoritative, known-not-published refusal.
      if (counters.publish >= 1) return { ok: false, outcome: "rejected", ...refused("Refused: at most one publish request per runtime invocation") };
      counters.publish += 1;
      return provider.publishMediaContainer(input);
    },
    async listRecentMedia() {
      return { ok: false, ...refused("Recent media reads are not part of the runtime") };
    },
  } satisfies StagedMediaPublisher);
}
