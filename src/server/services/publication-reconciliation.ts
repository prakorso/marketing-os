import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RecentMediaItem, StagedMediaPublisher } from "@/lib/social/provider";
import type { AttemptStore } from "@/server/services/instagram-image-publishing";
import type { MarkFailedInput, MarkPublishedInput } from "@/server/services/publications";
import type { Database, Publication, PublicationAttempt, SocialAccount } from "@/types/database";

/**
 * MVP-5.35C-B — publication/attempt reconciliation (internal service only;
 * no UI/action in this milestone). Locked decisions D1/D2:
 *   - an outcome_unknown attempt keeps the publication 'publishing';
 *   - nothing here ever invokes media_publish or creates a container;
 *   - heuristic media correlation is evidence only — never auto-selected,
 *     never auto-finalized;
 *   - provider reads that fail never change state.
 */

export type ReconcileDeps = {
  client: SupabaseClient<Database>;
  attempts: AttemptStore;
  markPublished: (workspaceId: string, publicationId: string, input: MarkPublishedInput) => Promise<Publication>;
  markFailed: (workspaceId: string, publicationId: string, input: MarkFailedInput) => Promise<Publication>;
  now?: () => number;
  /** Pre-publish stages (validating/container_*) older than this are provably interrupted before publish. */
  staleBeforePublishMs?: number;
  /** publish_requested older than this is classified outcome_unknown. */
  stalePublishRequestedMs?: number;
};

export type LocalReconcileResult =
  | { kind: "nothing_to_reconcile" }
  | { kind: "in_progress"; attemptId: string; stage: string }
  | { kind: "finalized_published"; attemptId: string; mediaId: string }
  | { kind: "resolved_not_published"; attemptId: string }
  | { kind: "marked_outcome_unknown"; attemptId: string }
  | { kind: "outcome_unknown_requires_inspection"; attemptId: string };

async function loadPublication(client: SupabaseClient<Database>, workspaceId: string, publicationId: string) {
  const { data, error } = await client
    .from("publications")
    .select("id, workspace_id, status, content_variant_id, social_account_id, external_publication_id")
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .single();
  if (error || !data) throw new Error(`Failed to load publication: ${error?.message ?? "not found"}`);
  return data;
}

/**
 * Deterministic, provider-free reconciliation of the latest attempt:
 *   - attempt 'published' + publication 'publishing' → finalize publishing → published;
 *   - stale pre-publish attempt → failed (known not published) + publication failed;
 *   - stale publish_requested → outcome_unknown (publication stays publishing);
 *   - outcome_unknown → requires inspectUnknownPublishOutcome.
 */
