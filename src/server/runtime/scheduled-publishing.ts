import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createInstagramMediaContainer,
  getInstagramMediaContainerStatus,
  listInstagramRecentMedia,
  publishInstagramMediaContainer,
} from "@/lib/social/instagram-graph";
import type { StagedMediaPublisher } from "@/lib/social/provider";
import { createAttemptStore, runStagedImagePublish, type StagedPublishOutcome } from "@/server/services/instagram-image-publishing";
import { runInstagramImageDryRun, type DryRunOutcome } from "@/server/services/instagram-image-dry-run";
import {
  createPublishSignedUrlWith,
  loadVariantPublishAssets,
  validateImagePublishEligibility,
} from "@/server/services/publication-media-rules";
import {
  insertPublicationFailedNotification,
  markFailedAsSystem,
  markPublishedAsSystem,
} from "@/server/services/publication-transitions";
import {
  ExecutionDeadline,
  SCHEDULED_FUNCTION_PLATFORM,
  SCHEDULER_EXECUTION_BUDGET,
  type ExecutionBudgetConfig,
} from "@/server/services/publish-execution-budget";
import { isEnvPublishingGateEnabled, readRuntimeControl, type RuntimeControlState } from "@/server/runtime/runtime-control";
import { withRuntimeCallCeiling, type RuntimeCallCounters } from "@/server/runtime/runtime-provider-ceiling";
import type { Database, Publication, PublishingRuntimeMode, RuntimeReconciliationRow } from "@/types/database";

/**
 * MVP-5.36 — the Level-6 unattended scheduled publishing runtime
 * (Decision #44). Invoked only by the Netlify Scheduled Function
 * netlify/functions/execute-due-publications.ts. Locked order:
 *
 *    1 runId
 *    2 read DB control
 *    3 missing / unreadable / OFF          → safe log + RETURN
 *    4 evaluate env gate
 *    5 env !== exactly "enabled"           → safe log + RETURN
 *    6 provider-free stale reconciliation  (reconcile_stale_runtime_publications)
 *    7 allowlisted atomic claim, cap 1     (claim_runtime_publications)
 *    8 load + eligibility                  (ineligible → failed, no Vault)
 *    9 re-check DB control
 *   10 Vault (at most one read)
 *   11 engine (dry_run: runInstagramImageDryRun — no publish capability)
 *   12 re-check DB control immediately before G3 (and before G1)
 *   13 persist (engine; attempt first, then publication)
 *   14 audit (audit_logs, actor null)
 *
 * OFF (steps 3/5) performs no claim, no publication or attempt mutation,
 * no reconciliation, no Vault read, no signed URL and no provider request.
 * A control switched OFF after the claim (step 9) leaves the claimed row
 * untouched in 'publishing'; the provider-free reconciler closes it as
 * 'runtime_interrupted_before_attempt' once the runtime is ON again. Once
 * an attempt exists, an OFF re-check (step 12) closes it known-not-published.
 *
 * Nothing here retries a provider call: a timeout yields known-not-published
 * before the publish request, or outcome_unknown after it. Logs are single
 * JSON lines with the runId; credentials, the service-role key and signed
 * URLs are never logged (and are scrubbed if they ever appear in a line).
 */

/** Pre-publish runs older than this (by the DATABASE clock) are stale; ≫ the 30 s platform limit. */
export const RUNTIME_STALE_THRESHOLD_SECONDS = 600;
export const RUNTIME_CLAIM_CAP = 1;

export type RuntimeOutcome =
  | "runtime_disabled"
  | "env_gate_disabled"
  | "reconcile_failed"
  | "budget_exhausted_before_claim"
  | "claim_failed"
  | "nothing_claimed"
  | "load_failed"
  | "ineligible"
  | "runtime_disabled_after_claim"
  | "credential_unavailable"
  | "engine_error"
  | "completed";

export type RuntimeSummary = {
  runId: string;
  outcome: RuntimeOutcome;
  mode: PublishingRuntimeMode | null;
  reconciled: number;
  claimed: number;
  publicationId: string | null;
  result: StagedPublishOutcome["kind"] | DryRunOutcome["kind"] | null;
  code: string | null;
  providerCalls: RuntimeCallCounters;
  vaultReads: number;
};

export type RuntimeDeps = {
  /** Service-role client (null = environment incomplete ⇒ control unreadable ⇒ OFF). */
  client: SupabaseClient<Database> | null;
  env?: Record<string, string | undefined>;
  /** Provider override (tests use fakes). Always wrapped by the runtime call ceiling. */
  provider?: StagedMediaPublisher;
  signMediaUrl?: (asset: { storage_bucket: string; storage_path: string }) => Promise<string>;
  runId?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Budget override (validated against the 30 s scheduled-function platform limit). */
  budget?: Partial<ExecutionBudgetConfig>;
  staleSeconds?: number;
  log?: (line: string) => void;
};

