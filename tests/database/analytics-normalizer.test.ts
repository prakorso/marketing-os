import { describe, expect, it } from "vitest";

import { AnalyticsNormalizationError } from "@/lib/analytics/normalization-error";
import { resolveNormalizer } from "@/lib/analytics/normalizer-registry";
import { normalizeMockProviderResponse } from "@/lib/analytics/normalizers/mock-normalizer";
import type { RawProviderResponse } from "@/lib/analytics/raw-response";

/**
 * Pure, DB-free unit tests for the Analytics Normalizer (Decisions #32,
 * #33, #37, #38, #39, #41, #42) — mirrors this suite's convention of
 * separating pure-logic tests (no local Supabase required) from
 * service/DB-integration tests (analytics-service.test.ts,
 * analytics-fixture.test.ts). Always runs, regardless of local Supabase
 * availability.
 */
describe("Analytics Normalizer — normalizeMockProviderResponse", () => {
  const collectedAt = "2026-01-01T00:00:00.000Z";

  function rawResponse(overrides: Partial<RawProviderResponse["payload"]> = {}, observedAt?: string | null): RawProviderResponse {
    return {
      provider: "instagram",
      observedAt,
      payload: {
        mock: true,
        platform: "instagram",
        externalPublicationId: "ext-1",
        metrics: {
          impressions: 1000,
          reach: 800,
          views: 600,
          likes: 50,
          comments: 5,
          shares: 3,
          saves: 2,
          clicks: 10,
        },
        engagementRate: 0.05,
        ...overrides,
      },
    };
  }

  describe("raw preservation", () => {
    it("preserves the raw response unchanged as rawResponse on the observation", () => {
      const raw = rawResponse();
      const observation = normalizeMockProviderResponse(raw, { collectedAt });
      expect(observation.rawResponse).toBe(raw);
      expect(observation.rawResponse.payload).toEqual(raw.payload);
    });

    it("preserves provider identity", () => {
      const observation = normalizeMockProviderResponse(rawResponse(), { collectedAt });
      expect(observation.provider).toBe("instagram");
    });
  });

  describe("normalized metric values and reported state", () => {
    it("maps every canonical metric to reported with its numeric value", () => {
      const observation = normalizeMockProviderResponse(rawResponse(), { collectedAt });
      expect(observation.metrics).toEqual({
        impressions: 1000,
        reach: 800,
        views: 600,
        likes: 50,
        comments: 5,
        shares: 3,
        saves: 2,
        clicks: 10,
      });
      for (const metric of Object.values(observation.metricStates)) {
        expect(metric.state).toBe("reported");
      }
    });

    it("treats a reported zero as a legitimate reported value, not unavailable", () => {
      const observation = normalizeMockProviderResponse(
        rawResponse({ metrics: { impressions: 0, reach: 800, views: 600, likes: 50, comments: 5, shares: 3, saves: 2, clicks: 10 } }),
        { collectedAt },
      );
      expect(observation.metrics.impressions).toBe(0);
      expect(observation.metricStates.impressions.state).toBe("reported");
    });

    it("carries engagement_rate through unchanged as a provider-reported passthrough, no formula", () => {
      const observation = normalizeMockProviderResponse(rawResponse({ engagementRate: 0.123 }), { collectedAt });
      expect(observation.engagementRate).toBe(0.123);
    });

    it("engagement_rate is null, not fabricated, when absent from the raw payload", () => {
      const observation = normalizeMockProviderResponse(rawResponse({ engagementRate: undefined }), { collectedAt });
      expect(observation.engagementRate).toBeNull();
    });
  });

  describe("unavailable metric", () => {
    it("marks a metric unavailable (not zero, not null-as-reported) when the payload omits it", () => {
      const observation = normalizeMockProviderResponse(
        rawResponse({ metrics: { impressions: 1000, reach: 800, views: 600, likes: 50, comments: 5, shares: 3, clicks: 10 } }),
        { collectedAt },
      );
      expect(observation.metrics.saves).toBeNull();
      expect(observation.metricStates.saves.state).toBe("unavailable");
    });

    it("marks a metric unavailable via explicit unavailableMetrics even if a value happens to be present", () => {
      const observation = normalizeMockProviderResponse(rawResponse({ unavailableMetrics: ["likes"] }), { collectedAt });
      expect(observation.metrics.likes).toBeNull();
      expect(observation.metricStates.likes.state).toBe("unavailable");
    });
  });

  describe("unsupported metric", () => {
    it("marks a metric unsupported regardless of a present value, and never as zero", () => {
      const observation = normalizeMockProviderResponse(rawResponse({ unsupportedMetrics: ["saves"] }), { collectedAt });
      expect(observation.metrics.saves).toBeNull();
      expect(observation.metricStates.saves.state).toBe("unsupported");
    });

    it("unsupported takes precedence over a metric also listed as unavailable", () => {
      const observation = normalizeMockProviderResponse(
        rawResponse({ unsupportedMetrics: ["saves"], unavailableMetrics: ["saves"] }),
        { collectedAt },
      );
      expect(observation.metricStates.saves.state).toBe("unsupported");
    });
  });

  describe("malformed response rejection", () => {
    it("rejects a non-numeric metric value", () => {
      expect(() =>
        normalizeMockProviderResponse(rawResponse({ metrics: { impressions: "a lot" as unknown as number } }), { collectedAt }),
      ).toThrow(AnalyticsNormalizationError);
    });

    it("rejects NaN", () => {
      expect(() =>
        normalizeMockProviderResponse(rawResponse({ metrics: { impressions: Number.NaN } }), { collectedAt }),
      ).toThrow(AnalyticsNormalizationError);
    });

    it("rejects Infinity", () => {
      expect(() =>
        normalizeMockProviderResponse(rawResponse({ metrics: { impressions: Number.POSITIVE_INFINITY } }), { collectedAt }),
      ).toThrow(AnalyticsNormalizationError);
    });

    it("rejects a negative metric value", () => {
      expect(() => normalizeMockProviderResponse(rawResponse({ metrics: { impressions: -5 } }), { collectedAt })).toThrow(
        AnalyticsNormalizationError,
      );
    });

    it("rejects a response with no metrics object at all", () => {
      const raw = rawResponse();
      delete (raw.payload as Record<string, unknown>).metrics;
      expect(() => normalizeMockProviderResponse(raw, { collectedAt })).toThrow(AnalyticsNormalizationError);
    });

    it("rejects a response missing provider identity", () => {
      const raw = { ...rawResponse(), provider: undefined as never };
      expect(() => normalizeMockProviderResponse(raw, { collectedAt })).toThrow(AnalyticsNormalizationError);
    });

    it("rejects an unparseable provider observation timestamp", () => {
      expect(() => normalizeMockProviderResponse(rawResponse({}, "not-a-real-date"), { collectedAt })).toThrow(
        AnalyticsNormalizationError,
      );
    });
  });

  describe("observation timestamp", () => {
    it("uses the provider's observation time and marks provenance as 'provider' when present", () => {
      const observedAt = "2025-06-01T12:00:00.000Z";
      const observation = normalizeMockProviderResponse(rawResponse({}, observedAt), { collectedAt });
      expect(observation.capturedAt).toBe(new Date(observedAt).toISOString());
      expect(observation.capturedAtProvenance).toBe("provider");
    });

    it("falls back to Marqos collection time and marks provenance as 'marqos_fallback' when the provider exposes none", () => {
      const observation = normalizeMockProviderResponse(rawResponse({}, undefined), { collectedAt });
      expect(observation.capturedAt).toBe(collectedAt);
      expect(observation.capturedAtProvenance).toBe("marqos_fallback");
    });
  });

  describe("determinism", () => {
    it("is pure — identical input always produces an equivalent observation", () => {
      const raw = rawResponse();
      const first = normalizeMockProviderResponse(raw, { collectedAt });
      const second = normalizeMockProviderResponse(raw, { collectedAt });
      expect(first).toEqual(second);
    });
  });
});

describe("Analytics Normalizer Dispatcher — resolveNormalizer", () => {
  it("resolves a normalizer for every registered social platform", () => {
    for (const platform of ["instagram", "tiktok", "youtube", "threads"] as const) {
      expect(typeof resolveNormalizer(platform)).toBe("function");
    }
  });
});
