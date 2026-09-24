import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { CALENDAR_PUBLICATION_STATUSES, type CalendarPublicationStatus } from "@/components/calendar/types";
import { createClient } from "@/lib/supabase/server";
import { notifyPublicationFailed } from "@/server/services/notifications";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { ContentApprovalStatus, Database, Publication } from "@/types/database";

/**
 * Business-row lifecycle for publications, including the execution
 * outcome transitions added in MVP-2.3 (markPublishing/markPublished/
 * markFailed). retryPublication remains out of scope (retry semantics are
 * still unspecified by canonical docs — deferred, not invented).
 *
 * Uses only the normal RLS-scoped Supabase client
 * (src/lib/supabase/server.ts) for every publications-row read/write —
 * publications carry no credentials themselves, so there is no reason to
 * reach for the service-role client for that purpose anywhere in this
 * module. Credential resolution (Vault) lives entirely in
 * src/server/services/publication-execution.ts, narrowly scoped to the one
 * moment a credential is needed immediately before a provider call —
 * never here.
 *
 * MVP-2.6 adds one narrow exception: markFailed/markFailedAsSystem create a
 * `publication_failed` notification as a side effect of a successful
 * failure transition, via notifications.ts's notifyPublicationFailed(),
 * which uses the service-role client only for that one notification insert
 * (see notifications.ts's module comment for why). This does not change
 * how the publications row itself is read or written.
 *
 * markPublishing/markPublished/markFailed rely on the database as the
 * authoritative source-state enforcement layer
 * (enforce_publication_lifecycle_transitions,
 * 20260916160000_publication_execution.sql): scheduled→publishing,
 * publishing→published, publishing→failed only. These functions do not
 * duplicate that check in application code — the trigger's rejection
 * (surfaced as a Postgres error) is sufficient, since all three are called
 * only from the controlled sequence in publication-execution.ts, not
 * directly from arbitrary user input.
 *
 * MVP-2.4 adds three "AsSystem" counterparts (markPublishingAsSystem,
 * markPublishedAsSystem, markFailedAsSystem) for the trusted, unattended
 * scheduler path (src/server/services/publication-scheduler.ts →
 * publication-execution.ts's executePublicationAsSystem), which has no
 * end-user session and therefore cannot satisfy assertEditor(). These are
 * NOT a generic "skip authorization" flag: each one requires the caller to
 * explicitly construct and pass in a Supabase client (always a service-role
 * client in practice), rather than defaulting to one internally the way
 * the user-facing functions do. That makes misuse from ordinary
 * application code structurally deliberate, not an accidental flag flip —
 * the same pattern already used for Vault access. The user-facing
 * functions below are completely unchanged: same assertEditor() gate, same
 * RLS-scoped client, same public signature. Authorization for the "AsSystem"
 * path is not RLS/assertEditor at all — it is that these functions are only
 * ever reachable from publication-scheduler.ts, which itself is only ever
 * invoked by a Netlify Scheduled Function (server-side, no client/browser
 * entry point). Business-rule enforcement (approval gate, lifecycle gate)
 * remains in the database triggers regardless of which path is used —
 * unchanged and un-bypassable by either.
 */
async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to manage publications in this workspace");
  }
}

async function updatePublicationRow(
  client: SupabaseClient<Database>,
  workspaceId: string,
  publicationId: string,
  fields: Database["public"]["Tables"]["publications"]["Update"],
): Promise<Publication> {
  const { data, error } = await client
    .from("publications")
    .update(fields)
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update publication: ${error.message}`);
  }
  return data;
}

export async function listPublicationsForWorkspace(workspaceId: string): Promise<Publication[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("publications")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list publications: ${error.message}`);
  }
  return data ?? [];
}

/**
 * The exact status set MVP-2.5 (Calendar) locks: a publication only has a
 * calendar position once it has passed through scheduling, so draft/
 * approved (which normally carry a NULL scheduled_at) are excluded by
 * design — not merely by the range filter below, but as a deliberate
 * product decision (approved MVP-2.5 scope). This is display scope only;
 * it does not change the publication_status enum, lifecycle triggers, or
 * approval/cancellation rules.
 *
 * Defined in src/components/calendar/types.ts (a plain, guard-free file)
 * rather than here, and re-exported below for convenience — client
 * calendar components need this exact runtime array to render filter
 * options, and importing any runtime value from this server-only-guarded
 * module would poison the client bundle even for an unrelated export
 * (confirmed by `npm run build` before this fix). See that file's comment
 * for the full reasoning. Calendar UI code imports the constant from
 * @/components/calendar/types directly, never from here.
 */