const graphPublisher: StagedMediaPublisher = Object.freeze({
  createMediaContainer: createInstagramMediaContainer,
  getMediaContainerStatus: getInstagramMediaContainerStatus,
  publishMediaContainer: publishInstagramMediaContainer,
  listRecentMedia: listInstagramRecentMedia,
});

const RECONCILE_FAILED_ACTIONS = new Set(["failed_no_attempt", "failed_pre_publish", "failed_from_attempt"]);

function createRunLogger(runId: string, write: (line: string) => void) {
  const sensitive = new Set<string>();
  const scrub = (line: string) => {
    let out = line;
    for (const value of sensitive) {
      if (value.length >= 8) out = out.split(value).join("[redacted]");
    }
    return out;
  };
  return {
    protect(value: string | null | undefined) {
      if (value) sensitive.add(value);
    },
    event(event: string, fields: Record<string, unknown> = {}) {
      try {
        write(scrub(JSON.stringify({ scope: "marqos-runtime", runId, event, ...fields })));
      } catch {
        // Logging must never affect execution.
      }
    },
    engineLine(line: string) {
      try {
        write(scrub(JSON.stringify({ scope: "marqos-runtime", runId, event: "engine", line })));
      } catch {
        // ignore
      }
    },
  };
}

async function writeAudit(
  client: SupabaseClient<Database>,
  entry: { workspaceId: string; publicationId: string; action: string; metadata: Record<string, unknown> },
): Promise<boolean> {
  try {
    const { error } = await client.from("audit_logs").insert({
      workspace_id: entry.workspaceId,
      actor_user_id: null,
      action: entry.action,
      entity_type: "publication",
      entity_id: entry.publicationId,
      metadata: entry.metadata as Database["public"]["Tables"]["audit_logs"]["Insert"]["metadata"],
    });
    return !error;
  } catch {
    return false;
  }
}