export async function reconcilePublicationLocally(
  workspaceId: string,
  publicationId: string,
  deps: ReconcileDeps,
): Promise<LocalReconcileResult> {
  const now = deps.now ?? (() => Date.now());
  const staleBeforePublishMs = deps.staleBeforePublishMs ?? 10 * 60_000;
  const stalePublishRequestedMs = deps.stalePublishRequestedMs ?? 5 * 60_000;

  const publication = await loadPublication(deps.client, workspaceId, publicationId);
  const attempts = await deps.attempts.listForPublication(workspaceId, publicationId);
  const latest = attempts[attempts.length - 1];
  if (!latest) return { kind: "nothing_to_reconcile" };

  const age = now() - new Date(latest.updated_at).getTime();

  if (latest.stage === "published") {
    if (publication.status === "publishing" && latest.external_media_id) {
      await deps.markPublished(workspaceId, publicationId, {
        externalPublicationId: latest.external_media_id,
        externalUrl: null,
        providerResponse: {
          attemptId: latest.id,
          containerId: latest.container_ids[0] ?? null,
          mediaId: latest.external_media_id,
          provider: latest.provider,
          reconciliation: "finalized_from_published_attempt",
        },
      });
      return { kind: "finalized_published", attemptId: latest.id, mediaId: latest.external_media_id };
    }
    return { kind: "nothing_to_reconcile" };
  }

  if (latest.stage === "validating" || latest.stage === "container_created" || latest.stage === "container_ready") {
    if (age < staleBeforePublishMs) return { kind: "in_progress", attemptId: latest.id, stage: latest.stage };
    // media_publish was never checkpointed, hence never invoked → provably not published.
    await deps.attempts.update(workspaceId, latest.id, {
      stage: "failed",
      error_code: "interrupted_before_publish",
      error_message: "Attempt was interrupted before the publish request",
    });
    if (publication.status === "publishing") {
      await deps.markFailed(workspaceId, publicationId, {
        errorCode: "interrupted_before_publish",
        errorMessage: "Publishing was interrupted before the publish request",
        providerResponse: { attemptId: latest.id, reconciliation: "stale_pre_publish" },
      });
    }
    return { kind: "resolved_not_published", attemptId: latest.id };
  }

  if (latest.stage === "publish_requested") {
    if (age < stalePublishRequestedMs) return { kind: "in_progress", attemptId: latest.id, stage: latest.stage };
    await deps.attempts.update(workspaceId, latest.id, {
      stage: "outcome_unknown",
      error_code: "interrupted_during_publish",
      error_message: "The process stopped after the publish request began; the remote outcome is unknown",
    });
    return { kind: "marked_outcome_unknown", attemptId: latest.id };
  }

  if (latest.stage === "outcome_unknown") {
    return { kind: "outcome_unknown_requires_inspection", attemptId: latest.id };
  }

  return { kind: "nothing_to_reconcile" };
}

export type InspectDeps = {
  client: SupabaseClient<Database>;
  attempts: AttemptStore;
  provider: StagedMediaPublisher;
  /** Server-side Vault resolution; the value is never logged or returned. */
  resolveCredential: (account: SocialAccount) => Promise<string>;
  /** Heuristic window around the attempt for recent-media candidates. */
  candidateWindowMs?: number;
};

export type UnknownOutcomeEvidence =
  | { kind: "not_unknown"; stage: string | null }
  | { kind: "provider_read_failed"; attemptId: string; code: string }
  | { kind: "not_published_operator_decision_required"; attemptId: string; containerStatus: "FINISHED" }
  | { kind: "known_not_published"; attemptId: string; containerStatus: "ERROR" | "EXPIRED" }
  | {
      kind: "published_media_id_unconfirmed";
      attemptId: string;
      containerStatus: "PUBLISHED";
      /** HEURISTIC evidence only — operator confirmation is always required (D2). */
      candidates: RecentMediaItem[];
      requiresOperatorConfirmation: true;
    }
  | { kind: "indeterminate"; attemptId: string; containerStatus: string };

async function loadUnknownContext(workspaceId: string, publicationId: string, deps: Pick<InspectDeps, "client" | "attempts">) {
  const publication = await loadPublication(deps.client, workspaceId, publicationId);
  const attempts = await deps.attempts.listForPublication(workspaceId, publicationId);
  const latest: PublicationAttempt | undefined = attempts[attempts.length - 1];
  return { publication, latest };
}