export { CALENDAR_PUBLICATION_STATUSES, type CalendarPublicationStatus };

export type ListPublicationsForCalendarFilters = {
  /** Inclusive ISO instant — half-open range [start, end). */
  start: string;
  /** Exclusive ISO instant — half-open range [start, end). */
  end: string;
  /** Defaults to the full CALENDAR_PUBLICATION_STATUSES set; never widened beyond it. */
  statuses?: CalendarPublicationStatus[];
};

/**
 * Publications with a calendar position in [start, end), i.e. Database
 * Architecture §18's (workspace_id, scheduled_at) index applied as a
 * half-open range query. `scheduled_at IS NULL` rows (draft/approved) are
 * excluded naturally — a NULL never satisfies `>= start` — with no
 * separate NULL check needed. Returns plain Publication rows only, per
 * the established convention (content/variant/account context is merged
 * by the caller — see src/app/w/[slug]/calendar/page.tsx — mirroring
 * listContentForWorkspace/listLinkedAssets' separate-query pattern rather
 * than introducing a new joined-fetch abstraction here).
 */
export async function listPublicationsForCalendar(
  workspaceId: string,
  filters: ListPublicationsForCalendarFilters,
): Promise<Publication[]> {
  const supabase = await createClient();

  const statuses =
    filters.statuses && filters.statuses.length > 0
      ? filters.statuses.filter((status) => (CALENDAR_PUBLICATION_STATUSES as readonly string[]).includes(status))
      : [...CALENDAR_PUBLICATION_STATUSES];

  const { data, error } = await supabase
    .from("publications")
    .select("*")
    .eq("workspace_id", workspaceId)
    .gte("scheduled_at", filters.start)
    .lt("scheduled_at", filters.end)
    .in("status", statuses)
    .order("scheduled_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list publications for calendar: ${error.message}`);
  }
  return data ?? [];
}

/**
 * MVP-2.2 explicit decision (Database Architecture §17 does not specify
 * how content_approvals' append-only history resolves when multiple
 * decisions exist for the same content_version_id): the LATEST decision
 * (by created_at) wins. A bare `EXISTS(status = 'approved')` check would
 * incorrectly leave a stale approval valid after a later
 * changes_requested/rejected decision — deliberately not used here. This
 * mirrors the database trigger `enforce_publication_approval_gate()`
 * (20260916140000_publications.sql) exactly; this function is the
 * server-side half of the required two-layer enforcement (Database
 * Architecture §17: "both layers required, not either/or"), not a
 * replacement for the trigger.
 */
async function latestApprovalStatusForContentVersion(
  contentVersionId: string,
): Promise<ContentApprovalStatus | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_approvals")
    .select("status")
    .eq("content_version_id", contentVersionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to resolve latest approval decision: ${error.message}`);
  }
  return data?.status ?? null;
}

export type CreatePublicationInput = {
  contentVariantId: string;
  socialAccountId: string;
};

/**
 * Creates a publication at status='draft'. Both the content variant and
 * the social account are explicitly verified to belong to `workspaceId`
 * before insert — this is a defense-in-depth check on top of the
 * database's composite tenant FKs (publications_variant_workspace_fkey /
 * publications_account_workspace_fkey), which remain the final,
 * authoritative isolation boundary regardless of this check.
 *
 * idempotency_key is required (Database Architecture §8) and is
 * application-generated via crypto.randomUUID() — never a deterministic
 * hash (approved MVP-2.2 decision).
 */
export async function createPublication(workspaceId: string, input: CreatePublicationInput): Promise<Publication> {
  await assertEditor(workspaceId);

  const supabase = await createClient();

  const { data: variant, error: variantError } = await supabase
    .from("content_variants")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", input.contentVariantId)
    .maybeSingle();
  if (variantError) {
    throw new Error(`Failed to verify content variant: ${variantError.message}`);
  }
  if (!variant) {
    throw new Error("Content variant not found in this workspace");
  }

  const { data: account, error: accountError } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", input.socialAccountId)
    .maybeSingle();
  if (accountError) {
    throw new Error(`Failed to verify social account: ${accountError.message}`);
  }
  if (!account) {
    throw new Error("Social account not found in this workspace");
  }

  const { data, error } = await supabase
    .from("publications")
    .insert({
      workspace_id: workspaceId,
      content_variant_id: input.contentVariantId,
      social_account_id: input.socialAccountId,
      idempotency_key: crypto.randomUUID(),
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create publication: ${error.message}`);
  }
  return data;
}

