import { CANONICAL_METRICS, type CanonicalMetric, type MetricStates, type MetricTimestampProvenance } from "@/types/database";

import { AnalyticsNormalizationError } from "../normalization-error";
import type { NormalizedObservation } from "../normalized-observation";
import { isMetricSupported, MOCK_PROVIDER_SUPPORTED_METRICS } from "../provider-capability";
import type { RawProviderResponse } from "../raw-response";

/**
 * Mock Provider Normalizer (Decision #41). Understands exactly the raw
 * payload shape `MockProviderAdapter`/`FixtureProviderAdapter`
 * (src/lib/social/provider.ts, src/lib/analytics/fixtures/) produce — a
 * mock-native shape, not a claim about any real platform's API. Registered
 * for all four platforms today (normalizer-registry.ts) because no real,
 * verified provider integration exists yet (Decision #39/#41's explicit
 * non-decision) — this is the same "one shared implementation until a real
 * one is verified" posture src/lib/social/registry.ts already establishes
 * for adapters.
 *
 * Pure and deterministic: given the same raw response and context, always
 * produces the same NormalizedObservation. No network I/O, no persistence
 * (Decision #41).
 */
export function normalizeMockProviderResponse(
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

  const metricsRaw = (payload as Record<string, unknown>).metrics;
  if (!metricsRaw || typeof metricsRaw !== "object") {
    throw new AnalyticsNormalizationError("Raw provider response payload is missing a metrics object", "malformed_response");
  }

  const unsupportedMetrics = readCanonicalMetricArray((payload as Record<string, unknown>).unsupportedMetrics);
  const unavailableMetrics = readCanonicalMetricArray((payload as Record<string, unknown>).unavailableMetrics);
  const supportedMetrics = MOCK_PROVIDER_SUPPORTED_METRICS.filter((metric) => !unsupportedMetrics.includes(metric));

  const metrics = {} as Record<CanonicalMetric, number | null>;
  const metricStates = {} as MetricStates;

  for (const metric of CANONICAL_METRICS) {
    if (!isMetricSupported(supportedMetrics, metric)) {
      metrics[metric] = null;
      metricStates[metric] = { state: "unsupported" };
      continue;
    }
    if (unavailableMetrics.includes(metric)) {
      metrics[metric] = null;
      metricStates[metric] = { state: "unavailable" };
      continue;
    }

    const value = (metricsRaw as Record<string, unknown>)[metric];
    if (value === undefined || value === null) {
      // Supported by capability, but this specific response has no usable
      // value for it — unavailable, not unsupported (Decision #33).
      metrics[metric] = null;
      metricStates[metric] = { state: "unavailable" };
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AnalyticsNormalizationError(`Malformed value for metric "${metric}"`, "malformed_metric_value");
    }
    if (value < 0) {
      throw new AnalyticsNormalizationError(`Negative value is not a valid observed metric for "${metric}"`, "invalid_negative_metric");
    }

    metrics[metric] = value;
    metricStates[metric] = { state: "reported" };
  }

  // engagement_rate: provider-reported passthrough only (Decision #30) —
  // no state model, no formula, absent is simply null.
  const engagementRateRaw = (payload as Record<string, unknown>).engagementRate;
  let engagementRate: number | null = null;
  if (engagementRateRaw !== undefined && engagementRateRaw !== null) {
    if (typeof engagementRateRaw !== "number" || !Number.isFinite(engagementRateRaw)) {
      throw new AnalyticsNormalizationError("Malformed engagement_rate value", "malformed_engagement_rate");
    }
    engagementRate = engagementRateRaw;
  }

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

/** Decision #34/#38: provider observation time when present and parseable; otherwise the Marqos collection time, with explicit provenance. */
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

function readCanonicalMetricArray(value: unknown): CanonicalMetric[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CanonicalMetric => CANONICAL_METRICS.includes(entry as CanonicalMetric));
}
