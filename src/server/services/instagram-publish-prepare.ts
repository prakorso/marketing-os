import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ContainerPreparationProvider, ProviderFailureDetails } from "@/lib/social/provider";
import type { MarkFailedInput } from "@/server/services/publications";
import { validateImagePublishEligibility } from "@/server/services/publication-media";
import { ExecutionDeadline, type ExecutionBudgetConfig } from "@/server/services/publish-execution-budget";
import type { Asset, ContentVariant, Database, Publication, PublicationAttempt, PublicationAttemptStage, SocialAccount } from "@/types/database";

/**
 * MVP-5.35C-D — the shared PRE-PUBLISH phase of IMAGE Instagram publishing
 * (C-A T0–T5): duplicate guard → attempt 'validating' → validation →
 * media snapshot → signed URL → container creation → container_created
 * checkpoint → bounded polling → container_ready.
 *
 * This module has NO access to the irreversible step: its provider type
 * is ContainerPreparationProvider (create + status only). Both the real
 * engine (instagram-image-publishing.ts) and the dry run
 * (instagram-image-dry-run.ts) build on it. Every outcome produced here is
 * KNOWN-NOT-PUBLISHED except the "PUBLISHED before any publish request"
 * anomaly, which is recorded as outcome_unknown (never not-published).
 */

export const NON_TERMINAL_ATTEMPT_STAGES: readonly PublicationAttemptStage[] = [
  "validating",
  "container_created",
  "container_ready",
  "publish_requested",
];

export type AttemptPatch = Database["public"]["Tables"]["publication_attempts"]["Update"];

export interface AttemptStore {
  listForPublication(workspaceId: string, publicationId: string): Promise<PublicationAttempt[]>;
  start(input: { workspaceId: string; publicationId: string; provider: string }): Promise<PublicationAttempt>;
  update(workspaceId: string, attemptId: string, patch: AttemptPatch): Promise<PublicationAttempt>;
}

/** Default store. Attempts are written only by the execution path (service_role; MVP-5.35B). */
export function createAttemptStore(client: SupabaseClient<Database>): AttemptStore {
  return {
    async listForPublication(workspaceId, publicationId) {
      const { data, error } = await client
        .from("publication_attempts")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("publication_id", publicationId)
        .order("attempt_number");
      if (error) throw new Error(`Failed to load publish attempts: ${error.message}`);
      return data ?? [];
    },
    async start({ workspaceId, publicationId, provider }) {
      const { data, error } = await client
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider })
        .select()
        .single();
      if (error || !data) throw new Error(`Failed to start publish attempt: ${error?.message ?? "no row"}`);
      return data;
    },
    async update(workspaceId, attemptId, patch) {
      const { data, error } = await client
        .from("publication_attempts")
        .update(patch)
        .eq("workspace_id", workspaceId)
        .eq("id", attemptId)
        .select()
        .single();
      if (error || !data) throw new Error(`Failed to update publish attempt: ${error?.message ?? "no row"}`);
      return data;
    },
  };
}

export type StagedPublishContext = {
  workspaceId: string;
  publication: Pick<Publication, "id" | "content_variant_id">;
  variant: ContentVariant;
  socialAccount: SocialAccount;
  /** Resolved from Vault by the caller immediately before this call. Never logged or returned. */
  credential: string;
};

export type StagedPublishOutcome =
  | { kind: "published"; attemptId: string; mediaId: string }
  | { kind: "failed_known"; attemptId: string | null; code: string }
  | { kind: "outcome_unknown"; attemptId: string; code: string }
  /**
   * Local persistence could not finish. `mediaId` is present ONLY when
   * media_publish authoritatively succeeded (2xx + id): provider success is
   * then known, but it does NOT mean anything was persisted, and it never
   * permits another media_publish. Recovery is explicit (reconciliation).
   */
  | { kind: "pending_reconcile"; attemptId: string | null; reason: string; mediaId?: string }
  | { kind: "refused"; reason: string };

export type PrepareDeps = {
  provider: ContainerPreparationProvider;
  attempts: AttemptStore;
  loadAssets: (workspaceId: string, contentVariantId: string) => Promise<Asset[]>;
  signMediaUrl: (asset: Asset) => Promise<string>;
  markFailed: (input: MarkFailedInput) => Promise<Publication>;
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock for the default deadline (monotonic in production). */
  now?: () => number;
  /** Execution deadline; created at the start of the run when omitted. */
  deadline?: ExecutionDeadline;
  /** Budget overrides (tests / tuning). */
  budget?: Partial<ExecutionBudgetConfig>;
  /** Legacy overrides kept for compatibility; mapped onto the budget. */
  pollIntervalMs?: number;
  pollBudgetMs?: number;
  log?: (line: string) => void;
};