/**
 * MVP-5.35B scheduling guard (service-layer parity with the
 * enforce_publication_scheduling_transitions trigger): a publication may
 * (re-)enter 'scheduled' only from draft, approved, scheduled
 * (reschedule), or failed when the failed attempt's remote outcome is
 * certain. Never from published/publishing/cancelled — re-executing those
 * could post the same content twice (MVP-5.35A hazard H2).
 */
export const PUBLISH_OUTCOME_UNKNOWN_ERROR_CODE = "publish_outcome_unknown";

function assertSchedulable(publication: Pick<Publication, "id" | "status" | "error_code">) {
  if (publication.status === "draft" || publication.status === "approved" || publication.status === "scheduled") {
    return;
  }
  if (publication.status === "failed") {
    if (publication.error_code === PUBLISH_OUTCOME_UNKNOWN_ERROR_CODE) {
      throw new Error(
        "This publication's previous publish outcome is unknown and must be reconciled before it can be rescheduled",
      );
    }
    return;
  }
  throw new Error(`A publication with status '${publication.status}' cannot be scheduled`);
}

/**
 * Transitions a publication to 'scheduled'. Performs the same
 * latest-approval-wins check the database trigger enforces
 * (defense-in-depth — Database Architecture §17 requires both layers);
 * the trigger remains authoritative even if this check is somehow
 * bypassed or made inconsistent with it in the future. The same applies to
 * the MVP-5.35B source-state guard (assertSchedulable / open attempts).
 */
export async function schedulePublication(
  workspaceId: string,
  publicationId: string,
  scheduledAt: string,
): Promise<Publication> {
  await assertEditor(workspaceId);

  const supabase = await createClient();

  const { data: publication, error: fetchError } = await supabase
    .from("publications")
    .select("id, content_variant_id, status, error_code")
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .maybeSingle();
  if (fetchError) {
    throw new Error(`Failed to load publication: ${fetchError.message}`);
  }
  if (!publication) {
    throw new Error("Publication not found in this workspace");
  }

  assertSchedulable(publication);

  const { count: openAttempts, error: attemptsError } = await supabase
    .from("publication_attempts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("publication_id", publicationId)
    .is("completed_at", null);
  if (attemptsError) {
    throw new Error(`Failed to check publish attempts: ${attemptsError.message}`);
  }
  if (openAttempts) {
    throw new Error("This publication has a publish attempt still in progress and cannot be rescheduled");
  }

  const { data: variant, error: variantError } = await supabase
    .from("content_variants")
    .select("content_version_id")
    .eq("workspace_id", workspaceId)
    .eq("id", publication.content_variant_id)
    .maybeSingle();
  if (variantError) {
    throw new Error(`Failed to resolve content version: ${variantError.message}`);
  }
  if (!variant) {
    throw new Error("Content variant for this publication no longer resolves to a content version");
  }

  const latestStatus = await latestApprovalStatusForContentVersion(variant.content_version_id);
  if (latestStatus !== "approved") {
    throw new Error(
      "This publication's content version does not have an approved latest approval decision and cannot be scheduled",
    );
  }

  const { data, error } = await supabase
    .from("publications")
    .update({ status: "scheduled", scheduled_at: scheduledAt })
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to schedule publication: ${error.message}`);
  }
  return data;
}

const CANCELLABLE_STATUSES = ["draft", "approved", "scheduled"] as const;

/**
 * Cancels a publication from a pre-publication state only (draft,
 * approved, scheduled — approved MVP-2.2 decision, Q3). Never deletes the
 * row (Database Architecture §19 — publications are historical records
 * and are never hard-deleted under any circumstance).
 */
export async function cancelPublication(workspaceId: string, publicationId: string): Promise<Publication> {
  await assertEditor(workspaceId);

  const supabase = await createClient();

  const { data: publication, error: fetchError } = await supabase
    .from("publications")
    .select("status")
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .maybeSingle();
  if (fetchError) {
    throw new Error(`Failed to load publication: ${fetchError.message}`);
  }
  if (!publication) {
    throw new Error("Publication not found in this workspace");
  }
  if (!CANCELLABLE_STATUSES.includes(publication.status as (typeof CANCELLABLE_STATUSES)[number])) {
    throw new Error(`A publication with status '${publication.status}' cannot be cancelled`);
  }

  const { data, error } = await supabase
    .from("publications")
    .update({ status: "cancelled" })
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to cancel publication: ${error.message}`);
  }
  return data;
}

/**
 * Transitions a publication to 'publishing'. Only scheduled → publishing
 * is allowed — enforced by enforce_publication_lifecycle_transitions, not
 * duplicated here (see module header comment).
 */
export async function markPublishing(workspaceId: string, publicationId: string): Promise<Publication> {
  await assertEditor(workspaceId);
  return updatePublicationRow(await createClient(), workspaceId, publicationId, { status: "publishing" });
}

