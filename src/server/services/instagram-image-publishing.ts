import "server-only";

import type { StagedMediaPublisher } from "@/lib/social/provider";
import {
  prepareReadyContainer,
  providerSummary,
  withLocalRetries,
  type PrepareDeps,
  type StagedPublishContext,
  type StagedPublishOutcome,
} from "@/server/services/instagram-publish-prepare";
import type { MarkPublishedInput } from "@/server/services/publications";
import type { Publication } from "@/types/database";

export {
  createAttemptStore,
  NON_TERMINAL_ATTEMPT_STAGES,
  type AttemptPatch,
  type AttemptStore,
  type StagedPublishContext,
  type StagedPublishOutcome,
} from "@/server/services/instagram-publish-prepare";

/**
 * MVP-5.35C-B/C-D — IMAGE-only staged Instagram publishing (the REAL
 * engine). Remote progress lives in publication_attempts; the MARQOS
 * lifecycle lives in publications.status.
 *
 *   pre-publish phase (instagram-publish-prepare.ts, shared with the dry run):
 *     duplicate guard → T0 validating → validation → media snapshot →
 *     signed URL → container_created → bounded polling → container_ready
 *   irreversible phase (only here):
 *     T6a DEADLINE GATE — both the publish reserve and the persistence
 *         reserve must be available; otherwise FAILED_KNOWN_NOT_PUBLISHED
 *         (insufficient_publish_time_budget) with NO publish_requested
 *         write and NO media_publish call
 *     T6b 'publish_requested' COMMITTED (if it fails: no media_publish)
 *     T6c media_publish with timeout ≤ remaining − persistence reserve
 *     T7  attempt 'published' + external_media_id FIRST, then publication
 *
 * Classification after media_publish begins follows D4: success, an
 * authoritative rejection (known), or OUTCOME_UNKNOWN (publication stays
 * 'publishing'; no markFailed, no retry). Local persistence failures after
 * a remote success never become failures; they return pending_reconcile
 * carrying the authoritative mediaId (G-1), so recovery never depends on logs.
 */

export type StagedPublishDeps = PrepareDeps & {
  provider: StagedMediaPublisher;
  markPublished: (input: MarkPublishedInput) => Promise<Publication>;
};

export async function runStagedImagePublish(ctx: StagedPublishContext, deps: StagedPublishDeps): Promise<StagedPublishOutcome> {
  const prepared = await prepareReadyContainer(ctx, deps);
  if (!prepared.ok) return prepared.outcome;

  const { attempt: readyAttempt, containerId, targetAccountId } = prepared.prepared;
  const { deadline, sleep, emit, failKnown } = prepared.helpers;
  const { workspaceId } = ctx;

  // --- T6a: pre-irreversible deadline gate (BEFORE publish_requested) --------
  if (!deadline.canStartPublish()) {
    return failKnown("insufficient_publish_time_budget", "Not enough execution time remained to safely request publishing", {
      containerId,
      remainingMs: Math.max(0, Math.round(deadline.remainingMs())),
    });
  }

  // --- T6b: IRREVERSIBLE BOUNDARY — checkpoint must commit first -------------
  let attempt = readyAttempt;
  try {
    attempt = await deps.attempts.update(workspaceId, attempt.id, { stage: "publish_requested" });
  } catch {
    return failKnown("checkpoint_failed", "Could not record the publish request checkpoint; publish was not attempted", { containerId });
  }
  emit("publish_requested", { attemptId: attempt.id, containerId });

  // --- T6c: the irreversible request ------------------------------------------
  const published = await deps.provider.publishMediaContainer({
    credential: ctx.credential,
    accountId: targetAccountId,
    containerId,
    timeoutMs: deadline.publishCallTimeoutMs(),
  });

  if (!published.ok && published.outcome === "rejected") {
    return failKnown("publish_rejected", published.message, providerSummary(published, "media_publish"));
  }

  if (!published.ok) {
    try {
      await withLocalRetries(
        () =>
          deps.attempts.update(workspaceId, attempt.id, {
            stage: "outcome_unknown",
            error_code: published.code,
            error_message: published.message,
          }),
        sleep,
      );
    } catch {
      // Attempt stays 'publish_requested'; the reconciler classifies it as outcome_unknown when stale.
    }
    emit("outcome_unknown", { attemptId: attempt.id, containerId, ...providerSummary(published, "media_publish") });
    return { kind: "outcome_unknown", attemptId: attempt.id, code: published.code };
  }

  // --- T7: durable proof first, then the publication --------------------------
  const mediaId = published.mediaId;
  emit("media_published", { attemptId: attempt.id, containerId, mediaId });
  try {
    await withLocalRetries(() => deps.attempts.update(workspaceId, attempt.id, { stage: "published", external_media_id: mediaId }), sleep);
  } catch {
    return { kind: "pending_reconcile", attemptId: attempt.id, reason: "attempt_published_persistence_failed", mediaId };
  }
  try {
    await withLocalRetries(
      () =>
        deps.markPublished({
          externalPublicationId: mediaId,
          externalUrl: null,
          providerResponse: { attemptId: attempt.id, containerId, mediaId, provider: "instagram", mediaType: "IMAGE" },
        }),
      sleep,
    );
  } catch {
    return { kind: "pending_reconcile", attemptId: attempt.id, reason: "publication_published_persistence_failed", mediaId };
  }
  return { kind: "published", attemptId: attempt.id, mediaId };
}
