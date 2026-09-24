import { CANONICAL_METRICS, type CanonicalMetric, type MetricObservationState, type MetricTimestampProvenance } from "@/types/database";

/**
 * MVP-5.11 (Analytics UI Foundation): pure, DB-free formatting/labeling
 * logic, deliberately separated from JSX so the semantic rules the UI must
 * respect (Decisions #29, #33, #37, #38 — a metric's state must never be
 * collapsed into its numeric value; zero is never confused with
 * unavailable/unsupported; a fallback timestamp is never presented as a
 * provider-verified one) are directly unit-testable without a component-
 * testing library, matching this codebase's existing test infrastructure
 * (tests/unit/, wired to `npm run test:unit`, previously empty).
 */

export const CANONICAL_METRIC_LABELS: Record<CanonicalMetric, string> = {
  impressions: "Impressions",
  reach: "Reach",
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  clicks: "Clicks",
};

export { CANONICAL_METRICS };

export type MetricDisplay = {
  /** The exact text to render in the cell. */
  text: string;
  /** Whether this represents an actual reported number (including zero) — drives numeric styling (JetBrains Mono) vs. a muted state label. */
  isValue: boolean;
};

/**
 * Decision #33/#37: a metric's displayed text must always distinguish a
 * reported value (including zero) from unavailable and from unsupported —
 * never rendering the latter two as "0", and never rendering a reported
 * zero as if it were missing.
 */
export function formatMetricForDisplay(value: number | null, state: MetricObservationState): MetricDisplay {
  if (state === "reported") {
    // `value` is guaranteed non-null when state is "reported" (enforced by
    // the database CHECK constraint) — the `?? 0` here is a defensive
    // fallback for a malformed row, not an expected path, and still
    // renders a real number rather than silently showing "unavailable".
    return { text: value === null ? "0" : value.toLocaleString("en-US"), isValue: true };
  }
  if (state === "unsupported") {
    return { text: "Unsupported", isValue: false };
  }
  return { text: "Unavailable", isValue: false };
}

/**
 * Decision #34/#38: honest, non-equivalent language for the two possible
 * sources of captured_at — never implies a Marqos fallback was actually
 * reported by the provider.
 */
export function formatProvenanceLabel(provenance: MetricTimestampProvenance): string {
  return provenance === "provider" ? "Observed by provider" : "Captured by Marqos (fallback)";
}

/**
 * Decision #35: last_synced_at is account-level, and this label must never
 * claim freshness ("fresh"/"stale"/"recently updated") — no threshold
 * exists to support such a claim. It states only the fact.
 */
export function formatFreshnessLabel(lastSyncedAt: string | null): string {
  if (!lastSyncedAt) {
    return "Never synced";
  }
  return `Last successful sync: ${new Date(lastSyncedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

/**
 * Decision #30/#31: engagement_rate is provider-reported only, with no
 * canonical unit convention (Decision #30 never establishes whether a
 * real provider's value is a 0–1 fraction, an already-computed
 * percentage, or something else). Converting it to a "%" here would
 * silently assert a unit interpretation nothing canonical supports — so
 * this renders the stored value exactly as recorded, never rescaled,
 * never formatted as a percentage, never labeled as a Marqos formula.
 */
export function formatEngagementRate(value: number | null): string {
  if (value === null) return "Not reported";
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function formatCapturedAt(capturedAt: string): string {
  return new Date(capturedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
