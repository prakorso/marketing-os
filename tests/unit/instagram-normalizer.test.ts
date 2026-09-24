import { describe, expect, it } from "vitest";

import { AnalyticsNormalizationError } from "@/lib/analytics/normalization-error";
import { resolveNormalizer } from "@/lib/analytics/normalizer-registry";
import { normalizeInstagramProviderResponse } from "@/lib/analytics/normalizers/instagram-normalizer";
import type { RawProviderResponse } from "@/lib/analytics/raw-response";

/**
 * MVP-5.20: fixtures mirror the REAL response shapes captured in MVP-5.17
 * (evidence/instagram/mvp-5.17-real-oauth-and-insights-capture.json) and
 * MVP-5.18 (mvp-5.18-impressions-and-rate-limit-capture.json) — field
 * names, nesting, and the six real metric values are as observed. Only
 * the malformed-data fixtures are not drawn from a real capture, per the
 * task's own allowance for defensive-path testing.
 */

const collectedAt = "2026-01-01T00:00:00.000Z";

// MVP-5.17 real Feed (CAROUSEL_ALBUM) Insights response.
const REAL_FEED_INSIGHTS_PAYLOAD = {
  data: [
    { name: "reach", period: "lifetime", values: [{ value: 384 }], title: "Accounts reached", description: "...", id: "18100000000033712/insights/reach/lifetime" },
    { name: "likes", period: "lifetime", values: [{ value: 7 }], title: "Likes", description: "...", id: "18100000000033712/insights/likes/lifetime" },
    { name: "comments", period: "lifetime", values: [{ value: 0 }], title: "Comments", description: "...", id: "18100000000033712/insights/comments/lifetime" },
    { name: "shares", period: "lifetime", values: [{ value: 4 }], title: "Shares", description: "...", id: "18100000000033712/insights/shares/lifetime" },
    { name: "saved", period: "lifetime", values: [{ value: 0 }], title: "Saved", description: "...", id: "18100000000033712/insights/saved/lifetime" },
    { name: "views", period: "lifetime", values: [{ value: 626 }], title: "Views", description: "...", id: "18100000000033712/insights/views/lifetime" },
  ],
};

// MVP-5.17 real Reel (REELS) Insights response.
const REAL_REEL_INSIGHTS_PAYLOAD = {
  data: [
    { name: "reach", period: "lifetime", values: [{ value: 393 }], title: "Accounts reached", description: "...", id: "18100000000516633/insights/reach/lifetime" },
    { name: "likes", period: "lifetime", values: [{ value: 9 }], title: "Likes", description: "...", id: "18100000000516633/insights/likes/lifetime" },
    { name: "comments", period: "lifetime", values: [{ value: 0 }], title: "Comments", description: "...", id: "18100000000516633/insights/comments/lifetime" },
    { name: "shares", period: "lifetime", values: [{ value: 1 }], title: "Shares", description: "...", id: "18100000000516633/insights/shares/lifetime" },
    { name: "saved", period: "lifetime", values: [{ value: 0 }], title: "Saved", description: "...", id: "18100000000516633/insights/saved/lifetime" },
    { name: "views", period: "lifetime", values: [{ value: 483 }], title: "Views", description: "...", id: "18100000000516633/insights/views/lifetime" },
  ],
};

function rawResponse(payload: Record<string, unknown>, observedAt: string | null = null): RawProviderResponse {
  return { provider: "instagram", observedAt, payload };
}