export async function runScheduledPublishingRuntime(deps: RuntimeDeps): Promise<RuntimeSummary> {
  // --- 1 runId + invocation-wide deadline -------------------------------------
  const runId = deps.runId ?? crypto.randomUUID();
  const env = deps.env ?? process.env;
  const deadline = new ExecutionDeadline({
    now: deps.now,
    config: { ...SCHEDULER_EXECUTION_BUDGET, ...(deps.budget ?? {}) },
    platform: SCHEDULED_FUNCTION_PLATFORM,
  });
  const logger = createRunLogger(runId, deps.log ?? ((line) => console.info(line)));
  logger.protect(env.SUPABASE_SERVICE_ROLE_KEY);
  const counters: RuntimeCallCounters = { create: 0, status: 0, publish: 0 };
  const summary: RuntimeSummary = {
    runId,
    outcome: "runtime_disabled",
    mode: null,
    reconciled: 0,
    claimed: 0,
    publicationId: null,
    result: null,
    code: null,
    providerCalls: counters,
    vaultReads: 0,
  };
  const finish = (outcome: RuntimeOutcome, extra: Partial<RuntimeSummary> = {}): RuntimeSummary => {
    Object.assign(summary, extra, { outcome });
    logger.event("final", {
      outcome: summary.outcome,
      mode: summary.mode,
      reconciled: summary.reconciled,
      claimed: summary.claimed,
      publicationId: summary.publicationId,
      result: summary.result,
      code: summary.code,
      providerCalls: { ...counters },
      vaultReads: summary.vaultReads,
      elapsedMs: Math.round(deadline.elapsedMs()),
    });
    return summary;
  };
  logger.event("scheduler_start", { budgetMs: deadline.config.totalMs });

  // --- 2/3 DB runtime control (fail-closed) -----------------------------------
  const control = await readRuntimeControl(deps.client);
  if (!control.on || !deps.client) {
    logger.event("runtime_disabled", { gate: "db_control", reason: control.on ? "unreadable" : control.reason });
    return finish("runtime_disabled");
  }
  const client = deps.client;
  const mode = control.mode;
  summary.mode = mode;

  // --- 4/5 env gate -------------------------------------------------------------
  if (!isEnvPublishingGateEnabled(env)) {
    logger.event("runtime_disabled", { gate: "env" });
    return finish("env_gate_disabled");
  }

  // --- 6 provider-free stale reconciliation -----------------------------------
  const staleSeconds = deps.staleSeconds ?? RUNTIME_STALE_THRESHOLD_SECONDS;
  const { data: reconciled, error: reconcileError } = await client.rpc("reconcile_stale_runtime_publications", {
    p_stale_seconds: staleSeconds,
  });
  if (reconcileError) {
    logger.event("reconcile", { ok: false });
    return finish("reconcile_failed");
  }
  const rows: RuntimeReconciliationRow[] = reconciled ?? [];
  summary.reconciled = rows.length;
  logger.event("reconcile", {
    ok: true,
    staleSeconds,
    rows: rows.map((row) => ({ publicationId: row.publication_id, attemptId: row.attempt_id, action: row.action })),
  });
  for (const row of rows) {
    if (row.action === "skipped_attempt_recent") continue;
    await writeAudit(client, {
      workspaceId: row.workspace_id,
      publicationId: row.publication_id,
      action: "publication.runtime_reconciled",
      metadata: { runId, attemptId: row.attempt_id, action: row.action },
    });
    if (RECONCILE_FAILED_ACTIONS.has(row.action)) await notifyReconciledFailure(client, row, logger);
  }

  // --- 7 allowlisted atomic claim (cap 1) -------------------------------------
  if (deadline.prePublishCallTimeoutMs() === null) {
    logger.event("claim", { skipped: "budget_exhausted" });
    return finish("budget_exhausted_before_claim");
  }
  const { data: claimedRows, error: claimError } = await client.rpc("claim_runtime_publications", { p_cap: RUNTIME_CLAIM_CAP });
  if (claimError) {
    logger.event("claim", { ok: false });
    return finish("claim_failed");
  }
  const claimed: Publication[] = claimedRows ?? [];
  summary.claimed = claimed.length;
  logger.event("claim", { ok: true, claimed: claimed.length, publicationIds: claimed.map((row) => row.id) });
  const publication = claimed[0];
  if (!publication) return finish("nothing_claimed");
  if (claimed.length > RUNTIME_CLAIM_CAP) {
    // Defensive: the RPC enforces cap = 1. Never work on more than one.
    logger.event("claim", { anomaly: "over_cap", claimed: claimed.length });
  }
  const workspaceId = publication.workspace_id;
  summary.publicationId = publication.id;

  const audit = (action: string, metadata: Record<string, unknown>) =>
    writeAudit(client, { workspaceId, publicationId: publication.id, action, metadata: { runId, mode, ...metadata } });

  // --- 8 load + eligibility (no Vault, no signed URL, no provider) ------------
  const loaded = await loadClaimContext(client, publication);
  if (!loaded.ok) {
    logger.event("load", { ok: false, publicationId: publication.id, reason: loaded.reason });
    await audit("publication.runtime_final", { outcome: "load_failed", reason: loaded.reason });
    return finish("load_failed", { code: loaded.reason });
  }
  const { variant, socialAccount, assets } = loaded;
  const eligibility = validateImagePublishEligibility({ workspaceId, variant, socialAccount, assets });
  if (!eligibility.ok) {
    try {
      await markFailedAsSystem(client, workspaceId, publication.id, {
        errorCode: eligibility.code,
        errorMessage: eligibility.message,
        providerResponse: { runId, stage: "runtime_eligibility" },
      });
    } catch {
      logger.event("load", { persist: "mark_failed_failed", publicationId: publication.id });
    }
    logger.event("load", { ok: true, eligible: false, publicationId: publication.id, code: eligibility.code });
    await audit("publication.runtime_final", { outcome: "ineligible", code: eligibility.code });
    return finish("ineligible", { code: eligibility.code });
  }
  logger.event("load", { ok: true, eligible: true, publicationId: publication.id });

  // --- 9 re-check DB control ---------------------------------------------------
  const recheck = await readRuntimeControl(client);
  if (!recheck.on || recheck.mode !== mode) {
    logger.event("runtime_disabled", { gate: "db_control", at: "after_claim", publicationId: publication.id });
    return finish("runtime_disabled_after_claim");
  }

  // --- 10 Vault: exactly one read -------------------------------------------------
  summary.vaultReads = 1;
  let credential: string;
  try {
    // Not in the generated Database types (Vault helper; service_role execute only).
    const { data, error } = (await client.rpc("read_social_account_vault_secret" as never, {
      p_secret_id: socialAccount.vault_secret_id,
    } as never)) as { data: unknown; error: unknown };
    if (error || typeof data !== "string" || data.length === 0) throw new Error("unavailable");
    credential = data;
  } catch {
    try {
      await markFailedAsSystem(client, workspaceId, publication.id, {
        errorCode: "credential_unavailable",
        errorMessage: "The stored credential could not be resolved; no provider request was made",
        providerResponse: { runId, stage: "runtime_vault" },
      });
    } catch {
      logger.event("vault", { persist: "mark_failed_failed", publicationId: publication.id });
    }
    logger.event("vault", { ok: false, publicationId: publication.id });
    await audit("publication.runtime_final", { outcome: "credential_unavailable" });
    return finish("credential_unavailable", { code: "credential_unavailable" });
  }
  logger.protect(credential);
  logger.event("vault", { ok: true, publicationId: publication.id });

  // --- 11–13 engine ------------------------------------------------------------
  const provider = withRuntimeCallCeiling(deps.provider ?? graphPublisher, counters);
  const sign = deps.signMediaUrl ?? ((asset) => createPublishSignedUrlWith(client, asset));
  const ctx = { workspaceId, publication, variant, socialAccount, credential };
  const common = {
    attempts: createAttemptStore(client),
    loadAssets: async () => assets,
    signMediaUrl: async (asset: { storage_bucket: string; storage_path: string }) => {
      const url = await sign(asset);
      logger.protect(url);
      return url;
    },
    markFailed: (input: Parameters<typeof markFailedAsSystem>[3]) => markFailedAsSystem(client, workspaceId, publication.id, input),
    deadline,
    sleep: deps.sleep,
    log: (line: string) => logger.engineLine(line),
    // 12: kill switch re-read before G1 and immediately before G3.
    beforeProviderMutation: async (step: "container_create" | "media_publish") => {
      const state: RuntimeControlState = await readRuntimeControl(client);
      const allowed = state.on && state.mode === mode && isEnvPublishingGateEnabled(env);
      logger.event("control_recheck", { step, allowed, publicationId: publication.id });
      if (allowed && step === "media_publish") logger.event("g3_dispatch", { publicationId: publication.id });
      if (allowed && step === "container_create") logger.event("g1_dispatch", { publicationId: publication.id });
      return allowed;
    },
  };

  let outcome: StagedPublishOutcome | DryRunOutcome;
  try {
    outcome =
      mode === "publish"
        ? await runStagedImagePublish(ctx, {
            ...common,
            provider,
            markPublished: (input) => markPublishedAsSystem(client, workspaceId, publication.id, input),
          })
        : await runInstagramImageDryRun(ctx, { ...common, provider });
  } catch {
    logger.event("engine", { ok: false, publicationId: publication.id });
    await audit("publication.runtime_final", { outcome: "engine_error", providerCalls: { ...counters } });
    return finish("engine_error");
  } finally {
    credential = "";
  }

  // --- 14 audit -----------------------------------------------------------------
  const code = "code" in outcome ? outcome.code : "reason" in outcome ? outcome.reason : null;
  const attemptId = "attemptId" in outcome ? outcome.attemptId : null;
  const mediaId = "mediaId" in outcome ? (outcome.mediaId ?? null) : null;
  await audit("publication.runtime_final", { outcome: outcome.kind, code, attemptId, mediaId, providerCalls: { ...counters } });
  return finish("completed", { result: outcome.kind, code });
}

