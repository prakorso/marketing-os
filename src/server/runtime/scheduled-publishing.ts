import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createInstagramMediaContainer,
  getInstagramMediaContainerStatus,
  listInstagramRecentMedia,
  publishInstagramMediaContainer,
} from "@/lib/social/instagram-graph";
import type { StagedMediaPublisher } from "@/lib/social/provider";
import { createAttemptStore } from "@/server/services/instagram-publish-prepare";
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
import { isEnvPublishingGateEnabled, readRuntimeControl } from "@/server/runtime/runtime-control";
import {
  RuntimeBudget,
  runNewWork,
  runResume,
  TERMINAL_OUTCOME_KINDS,
  type EngineContext,
  type EngineDeps,
  type EngineOutcome,
  type RuntimeBudgetConfig,
  type RuntimeCheckpoint,
} from "@/server/runtime/runtime-engine";
import { withoutPublishCapability, withRuntimeCallCeiling, type RuntimeCallCounters } from "@/server/runtime/runtime-provider-ceiling";
import type { Database, Publication, PublicationAttempt, PublicationAttemptStage, PublishingRuntimeMode, RuntimeReconciliationRow } from "@/types/database";

/**
 * MVP-5.36 / H2 — the Level-6 unattended scheduled publishing runtime,
 * hardened per H0 Option C (lease-serialized, resumable, single-flight;
 * scheduler delivery is AT-LEAST-ONCE). Invoked only by the Netlify
 * Scheduled Function netlify/functions/execute-due-publications.ts.
 *
 *    1 runId + 25 s budget
 *    2 read DB control            3 missing / OFF → log + RETURN (no lease, no mutation)
 *    4 env gate                   5 ≠ "enabled"   → log + RETURN (no lease, no mutation)
 *    6 acquire_runtime_slot_lease 7 not the holder → scheduler_duplicate_suppressed + RETURN
 *                                   (no reconcile, no claim, no Vault, no provider)
 *    8 reconcile v2 (holder only, provider-free)
 *    9 select_runtime_resume     10 found → RESUME (never claim)
 *   11 else claim v3 (cap 1, single-flight)       12 nothing → complete lease 'no_work'
 *   13 load context              14 eligibility (new work only)
 *   15 control re-check after selection            16 control re-check before Vault
 *   17 Vault (one read)          18 engine NEW | RESUME (runtime-engine.ts)
 *   19 audit                     20 complete lease  21 final log
 *
 * The DB (H1 RPCs) is authoritative for the slot, lease ownership,
 * single-flight and resume/claim eligibility; this module follows the same
 * order. Every path after lease acquisition completes the lease with a
 * bounded outcome; a completion failure is logged and never repeats a
 * provider side effect. Logs are single JSON lines with runId and
 * logicalSlot; credentials, the service-role key and signed URLs are never
 * logged (and are scrubbed if they ever appear).
 */

/** Stale threshold for provider-free reconciliation (DB clock); ≫ the 30 s platform limit. */
export const RUNTIME_STALE_THRESHOLD_SECONDS = 600;
export const RUNTIME_CLAIM_CAP = 1;

export type RuntimeOutcome =
  | "runtime_disabled"
  | "env_gate_disabled"
  | "lease_failed"
  | "duplicate_suppressed"
  | "reconcile_failed"
  | "selection_failed"
  | "no_work"
  | "load_failed"
  | "ineligible"
  | "runtime_disabled_after_selection"
  | "credential_unavailable"
  | "engine_error"
  | "completed";

export type WorkKind = "resume" | "claim" | "none";

