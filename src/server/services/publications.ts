import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { ContentApprovalStatus, Publication } from "@/types/database";

/**
 * MVP-2.2 scope: business-row lifecycle only (draft → approved → scheduled
 * → cancelled). No provider adapters, no OAuth, no Vault access, no
 * publishing/publishing-failure transitions — those belong to a future
 * provider-adapter/worker milestone that doesn't exist yet, so
 * markPublishing/markPublished/markFailed/retryPublication are
 * intentionally not implemented here (Engineering Blueprint §22 frames
 * actual provider execution as background/job-worker work).
 *
 * Uses only the normal RLS-scoped Supabase client (src/lib/supabase/server.ts)
 * — publications carry no credentials, so there is no reason to reach for
 * the service-role client anywhere in this module (contrast with
 * social-accounts.ts, where Vault access genuinely requires it).
 */
async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to manage publications in this workspace");
  }
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
 * Transitions a publication to 'scheduled'. Performs the same
 * latest-approval-wins check the database trigger enforces
 * (defense-in-depth — Database Architecture §17 requires both layers);
 * the trigger remains authoritative even if this check is somehow
 * bypassed or made inconsistent with it in the future.
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
    .select("id, content_variant_id")
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .maybeSingle();
  if (fetchError) {
    throw new Error(`Failed to load publication: ${fetchError.message}`);
  }
  if (!publication) {
    throw new Error("Publication not found in this workspace");
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
