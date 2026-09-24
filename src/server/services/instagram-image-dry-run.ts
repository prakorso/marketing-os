import "server-only";

import type { ContainerPreparationProvider } from "@/lib/social/provider";
import {
  prepareReadyContainer,
  type PrepareDeps,
  type StagedPublishContext,
  type StagedPublishOutcome,
} from "@/server/services/instagram-publish-prepare";

/**
 * MVP-5.35C-D — INTERNAL server-only Instagram IMAGE dry run (future Level 4).
 *
 *   validation → attempt 'validating' → media snapshot → signed URL →
 *   createMediaContainer → container_created → polling → container_ready → STOP
 *
 * STRUCTURAL guarantee: this module never references the publish step. Its
 * provider parameter type is ContainerPreparationProvider (create + status
 * only), and the provider passed in is re-wrapped below into an object that
 * physically has no publishMediaContainer — even if the caller hands over a
 * full adapter. It never writes 'publish_requested'.
 *
 * Terminal semantics: the intentional stop is KNOWN-NOT-PUBLISHED (no
 * media_publish was ever invoked; the container stays unpublished and
 * expires on the provider side after 24 h). Recorded with the existing
 * schema as attempt 'failed' + error_code 'dry_run_container_ready' and the
 * publication moved publishing → failed with the same code. Never
 * outcome_unknown.
 *
 * NOT exposed anywhere: no route, Server Action, UI, scheduler, Netlify
 * function, or feature gate references this module (MVP-5.35C-D §7). A
 * future Level 4 operator mechanism is designed separately.
 */

export const DRY_RUN_STOP_CODE = "dry_run_container_ready";

export type DryRunDeps = Omit<PrepareDeps, "provider"> & {
  provider: ContainerPreparationProvider;
};

export type DryRunOutcome =
  | { kind: "dry_run_container_ready"; attemptId: string; containerId: string }
  | Exclude<StagedPublishOutcome, { kind: "published" }>;

/** Only the two pre-publish methods survive this wrapper. */
function narrowToPreparation(provider: ContainerPreparationProvider): ContainerPreparationProvider {
  return Object.freeze({
    createMediaContainer: (input) => provider.createMediaContainer(input),
    getMediaContainerStatus: (input) => provider.getMediaContainerStatus(input),
  } satisfies ContainerPreparationProvider);
}

export async function runInstagramImageDryRun(ctx: StagedPublishContext, deps: DryRunDeps): Promise<DryRunOutcome> {
  const prepared = await prepareReadyContainer({ ...ctx }, { ...deps, provider: narrowToPreparation(deps.provider) }, "instagram-dry-run");
  if (!prepared.ok) {
    return prepared.outcome as DryRunOutcome;
  }

  const { attempt, containerId } = prepared.prepared;
  const outcome = await prepared.helpers.failKnown(DRY_RUN_STOP_CODE, "Dry run stopped intentionally at container_ready; no publish request was made", {
    containerId,
    dryRun: true,
  });
  if (outcome.kind !== "failed_known") {
    return outcome as DryRunOutcome;
  }
  return { kind: "dry_run_container_ready", attemptId: attempt.id, containerId };
}
