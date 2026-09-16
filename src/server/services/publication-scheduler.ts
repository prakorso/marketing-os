import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { executePublicationAsSystem } from "@/server/services/publication-execution";
import type { Publication } from "@/types/database";

/**
 * MVP-2.4 Scheduled Execution — the trusted, unattended batch runner
 * invoked by a Netlify Scheduled Function (netlify/functions/), never by
 * any Server Action, API route, or client component.
 *
 * Responsibilities are strictly separated (do not add Vault access,
 * provider logic, or publication business logic here):
 *   1. Atomically claim due publications via the claim_due_publications
 *      RPC (service_role-only, 20260916180000_publication_scheduler_claim.sql) —
 *      this is the ONLY database access this module performs directly.
 *   2. For each claimed row, call executePublicationAsSystem using that
 *      row's own workspace_id — never a browser-supplied one, since there
 *      is no browser involved anywhere in this path.
 *   3. Continue processing the rest of the batch even if one publication
 *      fails or throws — one bad row must not block the others.
 *   4. Return a structured, non-sensitive summary. Never a credential,
 *      token, or Authorization header — only counts and publication IDs.
 *
 * Concurrency safety (two overlapping scheduler invocations claiming the
 * same publication) is handled entirely by claim_due_publications' FOR
 * UPDATE SKIP LOCKED — this module does not implement any locking itself.
 * Business-rule enforcement (approval gate, lifecycle gate) remains in the
 * database triggers, unchanged and un-bypassable by this path.
 */

const BATCH_SIZE = 10;

export type ScheduledExecutionSummary = {
  claimed: number;
  succeeded: number;
  failed: number;
  publicationIds: string[];
};

export async function runScheduledPublications(): Promise<ScheduledExecutionSummary> {
  const client = createServiceRoleClient();

  const { data, error } = await client.rpc("claim_due_publications", { p_batch_size: BATCH_SIZE });
  if (error) {
    throw new Error(`Failed to claim due publications: ${error.message}`);
  }

  const claimedPublications = (data ?? []) as Publication[];

  let succeeded = 0;
  let failed = 0;

  for (const publication of claimedPublications) {
    try {
      const result = await executePublicationAsSystem(publication.workspace_id, publication.id);
      if (result.status === "published") {
        succeeded += 1;
      } else {
        failed += 1;
      }
    } catch {
      // A publication that throws outside the normal success/failure
      // outcome (e.g. an unresolvable social account) is counted as
      // failed for summary purposes; it is not left dangling in
      // 'publishing' by design — executePublicationAsSystem's own
      // try/catch already routes provider errors to markFailedAsSystem
      // before this outer catch would ever run. This outer catch exists
      // only so one publication's unexpected failure never stops the
      // rest of the batch from being attempted.
      failed += 1;
    }
  }

  return {
    claimed: claimedPublications.length,
    succeeded,
    failed,
    publicationIds: claimedPublications.map((publication) => publication.id),
  };
}
