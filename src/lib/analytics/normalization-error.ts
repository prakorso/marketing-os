/**
 * Thrown by an Analytics Normalizer (Decision #41) when a raw provider
 * response cannot be normalized at all — a malformed response, missing
 * provider identity, an unparseable provider timestamp, or a
 * structurally-impossible metric value (NaN, infinite, negative).
 * Distinct from `ProviderError` (src/lib/social/provider.ts), which
 * represents the provider CALL failing; this represents the call
 * succeeding but returning something the normalizer cannot honestly
 * translate. Neither produces a `publication_metric_snapshots` row
 * (Decision #33: a collection-level condition, not a metric state).
 */
export class AnalyticsNormalizationError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AnalyticsNormalizationError";
    this.code = code;
  }
}
