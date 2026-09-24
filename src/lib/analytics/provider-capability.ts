import { CANONICAL_METRICS, type CanonicalMetric } from "@/types/database";

/**
 * Decision #42 (MVP-5.10D/E): provider capability is a static, code-level
 * declaration — never a database table, never inferred from a single
 * response (Decision #33: that would conflate "unsupported" with
 * "unavailable", exactly the ambiguity this exists to remove).
 *
 * No real platform's capability is declared here. This codebase has no
 * verified, real provider integration (only the mock/fixture path), so
 * claiming to know what Instagram/TikTok/YouTube/Threads actually support
 * would be an invented, unverified fact — forbidden by Decision #39/#42.
 * The mock capability below describes only the deterministic testing
 * construct itself (`MockProviderAdapter`/`FixtureProviderAdapter`), which
 * supports every canonical metric by declaration, since it does not model
 * any real platform's limitations.
 */
export const MOCK_PROVIDER_SUPPORTED_METRICS: readonly CanonicalMetric[] = CANONICAL_METRICS;

/**
 * MVP-5.17/5.18: Instagram's real, observed capability — not documentation,
 * not assumption. `reach`, `views`, `likes`, `comments`, `shares`, `saves`
 * were all successfully retrieved from real Media Insights responses for
 * both a FEED/CAROUSEL_ALBUM and a REELS/VIDEO item. `impressions` was
 * explicitly tested (MVP-5.18) and rejected by the real API with HTTP 400
 * ("The Media Insights API does not support the impressions metric for
 * this media product type") — excluded here, not merely unrequested.
 * `clicks` has no verified Instagram field at all (MVP-5.13) and is never
 * requested. Neither exclusion is an assumption; both are evidence-backed.
 */
export const INSTAGRAM_SUPPORTED_METRICS: readonly CanonicalMetric[] = ["reach", "views", "likes", "comments", "shares", "saves"];

export function isMetricSupported(supportedMetrics: readonly CanonicalMetric[], metric: CanonicalMetric): boolean {
  return supportedMetrics.includes(metric);
}