/** Read-only provider inspection of an outcome_unknown attempt. Never changes state. */
export async function inspectUnknownPublishOutcome(
  workspaceId: string,
  publicationId: string,
  deps: InspectDeps,
): Promise<UnknownOutcomeEvidence> {
  const { publication, latest } = await loadUnknownContext(workspaceId, publicationId, deps);
  if (!latest || latest.stage !== "outcome_unknown" || publication.status !== "publishing") {
    return { kind: "not_unknown", stage: latest?.stage ?? null };
  }
  const containerId = latest.container_ids[0];
  if (!containerId) {
    return { kind: "indeterminate", attemptId: latest.id, containerStatus: "NO_CONTAINER_RECORDED" };
  }

  const { data: account, error: accountError } = await deps.client
    .from("social_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", publication.social_account_id)
    .single();
  if (accountError || !account) {
    return { kind: "provider_read_failed", attemptId: latest.id, code: "account_unavailable" };
  }

  let credential: string;
  try {
    credential = await deps.resolveCredential(account);
  } catch {
    return { kind: "provider_read_failed", attemptId: latest.id, code: "credential_unavailable" };
  }

  const status = await deps.provider.getMediaContainerStatus({ credential, containerId });
  if (!status.ok) return { kind: "provider_read_failed", attemptId: latest.id, code: status.code };

  if (status.status === "FINISHED") {
    return { kind: "not_published_operator_decision_required", attemptId: latest.id, containerStatus: "FINISHED" };
  }
  if (status.status === "ERROR" || status.status === "EXPIRED") {
    return { kind: "known_not_published", attemptId: latest.id, containerStatus: status.status };
  }
  if (status.status === "PUBLISHED") {
    const { data: variant } = await deps.client
      .from("content_variants")
      .select("caption")
      .eq("workspace_id", workspaceId)
      .eq("id", publication.content_variant_id)
      .maybeSingle();
    const recent = await deps.provider.listRecentMedia({ credential, accountId: account.external_account_id });
    const windowMs = deps.candidateWindowMs ?? 10 * 60_000;
    const from = new Date(latest.started_at).getTime() - 60_000;
    const to = new Date(latest.updated_at).getTime() + windowMs;
    const caption = variant?.caption ?? null;
    const candidates = recent.ok
      ? recent.items.filter((item) => {
          const at = item.timestamp ? new Date(item.timestamp).getTime() : NaN;
          return Number.isFinite(at) && at >= from && at <= to && (item.caption ?? null) === caption;
        })
      : [];
    return {
      kind: "published_media_id_unconfirmed",
      attemptId: latest.id,
      containerStatus: "PUBLISHED",
      candidates,
      requiresOperatorConfirmation: true,
    };
  }
  return { kind: "indeterminate", attemptId: latest.id, containerStatus: status.status };
}

/**
 * Applies the ONLY automatic-safe unknown resolution: the provider reports
 * the container ERROR/EXPIRED (never published) → publication failed. It
 * re-reads the provider status itself; any other status changes nothing.
 * The attempt row stays outcome_unknown (immutable history).
 */
export async function resolveUnknownAsNotPublished(
  workspaceId: string,
  publicationId: string,
  deps: InspectDeps & Pick<ReconcileDeps, "markFailed">,
): Promise<{ resolved: boolean; evidence: UnknownOutcomeEvidence }> {
  const evidence = await inspectUnknownPublishOutcome(workspaceId, publicationId, deps);
  if (evidence.kind !== "known_not_published") return { resolved: false, evidence };
  await deps.markFailed(workspaceId, publicationId, {
    errorCode: evidence.containerStatus === "ERROR" ? "container_error" : "container_expired",
    errorMessage: `Reconciled: container ${evidence.containerStatus}, never published`,
    providerResponse: { attemptId: evidence.attemptId, reconciliation: "container_status", containerStatus: evidence.containerStatus },
  });
  return { resolved: true, evidence };
}

/** Instagram media ids are non-empty digit strings, kept lossless (never coerced through Number). */
export function isInstagramMediaId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

export type ConfirmedMediaInput = {
  attemptId: string;
  /** Authoritative (captured 2xx body) or operator-confirmed media id. */
  mediaId: string;
  /** Where the confirmation evidence lives (e.g. an operator evidence file / review record). */
  evidenceRef: string;
};

export type FinalizeConfirmedResult =
  | { kind: "finalized"; path: "publish_requested" | "outcome_unknown"; attemptId: string; mediaId: string }
  | { kind: "already_finalized"; attemptId: string; mediaId: string }
  | { kind: "attempt_persistence_failed"; attemptId: string; mediaId: string }
  | { kind: "pending_reconcile"; attemptId: string; mediaId: string; reason: "publication_published_persistence_failed" }
  | { kind: "refused"; reason: string };

