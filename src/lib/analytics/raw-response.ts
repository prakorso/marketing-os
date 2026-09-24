import type { SocialPlatform } from "@/types/database";

/**
 * Decision #39 (MVP-5.10D/E): the generic raw-response envelope a
 * SocialProviderAdapter returns from `getMetrics()`. Replaces the
 * previously-normalized `ProviderMetricsResult` at the adapter boundary —
 * the adapter's job is now exactly "call the provider, return what it
 * said," never normalization (Decision #41).
 *
 * `payload` is untouched, provider-native, and unshaped by design — no
 * per-provider TypeScript response shape is defined here, because no real
 * provider has been integrated and verified yet (Decision #39's own
 * explicit non-decision). `observedAt` is optional because not every
 * provider (and not every mock/fixture scenario) supplies one — its
 * absence is exactly what drives the `captured_at` fallback (Decision #38).
 */
export type RawProviderResponse = {
  provider: SocialPlatform;
  observedAt?: string | null;
  payload: Record<string, unknown>;
};