export type RunHelpers = {
  deadline: ExecutionDeadline;
  sleep: (ms: number) => Promise<void>;
  emit: (event: string, fields: Record<string, unknown>) => void;
  /** Known-not-published termination: attempt failed (error_code), then publication failed. */
  failKnown: (code: string, message: string, providerResponse?: Record<string, unknown>) => Promise<StagedPublishOutcome>;
};

export type PreparedContainer = {
  attempt: PublicationAttempt;
  containerId: string;
  targetAccountId: string;
};

export type PrepareResult = { ok: true; prepared: PreparedContainer; helpers: RunHelpers } | { ok: false; outcome: StagedPublishOutcome };

const LOCAL_WRITE_RETRIES = 3;

export async function withLocalRetries<T>(write: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOCAL_WRITE_RETRIES; attempt += 1) {
    try {
      return await write();
    } catch (err) {
      lastError = err;
      if (attempt < LOCAL_WRITE_RETRIES) await sleep(200 * attempt);
    }
  }
  throw lastError;
}

export function providerSummary(details: ProviderFailureDetails, providerStage: string): Record<string, unknown> {
  return {
    providerStage,
    code: details.code,
    httpStatus: details.httpStatus,
    providerCode: details.providerCode,
    providerSubcode: details.providerSubcode,
    fbtraceId: details.fbtraceId,
  };
}

