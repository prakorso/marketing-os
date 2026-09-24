import { describe, expect, it } from "vitest";

import {
  assertBudgetFitsPlatform,
  DEFAULT_EXECUTION_BUDGET,
  ExecutionDeadline,
  PLATFORM_SYNC_LIMIT_MS,
  SCHEDULED_FUNCTION_LIMIT_MS,
  SCHEDULED_FUNCTION_PLATFORM,
  SCHEDULER_EXECUTION_BUDGET,
} from "@/server/services/publish-execution-budget";

/** MVP-5.35C-D — execution budget inside the PROVEN 60 s Netlify limit. */

function clockAt(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("ExecutionDeadline", () => {
  it("defaults: 45 s application budget (≥ 15 s headroom), ≤ 10 s requests, 15 s polling, 12 s publish + 5 s persistence reserves", () => {
    expect(DEFAULT_EXECUTION_BUDGET).toMatchObject({
      totalMs: 45_000,
      providerRequestTimeoutMs: 10_000,
      pollBudgetMs: 15_000,
      publishReserveMs: 12_000,
      finalPersistenceReserveMs: 5_000,
    });
    expect(PLATFORM_SYNC_LIMIT_MS - DEFAULT_EXECUTION_BUDGET.totalMs).toBeGreaterThanOrEqual(15_000);
    // Worst case of every pre-publish ceiling + both reserves fits the application budget.
    const worstPrePublish = DEFAULT_EXECUTION_BUDGET.providerRequestTimeoutMs + DEFAULT_EXECUTION_BUDGET.pollBudgetMs;
    expect(worstPrePublish + DEFAULT_EXECUTION_BUDGET.publishReserveMs + DEFAULT_EXECUTION_BUDGET.finalPersistenceReserveMs).toBeLessThanOrEqual(
      DEFAULT_EXECUTION_BUDGET.totalMs,
    );
  });

  it("rejects configurations that eat the platform headroom or under-reserve the publish call", () => {
    expect(() => assertBudgetFitsPlatform({ ...DEFAULT_EXECUTION_BUDGET, totalMs: 50_000 })).toThrow(/headroom/);
    expect(() => assertBudgetFitsPlatform({ ...DEFAULT_EXECUTION_BUDGET, publishReserveMs: 5_000 })).toThrow(/publish reserve/);
  });

  it("caps pre-publish provider timeouts by the remaining budget minus both reserves", () => {
    const clock = clockAt();
    const d = new ExecutionDeadline({ now: clock.now });
    expect(d.prePublishCallTimeoutMs()).toBe(10_000);
    clock.advance(24_000); // remaining 21 s; reserves 17 s → 4 s usable
    expect(d.prePublishCallTimeoutMs()).toBe(4_000);
    clock.advance(3_500); // 0.5 s usable < 1 s minimum
    expect(d.prePublishCallTimeoutMs()).toBeNull();
  });

  it("gates the irreversible call: canStartPublish only with both reserves intact", () => {
    const clock = clockAt();
    const d = new ExecutionDeadline({ now: clock.now });
    clock.advance(28_000); // remaining exactly 17 s
    expect(d.canStartPublish()).toBe(true);
    clock.advance(1);
    expect(d.canStartPublish()).toBe(false);
  });

  it("media_publish timeout never exceeds the request ceiling and always leaves the persistence reserve", () => {
    const clock = clockAt();
    const d = new ExecutionDeadline({ now: clock.now });
    clock.advance(28_000); // remaining 17 s → min(10, 12) = 10
    expect(d.publishCallTimeoutMs()).toBe(10_000);
    clock.advance(10_000); // remaining 7 s → 2 s
    expect(d.publishCallTimeoutMs()).toBe(2_000);
    clock.advance(10_000);
    expect(d.publishCallTimeoutMs()).toBe(0);
  });
});

/** MVP-5.36 (Decision #44) — the Level-6 scheduled-function budget (30 s platform limit). */
describe("SCHEDULER_EXECUTION_BUDGET (W/X)", () => {
  it("X: plans ≤ 25 s inside the 30 s scheduled limit; worst-case pre-publish ceilings + both reserves fit", () => {
    expect(SCHEDULED_FUNCTION_LIMIT_MS).toBe(30_000);
    expect(SCHEDULER_EXECUTION_BUDGET.totalMs).toBeLessThanOrEqual(25_000);
    expect(() => assertBudgetFitsPlatform(SCHEDULER_EXECUTION_BUDGET, SCHEDULED_FUNCTION_PLATFORM)).not.toThrow();
    const worstPrePublish = SCHEDULER_EXECUTION_BUDGET.providerRequestTimeoutMs + SCHEDULER_EXECUTION_BUDGET.pollBudgetMs;
    expect(
      worstPrePublish + SCHEDULER_EXECUTION_BUDGET.publishReserveMs + SCHEDULER_EXECUTION_BUDGET.finalPersistenceReserveMs,
    ).toBeLessThanOrEqual(SCHEDULER_EXECUTION_BUDGET.totalMs);
    // Anything eating the 5 s scheduled headroom is refused.
    expect(() => new ExecutionDeadline({ config: { ...SCHEDULER_EXECUTION_BUDGET, totalMs: 25_001 }, platform: SCHEDULED_FUNCTION_PLATFORM })).toThrow(/headroom/);
  });

  it("W: the deadline expires before platform termination and G3 never starts without both reserves", () => {
    const clock = clockAt();
    const deadline = new ExecutionDeadline({ now: clock.now, config: SCHEDULER_EXECUTION_BUDGET, platform: SCHEDULED_FUNCTION_PLATFORM });
    const reserves = SCHEDULER_EXECUTION_BUDGET.publishReserveMs + SCHEDULER_EXECUTION_BUDGET.finalPersistenceReserveMs;
    clock.advance(SCHEDULER_EXECUTION_BUDGET.totalMs - reserves);
    expect(deadline.canStartPublish()).toBe(true);
    expect(deadline.publishCallTimeoutMs()).toBe(SCHEDULER_EXECUTION_BUDGET.providerRequestTimeoutMs);
    clock.advance(1);
    expect(deadline.canStartPublish()).toBe(false);
    expect(deadline.prePublishCallTimeoutMs()).toBeNull();
    // The G3 timeout always leaves the persistence reserve, so the run ends ≤ 25 s < 30 s.
    expect(deadline.elapsedMs() + deadline.publishCallTimeoutMs() + SCHEDULER_EXECUTION_BUDGET.finalPersistenceReserveMs).toBeLessThanOrEqual(
      SCHEDULER_EXECUTION_BUDGET.totalMs,
    );
    expect(SCHEDULER_EXECUTION_BUDGET.totalMs).toBeLessThan(SCHEDULED_FUNCTION_LIMIT_MS);
  });
});
