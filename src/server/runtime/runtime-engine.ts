import type { StagedMediaPublisher } from "@/lib/social/provider";
import { providerSummary, withLocalRetries, type AttemptStore } from "@/server/services/instagram-publish-prepare";
import { isModelBPublishReady, validateImagePublishEligibility } from "@/server/services/publication-media-rules";
import type { MarkFailedInput, MarkPublishedInput } from "@/server/services/publication-transitions";
import { SCHEDULED_FUNCTION_LIMIT_MS } from "@/server/services/publish-execution-budget";
import type {
  Asset,
  ContentVariant,
  Publication,
  PublicationAttempt,
  PublicationAttemptStage,
  PublishingRuntimeMode,
  SocialAccount,
} from "@/types/database";

/**
 * MVP-5.36H2 — the hardened Level-6 runtime engine (H0 Option C: leased,
 * resumable, single-flight). One invocation works on exactly ONE
 * publication, either:
 *   NEW     claimed publication → attempt → pre-G1 marker → G1 → G2 …
 *   RESUME  the DB-selected in-flight attempt (container_created /
 *           container_ready) → G2 … (never G1, never a second attempt)
 *
 * Irreversible-boundary guarantees:
 *   - G1: `container_create_requested_at` is committed BEFORE dispatch; an
 *     ambiguous G1 closes the attempt known-not-published
 *     ('container_create_outcome_unknown') and is NEVER re-dispatched.
 *   - G3: only from container_ready, publish mode, lease still held, both
 *     controls ON (checked before AND after the publish_requested checkpoint),
 *     full timeout + persistence reserve available; publish_requested is
 *     committed before dispatch; an ambiguous G3 is outcome_unknown and never
 *     retried.
 *   - dry_run has no G3 call site: runReadyStage terminates before any
 *     publish path when mode !== "publish".
 * Container readiness may span invocations: when this invocation's budget or
 * the control ends polling, the durable state (container_created /
 * container_ready) is preserved for the next lease holder.
 */

export type RuntimeBudgetConfig = {
  totalMs: number;
  g1TimeoutMs: number;
  g2CallTimeoutMs: number;
  g2IntervalMs: number;
  g3TimeoutMs: number;
  persistenceReserveMs: number;
  minCallMs: number;
};

export const RUNTIME_BUDGET: Readonly<RuntimeBudgetConfig> = Object.freeze({
  /** Whole invocation (internal deadline); the platform ceiling is 30 s. */
  totalMs: 25_000,
  g1TimeoutMs: 10_000,
  g2CallTimeoutMs: 5_000,
  g2IntervalMs: 1_500,
  g3TimeoutMs: 8_000,
  /** Kept free after every provider call for the terminal writes. */
  persistenceReserveMs: 3_000,
  /** No provider call starts with less than this much usable time. */
  minCallMs: 1_000,
});

if (RUNTIME_BUDGET.totalMs > SCHEDULED_FUNCTION_LIMIT_MS - 5_000) {
  throw new Error("Runtime budget must leave at least 5 s of scheduled-function headroom");
}

