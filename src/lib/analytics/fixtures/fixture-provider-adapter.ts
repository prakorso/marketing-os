import type { RawProviderResponse } from "@/lib/analytics/raw-response";
import {
  MockProviderAdapter,
  ProviderError,
  type ProviderMetricsInput,
  type ProviderPublishInput,
  type ProviderPublishResult,
  type SocialProviderAdapter,
} from "@/lib/social/provider";
import type { CanonicalMetric } from "@/types/database";

/**
 * Decision #36/#39/#41 (Fixture Parity): a test-only, deterministic,
 * production-shaped adapter — never registered in
 * src/lib/social/registry.ts, never reachable from production code.
 * Injected directly into `recordPublicationMetricSnapshot`'s optional
 * `deps.adapter` (the same test-only dependency-injection seam already
 * established for src/server/services/ai.ts's `generateText`/
 * `generateImage`), so a fixture scenario exercises the exact same
 * Analytics Normalizer → Analytics Service → Metric Snapshot path
 * production and MockProviderAdapter both use — never a direct table
 * insert (Decision #36).
 *
 * Each instance is scenario-scoped and stateful only within itself (a
 * per-call counter driving GROWTH/DECLINE), so concurrent tests using
 * their own instances never interfere with each other or with the shared
 * MockProviderAdapter singleton in the production registry.
 */
export type FixtureScenario =
  | "stable"
  | "growth"
  | "decline"
  | "zero_activity"
  | "missing_metric"
  | "unsupported_metric"
  | "timestamp_present"
  | "timestamp_fallback"
  | "provider_failure"
  | "malformed";

export class FixtureProviderAdapter implements SocialProviderAdapter {
  private callCount = 0;
  private readonly delegate = new MockProviderAdapter();

  constructor(
    private readonly scenario: FixtureScenario,
    private readonly options: { metric?: CanonicalMetric } = {},
  ) {}

  /** Fixtures don't need scenario-specific publish behavior — delegates to the same deterministic mock publish() every adapter already shares. */
  async publish(input: ProviderPublishInput): Promise<ProviderPublishResult> {
    return this.delegate.publish(input);
  }

  async getMetrics(input: ProviderMetricsInput): Promise<RawProviderResponse> {
    const callIndex = this.callCount;
    this.callCount += 1;
    const platform = input.socialAccount.platform;

    if (this.scenario === "provider_failure") {
      throw new ProviderError("Fixture provider forced failure", "fixture_forced_failure", {
        fixture: true,
        platform,
        scenario: this.scenario,
      });
    }

    if (this.scenario === "malformed") {
      return {
        provider: platform,
        observedAt: new Date().toISOString(),
        payload: {
          fixture: true,
          platform,
          externalPublicationId: input.externalPublicationId,
          // Deliberately malformed — exercises AnalyticsNormalizationError,
          // not a fabricated real-provider quirk.
          metrics: { impressions: Number.NaN },
        },
      };
    }

    const base = 100;
    let impressions = base;
    if (this.scenario === "growth") impressions = base + callIndex * 50;
    if (this.scenario === "decline") impressions = Math.max(0, base - callIndex * 30);
    if (this.scenario === "zero_activity") impressions = 0;

    const metrics: Record<string, number> = {
      impressions,
      reach: Math.round(impressions * 0.8),
      views: Math.round(impressions * 0.6),
      likes: Math.round(impressions * 0.05),
      comments: Math.round(impressions * 0.005),
      shares: Math.round(impressions * 0.003),
      saves: Math.round(impressions * 0.002),
      clicks: Math.round(impressions * 0.01),
    };

    const unavailableMetrics: string[] = [];
    const unsupportedMetrics: string[] = [];
    if (this.scenario === "missing_metric") {
      unavailableMetrics.push(this.options.metric ?? "reach");
    }
    if (this.scenario === "unsupported_metric") {
      unsupportedMetrics.push(this.options.metric ?? "saves");
    }

    const observedAt = this.scenario === "timestamp_fallback" ? undefined : new Date().toISOString();

    return {
      provider: platform,
      observedAt,
      payload: {
        fixture: true,
        platform,
        externalPublicationId: input.externalPublicationId,
        metrics,
        unavailableMetrics: unavailableMetrics.length > 0 ? unavailableMetrics : undefined,
        unsupportedMetrics: unsupportedMetrics.length > 0 ? unsupportedMetrics : undefined,
        engagementRate: this.scenario === "zero_activity" ? 0 : 0.04 + callIndex * 0.001,
        scenario: this.scenario,
      },
    };
  }
}