/**
 * MVP-5.35C-I (G-2) — applies an operator-confirmed media id to a
 * publication whose publish outcome is recorded but not finalized. NEVER
 * calls the provider (no media_publish, no create, no read). Fail-closed:
 *   - publication must be 'publishing' (or already 'published' with the SAME
 *     id → already_finalized no-op; a different id is a hard refusal);
 *   - the attempt must be the publication's LATEST attempt, in the same
 *     workspace, for the expected provider, at publish_requested or
 *     outcome_unknown;
 *   - publish_requested: attempt → published + external_media_id FIRST, then
 *     the publication (a failed attempt write leaves the publication
 *     publishing);
 *   - outcome_unknown: the terminal attempt is NOT modified (immutable
 *     history); only the publication is marked published, with provenance.
 */
export async function finalizeWithConfirmedMediaId(
  workspaceId: string,
  publicationId: string,
  input: ConfirmedMediaInput,
  deps: Pick<ReconcileDeps, "client" | "attempts" | "markPublished"> & { expectedProvider?: string },
): Promise<FinalizeConfirmedResult> {
  const expectedProvider = deps.expectedProvider ?? "instagram";
  if (!isInstagramMediaId(input.mediaId)) return { kind: "refused", reason: "invalid_media_id" };
  if (typeof input.evidenceRef !== "string" || input.evidenceRef.trim() === "") return { kind: "refused", reason: "missing_evidence_ref" };

  let publication: Awaited<ReturnType<typeof loadPublication>>;
  try {
    publication = await loadPublication(deps.client, workspaceId, publicationId);
  } catch {
    return { kind: "refused", reason: "publication_not_found" };
  }
  const attempts = await deps.attempts.listForPublication(workspaceId, publicationId);
  const attempt = attempts.find((row) => row.id === input.attemptId);
  if (!attempt || attempt.workspace_id !== workspaceId || attempt.publication_id !== publicationId) {
    return { kind: "refused", reason: "attempt_not_found_for_publication" };
  }
  if (attempt.provider !== expectedProvider) return { kind: "refused", reason: "attempt_provider_mismatch" };
  if (attempts[attempts.length - 1]?.id !== attempt.id) return { kind: "refused", reason: "attempt_not_latest" };

  if (publication.status === "published") {
    return publication.external_publication_id === input.mediaId
      ? { kind: "already_finalized", attemptId: attempt.id, mediaId: input.mediaId }
      : { kind: "refused", reason: "published_with_different_media_id" };
  }
  if (publication.status !== "publishing") return { kind: "refused", reason: `publication_${publication.status}` };
  if (attempt.stage !== "publish_requested" && attempt.stage !== "outcome_unknown") {
    return { kind: "refused", reason: `attempt_stage_${attempt.stage}` };
  }

  const path = attempt.stage;
  if (path === "publish_requested") {
    try {
      await deps.attempts.update(workspaceId, attempt.id, { stage: "published", external_media_id: input.mediaId });
    } catch {
      return { kind: "attempt_persistence_failed", attemptId: attempt.id, mediaId: input.mediaId };
    }
  }

  try {
    await deps.markPublished(workspaceId, publicationId, {
      externalPublicationId: input.mediaId,
      externalUrl: null,
      providerResponse: {
        attemptId: attempt.id,
        containerId: attempt.container_ids[0] ?? null,
        mediaId: input.mediaId,
        provider: attempt.provider,
        reconciliation: "operator_confirmed",
        attemptStageAtConfirmation: path,
        evidenceRef: input.evidenceRef,
      },
    });
  } catch {
    // publish_requested path: the attempt is durably 'published' → reconcilePublicationLocally finalizes.
    return { kind: "pending_reconcile", attemptId: attempt.id, mediaId: input.mediaId, reason: "publication_published_persistence_failed" };
  }
  return { kind: "finalized", path, attemptId: attempt.id, mediaId: input.mediaId };
}