/** Monotonic invocation budget (injected clock in tests). */
export class RuntimeBudget {
  readonly config: RuntimeBudgetConfig;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(options: { now?: () => number; config?: Partial<RuntimeBudgetConfig> } = {}) {
    this.config = { ...RUNTIME_BUDGET, ...(options.config ?? {}) };
    if (this.config.totalMs > SCHEDULED_FUNCTION_LIMIT_MS - 5_000) {
      throw new Error("Runtime budget must leave at least 5 s of scheduled-function headroom");
    }
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  remainingMs(): number {
    return this.config.totalMs - this.elapsedMs();
  }

  /** True only if the FULL timeout plus the reserve still fits. */
  canStart(timeoutMs: number, reserveMs = this.config.persistenceReserveMs): boolean {
    return this.remainingMs() >= timeoutMs + reserveMs;
  }
}

export type RuntimeCheckpoint = "container_create" | "status_poll" | "publish_request" | "media_publish";

export type EngineContext = {
  workspaceId: string;
  publication: Pick<Publication, "id" | "content_variant_id">;
  variant: ContentVariant;
  socialAccount: SocialAccount;
  /** Resolved from Vault by the caller; never logged or returned. */
  credential: string;
};

export type EngineDeps = {
  runId: string;
  mode: PublishingRuntimeMode;
  attempts: AttemptStore;
  provider: StagedMediaPublisher;
  signMediaUrl: (asset: Asset) => Promise<string>;
  markFailed: (input: MarkFailedInput) => Promise<Publication>;
  markPublished: (input: MarkPublishedInput) => Promise<Publication>;
  budget: RuntimeBudget;
  /** Runtime-local kill switch: DB control ON + same mode + env (+ lease for G3 steps). */
  allowed: (step: RuntimeCheckpoint) => Promise<boolean>;
  emit: (event: string, fields: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock ISO timestamps for durable markers. */
  timestamp?: () => string;
};

export type EngineOutcome =
  | { kind: "dry_run_container_ready"; attemptId: string; stage: PublicationAttemptStage }
  | { kind: "published"; attemptId: string; mediaId: string; stage: PublicationAttemptStage }
  | { kind: "failed_known"; attemptId: string; code: string; stage: PublicationAttemptStage }
  | { kind: "g1_outcome_unknown"; attemptId: string; code: string; stage: PublicationAttemptStage }
  | { kind: "publish_outcome_unknown"; attemptId: string; code: string; stage: PublicationAttemptStage }
  | { kind: "container_outcome_unknown"; attemptId: string; code: string; stage: PublicationAttemptStage }
  | { kind: "deferred"; attemptId: string; reason: "not_ready" | "g3_budget" | "runtime_disabled" | "checkpoint"; stage: PublicationAttemptStage }
  | { kind: "pending_reconcile"; attemptId: string | null; reason: string; mediaId?: string; stage: PublicationAttemptStage | null }
  | { kind: "refused"; reason: string; stage: PublicationAttemptStage | null };

export const TERMINAL_OUTCOME_KINDS: ReadonlySet<EngineOutcome["kind"]> = new Set([
  "dry_run_container_ready",
  "published",
  "failed_known",
  "g1_outcome_unknown",
]);

type Run = {
  ctx: EngineContext;
  deps: EngineDeps;
  sleep: (ms: number) => Promise<void>;
  timestamp: () => string;
  attempt: PublicationAttempt;
};

async function patch(run: Run, fields: Parameters<AttemptStore["update"]>[2]): Promise<PublicationAttempt> {
  run.attempt = await run.deps.attempts.update(run.ctx.workspaceId, run.attempt.id, { ...fields, last_run_id: run.deps.runId });
  return run.attempt;
}

/** Known-not-published termination: attempt failed first, then the publication. */
async function failKnown(run: Run, code: string, message: string, providerResponse: Record<string, unknown> = {}): Promise<EngineOutcome> {
  const { deps, ctx } = run;
  try {
    await withLocalRetries(() => patch(run, { stage: "failed", error_code: code, error_message: message }), run.sleep);
  } catch {
    // Attempt left non-terminal; the reconciler classifies it. Still provably not published.
  }
  deps.emit("failed_known", { publicationId: ctx.publication.id, attemptId: run.attempt.id, code });
  try {
    await withLocalRetries(
      () => deps.markFailed({ errorCode: code, errorMessage: message, providerResponse: { attemptId: run.attempt.id, runId: deps.runId, ...providerResponse } }),
      run.sleep,
    );
  } catch {
    return { kind: "pending_reconcile", attemptId: run.attempt.id, reason: "mark_failed_persistence_failed", stage: run.attempt.stage };
  }
  return { kind: "failed_known", attemptId: run.attempt.id, code, stage: "failed" };
}

function containerIdOf(attempt: PublicationAttempt): string | null {
  const id = attempt.container_ids[0];
  return typeof id === "string" && id !== "" ? id : null;
}

// -----------------------------------------------------------------------------
// NEW work
// -----------------------------------------------------------------------------

export async function runNewWork(ctx: EngineContext, assets: Asset[], deps: EngineDeps): Promise<EngineOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timestamp = deps.timestamp ?? (() => new Date().toISOString());
  const { workspaceId, publication } = ctx;

  let prior: PublicationAttempt[];
  try {
    prior = await deps.attempts.listForPublication(workspaceId, publication.id);
  } catch {
    return { kind: "refused", reason: "attempt_history_unavailable", stage: null };
  }
  const blocking = prior.find((attempt) => attempt.stage !== "failed");
  if (blocking) {
    return { kind: "refused", reason: `prior_attempt_${blocking.stage}`, stage: blocking.stage };
  }

  let started: PublicationAttempt;
  try {
    started = await deps.attempts.start({ workspaceId, publicationId: publication.id, provider: "instagram" });
  } catch {
    return { kind: "refused", reason: "attempt_start_failed", stage: null };
  }
  const run: Run = { ctx, deps, sleep, timestamp, attempt: started };
  deps.emit("attempt_started", { publicationId: publication.id, attemptId: started.id, attemptNumber: started.attempt_number });

  const eligibility = validateImagePublishEligibility({ workspaceId, variant: ctx.variant, socialAccount: ctx.socialAccount, assets });
  if (!eligibility.ok) return failKnown(run, eligibility.code, eligibility.message);

  try {
    await patch(run, { media_asset_ids: [eligibility.asset.id] });
  } catch {
    return failKnown(run, "checkpoint_failed", "Could not record the submitted media before container creation");
  }

  if (!(await deps.allowed("container_create"))) {
    return failKnown(run, "runtime_disabled_before_create", "Runtime publishing was switched off before container creation; no provider request was made");
  }
  const { g1TimeoutMs } = deps.budget.config;
  if (!deps.budget.canStart(g1TimeoutMs)) {
    return failKnown(run, "execution_budget_exhausted", "Not enough execution time to create the container; no provider request was made");
  }

  let signedUrl: string;
  try {
    signedUrl = await withLocalRetries(() => deps.signMediaUrl(eligibility.asset), sleep);
  } catch {
    return failKnown(run, "signed_url_failed", "Could not create a provider-fetchable media URL; no provider request was made");
  }

  // Durable pre-G1 marker: MUST commit before dispatch. A failed write ⇒ no G1.
  try {
    await patch(run, { container_create_requested_at: timestamp() });
  } catch {
    signedUrl = "";
    return failKnown(run, "checkpoint_failed", "Could not record the container request marker; no provider request was made");
  }

  // H3 fix: re-check immediately before dispatch (after the marker commit), as for G3. The earlier
  // checks can be stale by the time signing and the marker write have completed.
  if (!(await deps.allowed("container_create"))) {
    signedUrl = "";
    return failKnown(run, "runtime_disabled_before_create", "Runtime publishing was switched off before container creation; no provider request was made");
  }
  if (!deps.budget.canStart(g1TimeoutMs)) {
    signedUrl = "";
    return failKnown(run, "execution_budget_exhausted", "Not enough execution time to create the container; no provider request was made");
  }

  deps.emit("g1_dispatch", { publicationId: publication.id, attemptId: run.attempt.id, remainingMs: Math.round(deps.budget.remainingMs()) });
  const created = await deps.provider.createMediaContainer({
    credential: ctx.credential,
    accountId: eligibility.targetAccountId,
    imageUrl: signedUrl,
    caption: eligibility.caption,
    timeoutMs: g1TimeoutMs,
  });
  signedUrl = "";

  if (!created.ok) {
    const outcome = created.outcome === "rejected" ? "rejected" : "unknown";
    deps.emit("g1_result", { publicationId: publication.id, attemptId: run.attempt.id, class: outcome, ...providerSummary(created, "container_create") });
    if (outcome === "rejected") {
      return failKnown(run, "container_create_failed", created.message, providerSummary(created, "container_create"));
    }
    // Ambiguous: a container MAY exist. Never re-dispatch; no publish can target an unrecorded container.
    const result = await failKnown(run, "container_create_outcome_unknown", "Container creation outcome is unknown; it will not be retried", providerSummary(created, "container_create"));
    return result.kind === "failed_known" ? { ...result, kind: "g1_outcome_unknown" } : result;
  }

  const containerId = created.containerId;
  try {
    await patch(run, { stage: "container_created", container_ids: [containerId], container_created_at: timestamp() });
  } catch {
    // The marker is set and no container is recorded ⇒ the reconciler closes it as G1 unknown. Never re-dispatched.
    deps.emit("g1_result", { publicationId: publication.id, attemptId: run.attempt.id, class: "success", persisted: false });
    return { kind: "pending_reconcile", attemptId: run.attempt.id, reason: "container_checkpoint_failed", stage: run.attempt.stage };
  }
  deps.emit("g1_result", { publicationId: publication.id, attemptId: run.attempt.id, class: "success", containerId });
  return runContainerStages(run, containerId, eligibility.targetAccountId);
}

// -----------------------------------------------------------------------------
// RESUME
// -----------------------------------------------------------------------------

export async function runResume(ctx: EngineContext, attempt: PublicationAttempt, deps: EngineDeps): Promise<EngineOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timestamp = deps.timestamp ?? (() => new Date().toISOString());
  const run: Run = { ctx, deps, sleep, timestamp, attempt };
  const containerId = containerIdOf(attempt);
  if ((attempt.stage !== "container_created" && attempt.stage !== "container_ready") || !containerId) {
    // Fail closed: nothing but these two stages may ever be resumed. No mutation, no provider call.
    return { kind: "refused", reason: `resume_unexpected_stage_${attempt.stage}`, stage: attempt.stage };
  }
  deps.emit("attempt_resumed", { publicationId: ctx.publication.id, attemptId: attempt.id, stage: attempt.stage, polls: attempt.status_poll_count });
  if (!isModelBPublishReady(ctx.socialAccount)) {
    return failKnown(run, "account_not_publish_ready", "The Instagram account is no longer publish-ready; no publish request was made", { containerId });
  }
  return runContainerStages(run, containerId, ctx.socialAccount.external_account_id);
}