/**
 * Trusted-system counterpart of markPublishing — see module header
 * comment. `client` must be a service-role client constructed by the
 * caller; there is no internal fallback to createClient() here.
 *
 * Not currently called by executePublicationAsSystem: the scheduled-
 * execution path's claim_due_publications RPC already performs the
 * scheduled -> publishing transition atomically as part of claiming a
 * row (20260916180000_publication_scheduler_claim.sql), so
 * executePublicationAsSystem starts from an already-'publishing' row and
 * skips this step to avoid a rejected publishing -> publishing double
 * transition. Kept exported for API symmetry with markPublishedAsSystem/
 * markFailedAsSystem and for any future trusted-system caller that needs
 * to perform this specific transition directly.
 */
export async function markPublishingAsSystem(
  client: SupabaseClient<Database>,
  workspaceId: string,
  publicationId: string,
): Promise<Publication> {
  return updatePublicationRow(client, workspaceId, publicationId, { status: "publishing" });
}

export type MarkPublishedInput = {
  externalPublicationId: string;
  externalUrl: string | null;
  providerResponse: Record<string, unknown>;
};

/**
 * Transitions a publication to 'published'. Only publishing → published is
 * allowed — enforced by enforce_publication_lifecycle_transitions.
 */
function publishedFields(result: MarkPublishedInput): Database["public"]["Tables"]["publications"]["Update"] {
  return {
    status: "published",
    published_at: new Date().toISOString(),
    external_publication_id: result.externalPublicationId,
    external_url: result.externalUrl,
    provider_response: result.providerResponse,
  };
}

export async function markPublished(
  workspaceId: string,
  publicationId: string,
  result: MarkPublishedInput,
): Promise<Publication> {
  await assertEditor(workspaceId);
  return updatePublicationRow(await createClient(), workspaceId, publicationId, publishedFields(result));
}

/** Trusted-system counterpart of markPublished — see module header comment. */
export async function markPublishedAsSystem(
  client: SupabaseClient<Database>,
  workspaceId: string,
  publicationId: string,
  result: MarkPublishedInput,
): Promise<Publication> {
  return updatePublicationRow(client, workspaceId, publicationId, publishedFields(result));
}

export type MarkFailedInput = {
  errorCode: string;
  errorMessage: string;
  providerResponse?: Record<string, unknown>;
};

/**
 * Transitions a publication to 'failed'. Only publishing → failed is
 * allowed — enforced by enforce_publication_lifecycle_transitions.
 */
function failedFields(failure: MarkFailedInput): Database["public"]["Tables"]["publications"]["Update"] {
  return {
    status: "failed",
    error_code: failure.errorCode,
    error_message: failure.errorMessage,
    provider_response: failure.providerResponse ?? {},
  };
}

/**
 * MVP-2.6 side effect of a successful failed-transition: create a
 * `publication_failed` notification for the publication's creator. Called
 * only after updatePublicationRow has already committed the transition, so
 * a rejected/duplicate transition (e.g. failed → failed, rejected by
 * enforce_publication_lifecycle_transitions before this point is ever
 * reached) can never produce a duplicate notification. Deliberately does
 * not propagate a notification-write failure: the failed-transition itself
 * — the source of truth — has already succeeded by the time this runs, and
 * a side effect must not be allowed to make that outcome look like it
 * failed. Errors are swallowed and logged, not rethrown.
 */
async function notifyFailureSideEffect(publication: Publication, failure: MarkFailedInput): Promise<void> {
  try {
    await notifyPublicationFailed({
      workspaceId: publication.workspace_id,
      publicationId: publication.id,
      recipientUserId: publication.created_by,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    });
  } catch (err) {
    console.error(`Failed to create publication_failed notification for publication ${publication.id}:`, err);
  }
}

export async function markFailed(
  workspaceId: string,
  publicationId: string,
  failure: MarkFailedInput,
): Promise<Publication> {
  await assertEditor(workspaceId);
  const publication = await updatePublicationRow(await createClient(), workspaceId, publicationId, failedFields(failure));
  await notifyFailureSideEffect(publication, failure);
  return publication;
}

/** Trusted-system counterpart of markFailed — see module header comment. */
export async function markFailedAsSystem(
  client: SupabaseClient<Database>,
  workspaceId: string,
  publicationId: string,
  failure: MarkFailedInput,
): Promise<Publication> {
  const publication = await updatePublicationRow(client, workspaceId, publicationId, failedFields(failure));
  await notifyFailureSideEffect(publication, failure);
  return publication;
}
