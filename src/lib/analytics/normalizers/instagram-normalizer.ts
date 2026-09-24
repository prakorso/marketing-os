import { CANONICAL_METRICS, type CanonicalMetric, type MetricStates, type MetricTimestampProvenance } from "@/types/database";

import { AnalyticsNormalizationError } from "../normalization-error";
import type { NormalizedObservation } from "../normalized-observation";
import { INSTAGRAM_SUPPORTED_METRICS, isMetricSupported } from "../provider-capability";
import type { RawProviderResponse } from "../raw-response";

/**
 * Instagram Provider Normalizer (Decision #41; MVP-5.20). Understands
 * exactly the real Instagram Media Insights response shape verified in
 * MVP-5.17/5.18 (`InstagramProviderAdapter.getMetrics()`'s raw payload):
 *
 *   { data: [{ name, period, values: [{ value }], title, description, id }, ...] }
 *
 * `title`/`description`/`id` carry no Marqos-mapped meaning and are never
 * read — only `name` (the Instagram field) and `values[0].value` are
 * extracted, per the real evidence.
 *
 * Field mapping (MVP-5.17, both a FEED/CAROUSEL_ALBUM and a REELS/VIDEO
 * item, real evidence, identical mapping for both content types — no
 * content-type-conditional logic is introduced without evidence for one):
 *   reach    -> reach
 *   views    -> views
 *   likes    -> likes
 *   comments -> comments
 *   shares   -> shares
 *   saved    -> saves   (name differs)
 *
 * `impressions`/`clicks` are excluded via INSTAGRAM_SUPPORTED_METRICS
 * (MVP-5.18's real rejection evidence for impressions; MVP-5.13's finding
 * that clicks has no Instagram equivalent) — never requested, never
 * mapped, regardless of what a raw payload might contain.
 *
 * Pure and deterministic, no network I/O, no persistence (Decision #41) —
 * identical contract to normalizeMockProviderResponse. Omission/null/
 * malformed-value handling follows that same existing contract
 * unchanged: MVP-5.17 never observed a real omission or null case for
 * Instagram, so none of this is claimed as Instagram-specific evidence —
 * it is the pre-existing, provider-agnostic Marqos normalizer contract.
 */
export function normalizeInstagramProviderResponse(
  raw: RawProviderResponse,
  context: { collectedAt: string },
): NormalizedObservation {
  if (!raw || typeof raw !== "object") {
    throw new AnalyticsNormalizationError("Raw provider response is not a well-formed object", "malformed_response");
  }
  if (!raw.provider) {
    throw new AnalyticsNormalizationError("Raw provider response is missing provider identity", "missing_provider_identity");
  }

  const payload = raw.payload;
  if (!payload || typeof payload !== "object") {
    throw new AnalyticsNormalizationError("Raw provider response payload is not a well-formed object", "malformed_response");
  }

  const dataArray = (payload as Record<string, unknown>).data;
  if (!Array.isArray(dataArray)) {
    throw new AnalyticsNormalizationError("Raw Instagram response payload is missing a data array", "malformed_response");
  }

  // Real shape only: read `name` + `values[0].value`. Everything else on
  // each entry (title, description, id, period) is deliberately ignored.
  const byInstagramField = new Map<string, unknown>();
  for (const entry of dataArray) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name !== "string") continue;
    const values = (entry as Record<string, unknown>).values;
    const firstValue = Array.isArray(values) && values.length > 0 ? (values[0] as Record<string, unknown> | undefined)?.value : undefined;
    byInstagramField.set(name, firstValue);
  }

  const metrics = {} as Record<CanonicalMetric, number | null>;
  const metricStates = {} as MetricStates;

  for (const metric of CANONICAL_METRICS) {
    if (!isMetricSupported(INSTAGRAM_SUPPORTED_METRICS, metric)) {
      metrics[metric] = null;
      metricStates[metric] = { state: "unsupported" };
      continue;
    }

    // Every metric that passes isMetricSupported() above is guaranteed to
    // have an entry here — INSTAGRAM_SUPPORTED_METRICS and this map are
    // kept in lockstep by construction (both list exactly the same six
    // metrics).
    const instagramField = MARQOS_METRIC_TO_INSTAGRAM_FIELD[metric];
    if (!instagramField) {
      throw new AnalyticsNormalizationError(
        `No Instagram field mapping is declared for supported metric "${metric}" — capability declaration and field map are out of sync`,
        "capability_mapping_mismatch",
      );
    }
    const value = byInstagramField.get(instagramField);

    if (value === undefined || value === null) {
      // Capability says Instagram supports this metric, but this specific
      // response has no usable value for it — unavailable, not
      // unsupported (Decision #33). No real omission case has been
      // observed for Instagram (MVP-5.17) — this branch exists per the
      // pre-existing, provider-agnostic normalizer contract, not because
      // it has been evidenced for this provider specifically.
      metrics[metric] = null;
      metricStates[metric] = { state: "unavailable" };
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AnalyticsNormalizationError(
        `Malformed value for metric "${metric}" (Instagram field "${instagramField}")`,
        "malformed_metric_value",
      );
    }
    if (value < 0) {
      throw new AnalyticsNormalizationError(
        `Negative value is not a valid observed metric for "${metric}" (Instagram field "${instagramField}")`,
        "invalid_negative_metric",
      );
    }

    // A reported zero (MVP-5.17 real evidence: comments=0, saved=0 on
    // both a Feed and a Reel item) is a legitimate value, not omission.
    metrics[metric] = value;
    metricStates[metric] = { state: "reported" };
  }

  // engagement_rate (Decision #30): Instagram's Media Insights endpoint
  // has never been observed to return anything resembling a rate field
  // (MVP-5.17/5.18) — always null here, never computed, never fabricated.
  const engagementRate: number | null = null;

  const { capturedAt, capturedAtProvenance } = resolveCapturedAt(raw.observedAt, context.collectedAt);

  return {
    provider: raw.provider,
    capturedAt,
    capturedAtProvenance,
    metrics,
    metricStates,
    engagementRate,
    rawResponse: raw,
  };
}

/** MVP-5.17-verified: `saved` is the only field-name mismatch; every other supported metric shares its name with Instagram's own field. */
const MARQOS_METRIC_TO_INSTAGRAM_FIELD: Partial<Record<CanonicalMetric, string>> = {
  reach: "reach",
  views: "views",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saves: "saved",
};

/**
 * Decision #34/#38, identical to normalizeMockProviderResponse's own
 * private helper — duplicated rather than extracted into a shared module
 * this milestone, matching the one existing normalizer's established
 * self-contained-per-file shape rather than introducing a new shared-util
 * pattern not yet established anywhere in this codebase.
 *
 * MVP-5.17/5.18 real evidence: the Instagram Media Insights response
 * contains no observation timestamp of any kind — for this provider,
 * `raw.observedAt` will always be null (InstagramProviderAdapter.
 * getMetrics() sets it explicitly), so this always resolves through the
 * `marqos_fallback` branch. That is the correct, evidence-confirmed
 * outcome, not a gap.
 */
function resolveCapturedAt(
  observedAt: string | null | undefined,
  collectedAt: string,
): { capturedAt: string; capturedAtProvenance: MetricTimestampProvenance } {
  if (observedAt === undefined || observedAt === null) {
    return { capturedAt: collectedAt, capturedAtProvenance: "marqos_fallback" };
  }
  const parsed = new Date(observedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new AnalyticsNormalizationError("Provider observation timestamp could not be parsed", "malformed_observed_at");
  }
  return { capturedAt: parsed.toISOString(), capturedAtProvenance: "provider" };
}