// -----------------------------------------------------------------------------
// Shared: G2 polling → ready stage
// -----------------------------------------------------------------------------

async function runContainerStages(run: Run, containerId: string, targetAccountId: string): Promise<EngineOutcome> {
  if (run.attempt.stage === "container_ready") return runReadyStage(run, containerId, targetAccountId);

  const { deps, ctx } = run;
  const { g2CallTimeoutMs, g2IntervalMs, persistenceReserveMs, minCallMs } = deps.budget.config;
  const defer = (reason: "not_ready" | "runtime_disabled" | "checkpoint"): EngineOutcome => {
    deps.emit("deferred", { publicationId: ctx.publication.id, attemptId: run.attempt.id, reason, stage: run.attempt.stage, remainingMs: Math.round(deps.budget.remainingMs()) });
    return { kind: "deferred", attemptId: run.attempt.id, reason, stage: run.attempt.stage };
  };

  for (;;) {
    if (!(await deps.allowed("status_poll"))) return defer("runtime_disabled");
    const usable = deps.budget.remainingMs() - persistenceReserveMs;
    if (usable < minCallMs) return defer("not_ready");
    const timeoutMs = Math.min(g2CallTimeoutMs, usable);
    const status = await deps.provider.getMediaContainerStatus({ credential: ctx.credential, containerId, timeoutMs });
    const polls = run.attempt.status_poll_count + 1;
    try {
      await patch(run, { status_poll_count: polls });
    } catch {
      // Counter is observability only; never affects safety.
    }
    deps.emit("g2_poll", {
      publicationId: ctx.publication.id,
      attemptId: run.attempt.id,
      n: polls,
      status: status.ok ? status.status : `error:${status.code}`,
      remainingMs: Math.round(deps.budget.remainingMs()),
    });

    if (status.ok) {
      if (status.status === "FINISHED") {
        try {
          await patch(run, { stage: "container_ready" });
        } catch {
          return defer("checkpoint"); // still container_created: the next holder re-polls
        }
        return runReadyStage(run, containerId, targetAccountId);
      }
      if (status.status === "ERROR" || status.status === "EXPIRED") {
        return failKnown(run, status.status === "ERROR" ? "container_error" : "container_expired", `Container status ${status.status}`, { containerId, polls });
      }
      if (status.status === "PUBLISHED") {
        // Hard anomaly: never classified as not-published; the publication stays 'publishing'.
        try {
          await withLocalRetries(
            () => patch(run, { stage: "outcome_unknown", error_code: "container_state_anomaly", error_message: "Container reported PUBLISHED without a MARQOS publish request" }),
            run.sleep,
          );
        } catch {
          return { kind: "pending_reconcile", attemptId: run.attempt.id, reason: "anomaly_checkpoint_failed", stage: run.attempt.stage };
        }
        deps.emit("outcome_unknown", { publicationId: ctx.publication.id, attemptId: run.attempt.id, code: "container_state_anomaly" });
        return { kind: "container_outcome_unknown", attemptId: run.attempt.id, code: "container_state_anomaly", stage: "outcome_unknown" };
      }
      if (status.status === "UNKNOWN_VALUE") {
        return failKnown(run, "container_status_unrecognized", "Container reported an unrecognized status", { containerId, polls });
      }
    }
    // IN_PROGRESS or a transient read failure: wait only if another full poll still fits.
    if (deps.budget.remainingMs() - g2IntervalMs - persistenceReserveMs < minCallMs) return defer("not_ready");
    await run.sleep(g2IntervalMs);
  }
}