export async function prepareReadyContainer(ctx: StagedPublishContext, deps: PrepareDeps, eventPrefix = "instagram-publish"): Promise<PrepareResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budget: Partial<ExecutionBudgetConfig> = {
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.pollBudgetMs !== undefined ? { pollBudgetMs: deps.pollBudgetMs } : {}),
    ...(deps.budget ?? {}),
  };
  const deadline = deps.deadline ?? new ExecutionDeadline({ now: deps.now, config: budget });
  const log = deps.log ?? ((line: string) => console.info(line));
  const { workspaceId, publication } = ctx;
  const emit = (event: string, fields: Record<string, unknown>) =>
    log(`[${eventPrefix}] ${event} ${JSON.stringify({ publicationId: publication.id, ...fields })}`);

  // --- Structural duplicate guard -------------------------------------------
  let prior: PublicationAttempt[];
  try {
    prior = await deps.attempts.listForPublication(workspaceId, publication.id);
  } catch {
    return { ok: false, outcome: { kind: "pending_reconcile", attemptId: null, reason: "attempt_history_unavailable" } };
  }
  const blocking = prior.find((attempt) => attempt.stage !== "failed");
  if (blocking) {
    emit("refused", { attemptId: blocking.id, stage: blocking.stage });
    return { ok: false, outcome: { kind: "refused", reason: `prior_attempt_${blocking.stage}_requires_reconciliation` } };
  }

  // --- T0 --------------------------------------------------------------------
  let attempt: PublicationAttempt;
  try {
    attempt = await deps.attempts.start({ workspaceId, publicationId: publication.id, provider: "instagram" });
  } catch {
    return { ok: false, outcome: { kind: "pending_reconcile", attemptId: null, reason: "attempt_start_failed" } };
  }
  emit("attempt_started", { attemptId: attempt.id, attemptNumber: attempt.attempt_number });

  const failKnown: RunHelpers["failKnown"] = async (code, message, providerResponse = {}) => {
    try {
      await withLocalRetries(
        () => deps.attempts.update(workspaceId, attempt.id, { stage: "failed", error_code: code, error_message: message }),
        sleep,
      );
    } catch {
      // Attempt left non-terminal; the reconciler closes stale pre-publish attempts. Still provably not published.
    }
    emit("failed_known", { attemptId: attempt.id, code });
    try {
      await withLocalRetries(
        () => deps.markFailed({ errorCode: code, errorMessage: message, providerResponse: { attemptId: attempt.id, ...providerResponse } }),
        sleep,
      );
    } catch {
      return { kind: "pending_reconcile", attemptId: attempt.id, reason: "mark_failed_persistence_failed" };
    }
    return { kind: "failed_known", attemptId: attempt.id, code };
  };
  const helpers: RunHelpers = { deadline, sleep, emit, failKnown };
  const stop = async (code: string, message: string, extra?: Record<string, unknown>) => ({
    ok: false as const,
    outcome: await failKnown(code, message, extra),
  });

  // --- Validation / media (no provider call) ---------------------------------
  let assets: Asset[];
  try {
    assets = await deps.loadAssets(workspaceId, publication.content_variant_id);
  } catch {
    return stop("media_resolution_failed", "Could not load the variant's publish media");
  }
  const eligibility = validateImagePublishEligibility({ workspaceId, variant: ctx.variant, socialAccount: ctx.socialAccount, assets });
  if (!eligibility.ok) return stop(eligibility.code, eligibility.message);

  try {
    attempt = await deps.attempts.update(workspaceId, attempt.id, { media_asset_ids: [eligibility.asset.id] });
  } catch {
    return stop("checkpoint_failed", "Could not record the submitted media before container creation");
  }

  let signedUrl: string;
  try {
    signedUrl = await withLocalRetries(() => deps.signMediaUrl(eligibility.asset), sleep);
  } catch {
    return stop("signed_url_failed", "Could not create a provider-fetchable media URL");
  }

  // --- T2: container creation (bounded by the deadline) -----------------------
  const createTimeout = deadline.prePublishCallTimeoutMs();
  if (createTimeout === null) {
    signedUrl = "";
    return stop("execution_budget_exhausted", "Not enough execution time to create the container");
  }
  const created = await deps.provider.createMediaContainer({
    credential: ctx.credential,
    accountId: eligibility.targetAccountId,
    imageUrl: signedUrl,
    caption: eligibility.caption,
    timeoutMs: createTimeout,
  });
  signedUrl = "";
  if (!created.ok) return stop("container_create_failed", created.message, providerSummary(created, "container_create"));

  const containerId = created.containerId;
  try {
    attempt = await deps.attempts.update(workspaceId, attempt.id, { stage: "container_created", container_ids: [containerId] });
  } catch {
    return stop("checkpoint_failed", "Could not record the created container");
  }
  emit("container_created", { attemptId: attempt.id, containerId });

  // --- T4: polling — never consumes the publish/persistence reserves ----------
  const { pollBudgetMs, pollIntervalMs } = deadline.config;
  const pollEndsAt = deadline.elapsedMs() + pollBudgetMs;
  let polls = 0;
  for (;;) {
    const timeout = deadline.prePublishCallTimeoutMs();
    if (timeout === null || deadline.elapsedMs() >= pollEndsAt) break;
    polls += 1;
    const status = await deps.provider.getMediaContainerStatus({
      credential: ctx.credential,
      containerId,
      timeoutMs: Math.min(timeout, Math.max(1, pollEndsAt - deadline.elapsedMs())),
    });
    if (status.ok) {
      if (status.status === "FINISHED") {
        try {
          attempt = await deps.attempts.update(workspaceId, attempt.id, { stage: "container_ready" });
        } catch {
          return stop("checkpoint_failed", "Could not record container readiness");
        }
        emit("container_ready", { attemptId: attempt.id, containerId, polls });
        return { ok: true, prepared: { attempt, containerId, targetAccountId: eligibility.targetAccountId }, helpers };
      }
      if (status.status === "ERROR" || status.status === "EXPIRED") {
        return stop(status.status === "ERROR" ? "container_error" : "container_expired", `Container status ${status.status}`, {
          containerId,
          polls,
        });
      }
      if (status.status === "PUBLISHED") {
        // Anomaly: never classify a published container as not-published.
        try {
          await withLocalRetries(
            () =>
              deps.attempts.update(workspaceId, attempt.id, {
                stage: "outcome_unknown",
                error_code: "container_state_anomaly",
                error_message: "Container reported PUBLISHED before any publish request",
              }),
            sleep,
          );
        } catch {
          return { ok: false, outcome: { kind: "pending_reconcile", attemptId: attempt.id, reason: "anomaly_checkpoint_failed" } };
        }
        emit("outcome_unknown", { attemptId: attempt.id, code: "container_state_anomaly" });
        return { ok: false, outcome: { kind: "outcome_unknown", attemptId: attempt.id, code: "container_state_anomaly" } };
      }
      if (status.status === "UNKNOWN_VALUE") {
        return stop("container_status_unrecognized", "Container reported an unrecognized status", { containerId, polls });
      }
    }
    // IN_PROGRESS or a transient read failure: wait, but never into the reserves.
    const waitAvailable = Math.min(pollEndsAt - deadline.elapsedMs(), deadline.prePublishRemainingMs());
    if (waitAvailable <= pollIntervalMs) break;
    await sleep(pollIntervalMs);
  }
  // media_publish never invoked → provably not published.
  return stop("container_poll_timeout", "Container did not become ready within the execution budget", { containerId, polls });
}
