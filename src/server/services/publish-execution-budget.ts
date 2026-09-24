/**
 * MVP-5.35C-D — execution budget for staged publishing inside the PROVEN
 * 60 s Netlify synchronous/streaming limit (MVP-5.35C-C §13). The
 * application never plans to use more than `totalMs` (45 s), leaving 15 s
 * of platform headroom.
 *
 * Allocation (all ceilings, not targets):
 *   preparation + create (≤ provider timeout) + polling (≤ pollBudgetMs)
 *   must leave `publishReserveMs` (the irreversible media_publish request)
 *   PLUS `finalPersistenceReserveMs` (attempt + publication writes) intact.
 *
 * Rules enforced by callers:
 *   - pre-publish provider calls get min(providerRequestTimeoutMs,
 *     remaining − (publish reserve + persistence reserve));
 *   - polling stops before eating into those reserves;
 *   - before publish_requested is written, remaining must be ≥ both
 *     reserves, otherwise the attempt fails KNOWN-NOT-PUBLISHED
 *     (insufficient_publish_time_budget) and media_publish is never invoked;
 *   - media_publish gets min(providerRequestTimeoutMs, remaining −
 *     persistence reserve); if it runs out, the result is OUTCOME_UNKNOWN.
 *
 * The clock is injected (monotonic performance.now() by default) so
 * deadline behavior is deterministic in tests.
 */

export type ExecutionBudgetConfig = {
  totalMs: number;
  providerRequestTimeoutMs: number;
  pollBudgetMs: number;
  pollIntervalMs: number;
  publishReserveMs: number;
  finalPersistenceReserveMs: number;
  /** A pre-publish provider call is not started with less than this much time. */
  minimumProviderCallMs: number;
};

export const DEFAULT_EXECUTION_BUDGET: Readonly<ExecutionBudgetConfig> = Object.freeze({
  totalMs: 45_000,
  providerRequestTimeoutMs: 10_000,
  pollBudgetMs: 15_000,
  pollIntervalMs: 2_000,
  publishReserveMs: 12_000,
  finalPersistenceReserveMs: 5_000,
  minimumProviderCallMs: 1_000,
});

export const PLATFORM_SYNC_LIMIT_MS = 60_000;

/** A platform execution ceiling plus the headroom the application must never plan to use. */
export type PlatformLimit = { limitMs: number; minHeadroomMs: number };

/** Netlify synchronous/streaming functions (MVP-5.35C-C): 60 s, 15 s headroom. */
export const SYNC_FUNCTION_PLATFORM: Readonly<PlatformLimit> = Object.freeze({ limitMs: PLATFORM_SYNC_LIMIT_MS, minHeadroomMs: 15_000 });

/**
 * MVP-5.36 (Decision #44): Netlify Scheduled Functions have a documented
 * 30 s execution limit; the Level-6 runtime plans at most 25 s.
 */
export const SCHEDULED_FUNCTION_LIMIT_MS = 30_000;
export const SCHEDULED_FUNCTION_PLATFORM: Readonly<PlatformLimit> = Object.freeze({ limitMs: SCHEDULED_FUNCTION_LIMIT_MS, minHeadroomMs: 5_000 });

/**
 * Level-6 scheduler budget (≤ 25 s, whole invocation). Worst case of the
 * provider ceilings before publish (create 5 s + polling 6 s = 11 s) plus
 * both reserves (5 s publish + 3 s persistence) = 19 s, leaving ≥ 6 s for
 * the control read, reconciliation, claim, loads and the Vault read.
 */
export const SCHEDULER_EXECUTION_BUDGET: Readonly<ExecutionBudgetConfig> = Object.freeze({
  totalMs: 25_000,
  providerRequestTimeoutMs: 5_000,
  pollBudgetMs: 6_000,
  pollIntervalMs: 1_500,
  publishReserveMs: 5_000,
  finalPersistenceReserveMs: 3_000,
  minimumProviderCallMs: 1_000,
});

export function assertBudgetFitsPlatform(config: ExecutionBudgetConfig, platform: PlatformLimit = SYNC_FUNCTION_PLATFORM): void {
  if (config.totalMs > platform.limitMs - platform.minHeadroomMs) {
    throw new Error(`Execution budget must leave at least ${platform.minHeadroomMs / 1000} s of platform headroom`);
  }
  if (config.publishReserveMs < config.providerRequestTimeoutMs) {
    throw new Error("The publish reserve must cover a full provider request timeout");
  }
}

const monotonicNow = () => performance.now();

export class ExecutionDeadline {
  readonly config: ExecutionBudgetConfig;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(options: { now?: () => number; config?: Partial<ExecutionBudgetConfig>; platform?: PlatformLimit } = {}) {
    this.config = { ...DEFAULT_EXECUTION_BUDGET, ...(options.config ?? {}) };
    assertBudgetFitsPlatform(this.config, options.platform);
    this.now = options.now ?? monotonicNow;
    this.startedAt = this.now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  remainingMs(): number {
    return this.config.totalMs - this.elapsedMs();
  }

  /** Time reserved for the irreversible request and the final writes. */
  private protectedReserveMs(): number {
    return this.config.publishReserveMs + this.config.finalPersistenceReserveMs;
  }

  /** Remaining time usable by pre-publish work without touching the reserves. */
  prePublishRemainingMs(): number {
    return this.remainingMs() - this.protectedReserveMs();
  }

  /** Timeout for a pre-publish provider call, or null if it must not start. */
  prePublishCallTimeoutMs(): number | null {
    const available = this.prePublishRemainingMs();
    if (available < this.config.minimumProviderCallMs) return null;
    return Math.min(this.config.providerRequestTimeoutMs, available);
  }

  /** The pre-irreversible gate: true only if both reserves are fully available. */
  canStartPublish(): boolean {
    return this.remainingMs() >= this.protectedReserveMs();
  }

  /** Timeout for media_publish itself; always leaves the persistence reserve. */
  publishCallTimeoutMs(): number {
    return Math.max(0, Math.min(this.config.providerRequestTimeoutMs, this.remainingMs() - this.config.finalPersistenceReserveMs));
  }
}