async function runReadyStage(run: Run, containerId: string, targetAccountId: string): Promise<EngineOutcome> {
  const { deps, ctx } = run;

  if (deps.mode !== "publish") {
    // dry_run: terminal here. No publish path exists below this return for dry_run.
    const result = await failKnown(run, "dry_run_container_ready", "Dry run stopped intentionally at container_ready; no publish request was made", {
      containerId,
      dryRun: true,
    });
    return result.kind === "failed_known" ? { kind: "dry_run_container_ready", attemptId: result.attemptId, stage: "failed" } : result;
  }

  const { g3TimeoutMs, persistenceReserveMs } = deps.budget.config;
  const defer = (reason: "g3_budget" | "runtime_disabled" | "checkpoint"): EngineOutcome => {
    deps.emit("deferred", { publicationId: ctx.publication.id, attemptId: run.attempt.id, reason, stage: run.attempt.stage, remainingMs: Math.round(deps.budget.remainingMs()) });
    return { kind: "deferred", attemptId: run.attempt.id, reason, stage: run.attempt.stage };
  };

  // Before the irreversible checkpoint: budget, then kill switch + lease. OFF preserves container_ready.
  if (!deps.budget.canStart(g3TimeoutMs, persistenceReserveMs)) return defer("g3_budget");
  if (!(await deps.allowed("publish_request"))) return defer("runtime_disabled");

  try {
    await patch(run, { stage: "publish_requested" });
  } catch {
    return defer("checkpoint"); // stays container_ready; no publish request was made
  }
  deps.emit("publish_requested", { publicationId: ctx.publication.id, attemptId: run.attempt.id, containerId });

  // Mandatory re-check immediately before G3 (after the checkpoint).
  if (!(await deps.allowed("media_publish"))) {
    return failKnown(run, "runtime_disabled_before_publish", "Runtime publishing was switched off before the publish request; no publish request was made", { containerId });
  }
  if (!deps.budget.canStart(g3TimeoutMs, persistenceReserveMs)) {
    return failKnown(run, "insufficient_publish_time_budget", "Not enough execution time remained to safely request publishing", { containerId });
  }

  deps.emit("g3_dispatch", { publicationId: ctx.publication.id, attemptId: run.attempt.id, remainingMs: Math.round(deps.budget.remainingMs()) });
  const published = await deps.provider.publishMediaContainer({
    credential: ctx.credential,
    accountId: targetAccountId,
    containerId,
    timeoutMs: g3TimeoutMs,
  });

  if (!published.ok && published.outcome === "rejected") {
    deps.emit("g3_result", { publicationId: ctx.publication.id, attemptId: run.attempt.id, class: "rejected" });
    return failKnown(run, "publish_rejected", published.message, providerSummary(published, "media_publish"));
  }
  if (!published.ok) {
    deps.emit("g3_result", { publicationId: ctx.publication.id, attemptId: run.attempt.id, class: "unknown", ...providerSummary(published, "media_publish") });
    try {
      await withLocalRetries(() => patch(run, { stage: "outcome_unknown", error_code: published.code, error_message: published.message }), run.sleep);
    } catch {
      // Stays publish_requested; the reconciler marks it outcome_unknown. Never retried.
    }
    return { kind: "publish_outcome_unknown", attemptId: run.attempt.id, code: published.code, stage: run.attempt.stage };
  }

  const mediaId = published.mediaId;
  deps.emit("g3_result", { publicationId: ctx.publication.id, attemptId: run.attempt.id, class: "success", mediaId });
  try {
    await withLocalRetries(() => patch(run, { stage: "published", external_media_id: mediaId }), run.sleep);
  } catch {
    return { kind: "pending_reconcile", attemptId: run.attempt.id, reason: "attempt_published_persistence_failed", mediaId, stage: run.attempt.stage };
  }
  try {
    await withLocalRetries(
      () =>
        deps.markPublished({
          externalPublicationId: mediaId,
          externalUrl: null,
          providerResponse: { attemptId: run.attempt.id, containerId, mediaId, provider: "instagram", mediaType: "IMAGE", runId: deps.runId },
        }),
      run.sleep,
    );
  } catch {
    return { kind: "pending_reconcile", attemptId: run.attempt.id, reason: "publication_published_persistence_failed", mediaId, stage: "published" };
  }
  return { kind: "published", attemptId: run.attempt.id, mediaId, stage: "published" };
}
