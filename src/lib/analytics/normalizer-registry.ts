import type { SocialPlatform } from "@/types/database";

import { normalizeInstagramProviderResponse } from "./normalizers/instagram-normalizer";
import { normalizeMockProviderResponse } from "./normalizers/mock-normalizer";
import type { NormalizedObservation } from "./normalized-observation";
import type { RawProviderResponse } from "./raw-response";

export type ProviderNormalizer = (raw: RawProviderResponse, context: { collectedAt: string }) => NormalizedObservation;

/**
 * Analytics Normalizer Dispatcher (Decision #41) — resolves a
 * provider-specific normalizer from a raw response's provider identity,
 * mirroring src/lib/social/registry.ts's/src/lib/ai/registry.ts's existing
 * per-key dispatch pattern exactly.
 *
 * MVP-5.20: Instagram is now real, verified (MVP-5.16–5.19) and routes to
 * its own normalizer — a real provider's normalizer replacing its single
 * registry entry without touching any caller, exactly the reusability
 * goal this registry already documented for itself. TikTok/YouTube/Threads
 * remain on the mock normalizer, unchanged: no real, verified integration
 * exists yet for any of them (Decision #39/#41's explicit non-decision).
 */
const registry: Record<SocialPlatform, ProviderNormalizer> = {
  instagram: normalizeInstagramProviderResponse,
  tiktok: normalizeMockProviderResponse,
  youtube: normalizeMockProviderResponse,
  threads: normalizeMockProviderResponse,
};

export function resolveNormalizer(platform: SocialPlatform): ProviderNormalizer {
  const normalizer = registry[platform];
  if (!normalizer) {
    throw new Error(`No Analytics Normalizer registered for platform: ${platform}`);
  }
  return normalizer;
}
