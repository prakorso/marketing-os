import { describe, expect, it } from "vitest";

import {
  formatCapturedAt,
  formatEngagementRate,
  formatFreshnessLabel,
  formatMetricForDisplay,
  formatProvenanceLabel,
} from "@/lib/analytics/ui-format";

/**
 * MVP-5.11: pure-logic tests for the Analytics UI's formatting/labeling
 * rules — proves the semantic contracts (Decisions #29, #30, #33, #34,
 * #35, #37, #38) at the presentation boundary, without needing a
 * component-testing library.
 */
describe("formatMetricForDisplay", () => {
  it("renders a reported non-zero value as a formatted number, marked as a value", () => {
    expect(formatMetricForDisplay(1234, "reported")).toEqual({ text: "1,234", isValue: true });
  });

  it("renders a reported zero as an actual '0', not as unavailable", () => {
    expect(formatMetricForDisplay(0, "reported")).toEqual({ text: "0", isValue: true });
  });

  it("renders unavailable distinctly, never as 0", () => {
    const result = formatMetricForDisplay(null, "unavailable");
    expect(result.text).not.toBe("0");
    expect(result.text).toBe("Unavailable");
    expect(result.isValue).toBe(false);
  });

  it("renders unsupported distinctly, never as 0, and distinctly from unavailable", () => {
    const result = formatMetricForDisplay(null, "unsupported");
    expect(result.text).not.toBe("0");
    expect(result.text).toBe("Unsupported");
    expect(result.text).not.toBe(formatMetricForDisplay(null, "unavailable").text);
    expect(result.isValue).toBe(false);
  });
});

describe("formatProvenanceLabel", () => {
  it("labels provider-observed time honestly", () => {
    expect(formatProvenanceLabel("provider")).toBe("Observed by provider");
  });

  it("labels a Marqos fallback honestly, never implying it is provider-reported", () => {
    const label = formatProvenanceLabel("marqos_fallback");
    expect(label).not.toMatch(/provider/i);
    expect(label).toBe("Captured by Marqos (fallback)");
  });
});

describe("formatFreshnessLabel", () => {
  it("states the fact of a successful sync without a freshness/staleness judgment", () => {
    const label = formatFreshnessLabel("2026-01-01T00:00:00.000Z");
    expect(label).toMatch(/^Last successful sync:/);
    expect(label.toLowerCase()).not.toMatch(/fresh|stale|recently|up to date/);
  });

  it("is honest when no sync has ever succeeded", () => {
    expect(formatFreshnessLabel(null)).toBe("Never synced");
  });
});

describe("formatEngagementRate", () => {
  it("renders the stored value as-is, never rescaled into a percentage", () => {
    expect(formatEngagementRate(0.05)).toBe("0.05");
  });

  it("is honest when not reported", () => {
    expect(formatEngagementRate(null)).toBe("Not reported");
  });
});

describe("formatCapturedAt", () => {
  it("renders a readable timestamp", () => {
    expect(formatCapturedAt("2026-01-01T00:00:00.000Z")).toEqual(expect.any(String));
    expect(formatCapturedAt("2026-01-01T00:00:00.000Z").length).toBeGreaterThan(0);
  });
});