type ClaimContext =
  | {
      ok: true;
      variant: Database["public"]["Tables"]["content_variants"]["Row"];
      socialAccount: Database["public"]["Tables"]["social_accounts"]["Row"];
      assets: Awaited<ReturnType<typeof loadVariantPublishAssets>>;
    }
  | { ok: false; reason: string };

async function loadClaimContext(client: SupabaseClient<Database>, publication: Publication): Promise<ClaimContext> {
  try {
    const { data: variant, error: variantError } = await client
      .from("content_variants")
      .select("*")
      .eq("workspace_id", publication.workspace_id)
      .eq("id", publication.content_variant_id)
      .maybeSingle();
    if (variantError || !variant) return { ok: false, reason: "variant_unavailable" };
    const { data: socialAccount, error: accountError } = await client
      .from("social_accounts")
      .select("*")
      .eq("workspace_id", publication.workspace_id)
      .eq("id", publication.social_account_id)
      .maybeSingle();
    if (accountError || !socialAccount) return { ok: false, reason: "account_unavailable" };
    const assets = await loadVariantPublishAssets(client, publication.workspace_id, publication.content_variant_id);
    return { ok: true, variant, socialAccount, assets };
  } catch {
    return { ok: false, reason: "load_error" };
  }
}

async function notifyReconciledFailure(
  client: SupabaseClient<Database>,
  row: RuntimeReconciliationRow,
  logger: ReturnType<typeof createRunLogger>,
): Promise<void> {
  try {
    const { data } = await client
      .from("publications")
      .select("id, workspace_id, created_by, error_code, error_message")
      .eq("workspace_id", row.workspace_id)
      .eq("id", row.publication_id)
      .maybeSingle();
    if (!data) return;
    await insertPublicationFailedNotification(client, {
      workspaceId: data.workspace_id,
      publicationId: data.id,
      recipientUserId: data.created_by,
      errorCode: data.error_code ?? row.action,
      errorMessage: data.error_message ?? "Publishing was interrupted",
    });
  } catch {
    logger.event("reconcile", { notify: "failed", publicationId: row.publication_id });
  }
}
