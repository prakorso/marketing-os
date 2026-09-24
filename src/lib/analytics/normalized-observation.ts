import type { CanonicalMetric, MetricStates, MetricTimestampProvenance, SocialPlatform } from "@/types/database";

import type { RawProviderResponse } from "./raw-response";

/**
 * The Analytics Normalizer's (Decision #32/#41) pure output — everything
 * `recordPublicationMetricSnapshot` needs to persist a snapshot row,
 * already resolved to Marqos's normalized vocabulary and metric-state
 * model (Decisions #29, #33, #37, #38). `engagementRate` is carried
 * separately from `metrics`/`metricStates` — it has no state model of its
 * own (Decision #30: provider-reported only, no formula, no
 * unsupported/unavailable distinction defined). `rawResponse` is passed
 * through unchanged for persistence into `provider_metrics` (Decision #39:
 * raw fidelity is mandatory).
 */
export type NormalizedObservation = {
  provider: SocialPlatform;
  capturedAt: string;
  capturedAtProvenance: MetricTimestampProvenance;
  metrics: Record<CanonicalMetric, number | null>;
  metricStates: MetricStates;
  engagementRate: number | null;
  rawResponse: RawProviderResponse;
};