export type RuntimeSummary = {
  runId: string;
  outcome: RuntimeOutcome;
  mode: PublishingRuntimeMode | null;
  logicalSlot: string | null;
  leaseCompleted: boolean;
  workKind: WorkKind | null;
  reconciled: number;
  claimed: number;
  publicationId: string | null;
  attemptId: string | null;
  attemptStage: PublicationAttemptStage | null;
  result: EngineOutcome["kind"] | null;
  code: string | null;
  terminal: boolean;
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
  /** Monotonic clock for the budget (tests inject). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budget?: Partial<RuntimeBudgetConfig>;
  staleSeconds?: number;
  log?: (line: string) => void;
};

const graphPublisher: StagedMediaPublisher = Object.freeze({
  createMediaContainer: createInstagramMediaContainer,
  getMediaContainerStatus: getInstagramMediaContainerStatus,
  publishMediaContainer: publishInstagramMediaContainer,
  listRecentMedia: listInstagramRecentMedia,
});

const RECONCILE_FAILED_ACTIONS = new Set([
  "failed_no_attempt",
  "failed_pre_provider",
  "failed_pre_publish",
  "failed_g1_unknown",
  "failed_container_not_ready",
  "failed_publish_window_expired",
  "failed_from_attempt",
]);

/** Bounded lease outcomes (H1 validates ^[a-z0-9_]{1,64}$). */
function leaseOutcomeOf(outcome: EngineOutcome): string {
  return outcome.kind === "deferred" ? `deferred_${outcome.reason}` : outcome.kind;
}

function createRunLogger(runId: string, write: (line: string) => void) {
  const sensitive = new Set<string>();
  const base: Record<string, unknown> = { scope: "marqos-runtime", runId };
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
    bind(fields: Record<string, unknown>) {
      Object.assign(base, fields);
    },
    event(event: string, fields: Record<string, unknown> = {}) {
      try {
        write(scrub(JSON.stringify({ ...base, event, ...fields })));
      } catch {
        // Logging must never affect execution.
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
  // --- 1 runId + invocation budget ---------------------------------------------
  const runId = deps.runId ?? crypto.randomUUID();
  const env = deps.env ?? process.env;
  const budget = new RuntimeBudget({ now: deps.now, config: deps.budget });
  const logger = createRunLogger(runId, deps.log ?? ((line) => console.info(line)));
  logger.protect(env.SUPABASE_SERVICE_ROLE_KEY);
  const counters: RuntimeCallCounters = { create: 0, status: 0, publish: 0 };
  const summary: RuntimeSummary = {
    runId,
    outcome: "runtime_disabled",
    mode: null,
    logicalSlot: null,
    leaseCompleted: false,
    workKind: null,
    reconciled: 0,
    claimed: 0,
    publicationId: null,
    attemptId: null,
    attemptStage: null,
    result: null,
    code: null,
    terminal: false,
    providerCalls: counters,
    vaultReads: 0,
  };
  const finish = (outcome: RuntimeOutcome, extra: Partial<RuntimeSummary> = {}): RuntimeSummary => {
    Object.assign(summary, extra, { outcome });
    logger.event("final", {
      outcome: summary.outcome,
      mode: summary.mode,
      workKind: summary.workKind,
      terminal: summary.terminal,
      publicationId: summary.publicationId,
      attemptId: summary.attemptId,
      attemptStage: summary.attemptStage,
      result: summary.result,
      code: summary.code,
      reconciled: summary.reconciled,
      claimed: summary.claimed,
      vaultReads: summary.vaultReads,
      providerCalls: { ...counters },
      leaseCompleted: summary.leaseCompleted,
      remainingMs: Math.round(budget.remainingMs()),
      elapsedMs: Math.round(budget.elapsedMs()),
    });
    return summary;
  };
  logger.event("scheduler_start", { budgetMs: budget.config.totalMs });

  // --- 2/3 DB runtime control (fail-closed; no lease, no mutation) -------------------
  const control = await readRuntimeControl(deps.client);
  if (!control.on || !deps.client) {
    logger.event("runtime_disabled", { gate: "db_control", reason: control.on ? "unreadable" : control.reason });
    return finish("runtime_disabled");
  }
  const client = deps.client;
  const mode = control.mode;
  summary.mode = mode;

  // --- 4/5 env gate (no lease, no mutation) ---------------------------------------------
  if (!isEnvPublishingGateEnabled(env)) {
    logger.event("runtime_disabled", { gate: "env" });
    return finish("env_gate_disabled");
  }

  // --- 6/7 slot lease ------------------------------------------------------------------------
  let lease: Database["public"]["Functions"]["acquire_runtime_slot_lease"]["Returns"][number] | undefined;
  try {
    const { data, error } = await client.rpc("acquire_runtime_slot_lease", { p_run_id: runId });
    lease = error ? undefined : data?.[0];
  } catch {
    lease = undefined;
  }
  if (!lease) {
    logger.event("lease", { outcome: "error" });
    return finish("lease_failed");
  }
  summary.logicalSlot = lease.slot_start;
  logger.bind({ logicalSlot: lease.slot_start });
  const holds = lease.acquired && (lease.reason === "acquired" || (lease.reason === "already_held" && lease.holder_run_id === runId));
  if (!holds) {
    if (lease.reason === "control_off") {
      logger.event("runtime_disabled", { gate: "db_control", reason: "control_off_at_lease" });
      return finish("runtime_disabled");
    }
    logger.event("scheduler_duplicate_suppressed", { reason: lease.reason, holderRunId: lease.holder_run_id });
    return finish("duplicate_suppressed");
  }
  logger.event("lease", { outcome: lease.reason, mode: lease.mode });

  // Everything below holds the lease: every exit completes it (bounded outcome).
  const completeLease = async (outcome: string) => {
    try {
      const { data, error } = await client.rpc("complete_runtime_slot_lease", { p_run_id: runId, p_outcome: outcome });
      const row = data?.[0];
      summary.leaseCompleted = !error && !!row?.completed;
      logger.event("lease_complete", { outcome, completed: summary.leaseCompleted, reason: row?.reason ?? "error" });
    } catch {
      logger.event("lease_complete", { outcome, completed: false, reason: "error" });
    }
  };
  const done = async (outcome: RuntimeOutcome, leaseOutcome: string, extra: Partial<RuntimeSummary> = {}) => {
    await completeLease(leaseOutcome);
    return finish(outcome, extra);
  };

  let credential = "";
  try {
    // --- 8 reconcile v2 (provider-free; holder only) ----------------------------------------
    const staleSeconds = deps.staleSeconds ?? RUNTIME_STALE_THRESHOLD_SECONDS;
    const { data: reconciled, error: reconcileError } = await client.rpc("reconcile_stale_runtime_publications", {
      p_stale_seconds: staleSeconds,
      p_run_id: runId,
    });
    if (reconcileError) {
      logger.event("reconcile", { ok: false });
      return await done("reconcile_failed", "reconcile_failed");
    }
    const rows: RuntimeReconciliationRow[] = reconciled ?? [];
    const acted = rows.filter((row) => !row.action.startsWith("skipped_"));
    summary.reconciled = acted.length;
    logger.event("reconcile", {
      ok: true,
      staleSeconds,
      rows: rows.map((row) => ({ publicationId: row.publication_id, attemptId: row.attempt_id, action: row.action })),
    });
    for (const row of acted) {
      await writeAudit(client, {
        workspaceId: row.workspace_id,
        publicationId: row.publication_id,
        action: "publication.runtime_reconciled",
        metadata: { runId, logicalSlot: summary.logicalSlot, attemptId: row.attempt_id, action: row.action },
      });
      if (RECONCILE_FAILED_ACTIONS.has(row.action)) await notifyReconciledFailure(client, row, logger);
    }

    // --- 9–12 RESUME ELSE CLAIM ELSE NONE ------------------------------------------------------
    let publication: Publication | null = null;
    let resumeAttempt: PublicationAttempt | null = null;
    const { data: resumeRows, error: resumeError } = await client.rpc("select_runtime_resume", { p_run_id: runId });
    if (resumeError) {
      logger.event("work_selected", { ok: false, step: "resume" });
      return await done("selection_failed", "selection_failed");
    }
    const resume = resumeRows?.[0];
    if (resume) {
      summary.workKind = "resume";
      const [{ data: pubRow }, { data: attemptRow }] = await Promise.all([
        client.from("publications").select("*").eq("workspace_id", resume.workspace_id).eq("id", resume.publication_id).maybeSingle(),
        client.from("publication_attempts").select("*").eq("workspace_id", resume.workspace_id).eq("id", resume.attempt_id).maybeSingle(),
      ]);
      publication = pubRow ?? null;
      resumeAttempt = attemptRow ?? null;
      if (!publication || !resumeAttempt) {
        logger.event("work_selected", { ok: false, kind: "resume", reason: "resume_rows_unavailable" });
        return await done("load_failed", "load_failed", { publicationId: resume.publication_id, attemptId: resume.attempt_id });
      }
    } else {
      const { data: claimedRows, error: claimError } = await client.rpc("claim_runtime_publications", { p_cap: RUNTIME_CLAIM_CAP, p_run_id: runId });
      if (claimError) {
        logger.event("work_selected", { ok: false, step: "claim" });
        return await done("selection_failed", "selection_failed");
      }
      const claimed: Publication[] = claimedRows ?? [];
      summary.claimed = claimed.length;
      publication = claimed[0] ?? null;
      summary.workKind = publication ? "claim" : "none";
    }
    if (!publication) {
      logger.event("work_selected", { kind: "none" });
      return await done("no_work", "no_work");
    }
    const pub = publication;
    const workspaceId = pub.workspace_id;
    summary.publicationId = pub.id;
    summary.attemptId = resumeAttempt?.id ?? null;
    summary.attemptStage = resumeAttempt?.stage ?? null;
    logger.event("work_selected", {
      kind: summary.workKind,
      publicationId: pub.id,
      attemptId: resumeAttempt?.id ?? null,
      stage: resumeAttempt?.stage ?? null,
    });
    const audit = (metadata: Record<string, unknown>) =>
      writeAudit(client, {
        workspaceId,
        publicationId: pub.id,
        action: "publication.runtime_final",
        metadata: { runId, logicalSlot: summary.logicalSlot, mode, workKind: summary.workKind, ...metadata },
      });

    // --- 13/14 load + eligibility (no Vault, no provider) ------------------------------------
    const loaded = await loadClaimContext(client, pub);
    if (!loaded.ok) {
      logger.event("load", { ok: false, publicationId: pub.id, reason: loaded.reason });
      await audit({ outcome: "load_failed", reason: loaded.reason });
      return await done("load_failed", "load_failed", { code: loaded.reason });
    }
    const { variant, socialAccount, assets } = loaded;
    if (summary.workKind === "claim") {
      const eligibility = validateImagePublishEligibility({ workspaceId, variant, socialAccount, assets });
      if (!eligibility.ok) {
        try {
          await markFailedAsSystem(client, workspaceId, pub.id, {
            errorCode: eligibility.code,
            errorMessage: eligibility.message,
            providerResponse: { runId, stage: "runtime_eligibility" },
          });
        } catch {
          logger.event("load", { persist: "mark_failed_failed", publicationId: pub.id });
        }
        logger.event("load", { ok: true, eligible: false, publicationId: pub.id, code: eligibility.code });
        await audit({ outcome: "ineligible", code: eligibility.code });
        return await done("ineligible", "ineligible", { code: eligibility.code, terminal: true });
      }
    }
    logger.event("load", { ok: true, eligible: true, publicationId: pub.id });

    // --- 15/16 runtime-local control re-checks (after selection, before Vault) ---------------------
    const controlStillOn = async (step: string): Promise<boolean> => {
      const state = await readRuntimeControl(client);
      const allowed = state.on && state.mode === mode && isEnvPublishingGateEnabled(env);
      logger.event("control_recheck", { step, allowed, publicationId: pub.id });
      return allowed;
    };
    if (!(await controlStillOn("after_selection")) || !(await controlStillOn("before_vault"))) {
      // Claimed-without-attempt stays 'publishing' (the reconciler closes it when ON); resumable state is preserved.
      logger.event("runtime_disabled", { gate: "db_control", at: "after_selection", publicationId: pub.id });
      return await done("runtime_disabled_after_selection", "runtime_disabled");
    }

    // --- 17 Vault: exactly one read ----------------------------------------------------------------
    summary.vaultReads = 1;
    try {
      // Not in the generated Database types (Vault helper; service_role execute only).
      const { data, error } = (await client.rpc("read_social_account_vault_secret" as never, {
        p_secret_id: socialAccount.vault_secret_id,
      } as never)) as { data: unknown; error: unknown };
      if (error || typeof data !== "string" || data.length === 0) throw new Error("unavailable");
      credential = data;
    } catch {
      logger.event("vault", { ok: false, publicationId: pub.id });
      if (summary.workKind === "claim") {
        try {
          await markFailedAsSystem(client, workspaceId, pub.id, {
            errorCode: "credential_unavailable",
            errorMessage: "The stored credential could not be resolved; no provider request was made",
            providerResponse: { runId, stage: "runtime_vault" },
          });
        } catch {
          logger.event("vault", { persist: "mark_failed_failed", publicationId: pub.id });
        }
        await audit({ outcome: "credential_unavailable" });
        return await done("credential_unavailable", "credential_unavailable", { code: "credential_unavailable", terminal: true });
      }
      // Resume: preserve the in-flight state (the reconciler expires it after READINESS_MAX).
      await audit({ outcome: "credential_unavailable", attemptId: resumeAttempt?.id ?? null });
      return await done("credential_unavailable", "credential_unavailable", { code: "credential_unavailable" });
    }
    logger.protect(credential);
    logger.event("vault", { ok: true, publicationId: pub.id });

    // --- 18 engine -------------------------------------------------------------------------------------
    const ceiled = withRuntimeCallCeiling(deps.provider ?? graphPublisher, counters);
    // dry_run: the publish capability is removed structurally (defence in depth with the engine's mode branch).
    const provider = mode === "publish" ? ceiled : withoutPublishCapability(ceiled);
    const sign = deps.signMediaUrl ?? ((asset) => createPublishSignedUrlWith(client, asset));
    const leaseStillHeld = async (): Promise<boolean> => {
      if (budget.elapsedMs() >= 55_000) return false;
      const { data, error } = await client
        .from("publishing_runtime_slot_lease")
        .select("run_id, completed_at")
        .eq("runtime_key", "instagram_scheduled_publishing")
        .eq("run_id", runId)
        .maybeSingle();
      return !error && !!data && data.completed_at === null;
    };
    const engineDeps: EngineDeps = {
      runId,
      mode,
      attempts: createAttemptStore(client),
      provider,
      signMediaUrl: async (asset) => {
        const url = await sign(asset);
        logger.protect(url);
        return url;
      },
      markFailed: (input) => markFailedAsSystem(client, workspaceId, pub.id, input),
      markPublished: (input) => markPublishedAsSystem(client, workspaceId, pub.id, input),
      budget,
      allowed: async (step: RuntimeCheckpoint) => {
        const state = await readRuntimeControl(client);
        let allowed = state.on && state.mode === mode && isEnvPublishingGateEnabled(env);
        if (allowed && (step === "publish_request" || step === "media_publish")) allowed = await leaseStillHeld();
        logger.event("control_recheck", { step, allowed, publicationId: pub.id, remainingMs: Math.round(budget.remainingMs()) });
        return allowed;
      },
      emit: (event, fields) => logger.event(event, { mode, workKind: summary.workKind, ...fields }),
      sleep: deps.sleep,
    };
    const ctx: EngineContext = { workspaceId, publication: pub, variant, socialAccount, credential };

    let outcome: EngineOutcome;
    try {
      outcome = resumeAttempt ? await runResume(ctx, resumeAttempt, engineDeps) : await runNewWork(ctx, assets, engineDeps);
    } catch {
      logger.event("engine", { ok: false, publicationId: pub.id });
      await audit({ outcome: "engine_error", providerCalls: { ...counters } });
      return await done("engine_error", "internal_error");
    } finally {
      credential = "";
      ctx.credential = "";
    }

    // --- 19–21 audit, lease completion, final --------------------------------------------------------
    const code = "code" in outcome ? outcome.code : "reason" in outcome ? outcome.reason : null;
    const mediaId = "mediaId" in outcome ? (outcome.mediaId ?? null) : null;
    const attemptId = "attemptId" in outcome ? outcome.attemptId : summary.attemptId;
    const terminal = TERMINAL_OUTCOME_KINDS.has(outcome.kind);
    await audit({ outcome: outcome.kind, code, attemptId, attemptStage: outcome.stage, mediaId, terminal, providerCalls: { ...counters } });
    return await done("completed", leaseOutcomeOf(outcome), { result: outcome.kind, code, terminal, attemptId, attemptStage: outcome.stage });
  } catch {
    // Unexpected internal error after the lease: no provider side effect is ever replayed here.
    logger.event("engine", { ok: false, reason: "internal_error" });
    return await done("engine_error", "internal_error");
  } finally {
    credential = "";
  }
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