describe("normalizeInstagramProviderResponse — real Feed/Reel field mapping", () => {
  it("1. reach -> reach", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.reach).toBe(384);
    expect(observation.metricStates.reach.state).toBe("reported");
  });

  it("2. views -> views", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.views).toBe(626);
    expect(observation.metricStates.views.state).toBe("reported");
  });

  it("3. likes -> likes", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.likes).toBe(7);
    expect(observation.metricStates.likes.state).toBe("reported");
  });

  it("4. comments -> comments", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.comments).toBe(0);
    expect(observation.metricStates.comments.state).toBe("reported");
  });

  it("5. shares -> shares", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.shares).toBe(4);
    expect(observation.metricStates.shares.state).toBe("reported");
  });

  it("6. saved (Instagram field) -> saves (Marqos canonical metric)", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.saves).toBe(0);
    expect(observation.metricStates.saves.state).toBe("reported");
  });

  it("7. explicit real value 0 (comments, saved) remains reported with value 0 — never unavailable, never omitted", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.comments).toBe(0);
    expect(observation.metricStates.comments.state).toBe("reported");
    expect(observation.metrics.saves).toBe(0);
    expect(observation.metricStates.saves.state).toBe("reported");
  });

  it("8. Feed/CAROUSEL_ALBUM response normalizes correctly (full real payload)", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics).toEqual({
      impressions: null,
      reach: 384,
      views: 626,
      likes: 7,
      comments: 0,
      shares: 4,
      saves: 0,
      clicks: null,
    });
  });

  it("9. Reel/REELS response normalizes correctly (full real payload), identical mapping to Feed", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_REEL_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics).toEqual({
      impressions: null,
      reach: 393,
      views: 483,
      likes: 9,
      comments: 0,
      shares: 1,
      saves: 0,
      clicks: null,
    });
  });

  it("10. title/description/provider metric id are ignored — never treated as metrics themselves", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    const metricNames = Object.keys(observation.metrics);
    expect(metricNames).not.toContain("title");
    expect(metricNames).not.toContain("description");
    expect(metricNames).not.toContain("id");
  });

  it("11. impressions is never normalized as a supported metric, even if present in a raw payload", () => {
    const payloadWithImpressions = {
      data: [...REAL_FEED_INSIGHTS_PAYLOAD.data, { name: "impressions", period: "lifetime", values: [{ value: 999 }] }],
    };
    const observation = normalizeInstagramProviderResponse(rawResponse(payloadWithImpressions), { collectedAt });
    expect(observation.metrics.impressions).toBeNull();
    expect(observation.metricStates.impressions.state).toBe("unsupported");
  });

  it("12. clicks is never normalized as a supported metric", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    expect(observation.metrics.clicks).toBeNull();
    expect(observation.metricStates.clicks.state).toBe("unsupported");
  });

  it("13. absence of an observation timestamp follows the existing marqos_fallback contract (MVP-5.17: real responses never carry one)", () => {
    const observation = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD, null), { collectedAt });
    expect(observation.capturedAt).toBe(collectedAt);
    expect(observation.capturedAtProvenance).toBe("marqos_fallback");
  });

  it("14. multiple metrics in one response normalize independently (Feed and Reel differ in values, not shape)", () => {
    const feed = normalizeInstagramProviderResponse(rawResponse(REAL_FEED_INSIGHTS_PAYLOAD), { collectedAt });
    const reel = normalizeInstagramProviderResponse(rawResponse(REAL_REEL_INSIGHTS_PAYLOAD), { collectedAt });
    expect(feed.metrics.likes).toBe(7);
    expect(reel.metrics.likes).toBe(9);
    expect(feed.metrics.shares).not.toBe(reel.metrics.shares);
  });

  describe("15. malformed provider data follows the existing normalizer failure/omission contract (not claimed as real Instagram evidence)", () => {
    it("throws AnalyticsNormalizationError when payload has no data array", () => {
      expect(() => normalizeInstagramProviderResponse(rawResponse({ notData: [] }), { collectedAt })).toThrow(AnalyticsNormalizationError);
    });

    it("a metric absent from data[] is unavailable, not omitted-as-error — the pre-existing, provider-agnostic contract, not Instagram-specific evidence", () => {
      const partialPayload = { data: REAL_FEED_INSIGHTS_PAYLOAD.data.filter((entry) => entry.name !== "shares") };
      const observation = normalizeInstagramProviderResponse(rawResponse(partialPayload), { collectedAt });
      expect(observation.metrics.shares).toBeNull();
      expect(observation.metricStates.shares.state).toBe("unavailable");
    });

    it("throws on a non-numeric value", () => {
      const malformed = { data: [{ name: "reach", values: [{ value: "not-a-number" }] }] };
      expect(() => normalizeInstagramProviderResponse(rawResponse(malformed), { collectedAt })).toThrow(AnalyticsNormalizationError);
    });

    it("throws on a negative value", () => {
      const malformed = { data: [{ name: "reach", values: [{ value: -5 }] }] };
      expect(() => normalizeInstagramProviderResponse(rawResponse(malformed), { collectedAt })).toThrow(AnalyticsNormalizationError);
    });
  });

  it("16. registry resolves 'instagram' to the real Instagram normalizer", () => {
    const normalizer = resolveNormalizer("instagram");
    expect(normalizer).toBe(normalizeInstagramProviderResponse);
  });
});
