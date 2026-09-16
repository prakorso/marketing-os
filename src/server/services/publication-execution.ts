import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { ProviderError } from "@/lib/social/provider";
import { resolveProviderAdapter } from "@/lib/social/registry";
import {
  markFailed,
  markFailedAsSystem,
  markPublished,
  markPublishedAsSystem,
  markPublishing,
} from "@/server/services/publications";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { Database, Publication } from "@/types/database";

/**
 * MVP-2.3 Provider Execution — the execution *contract* only (Engineering
 * Blueprint §22): given a publication that is already 'scheduled', resolve
 * its credential, call the platform's (mock, this phase) provider adapter,
 * and mark the outcome.
 *
 * Authorization for the user-facing executePublication matches every other
 * publications operation: workspace editor (owner/admin/marketer), not
 * admin-only (MVP-2.3 decision) — unchanged by MVP-2.4.
 *
 * MVP-2.4 adds executePublicationAsSystem for the trusted, unattended
 * scheduler path (src/server/services/publication-scheduler.ts), which has
 * no end-user session and cannot satisfy assertEditor(). Both entry points
 * share one private implementation (runExecution) parameterized only by
 * which Supabase client and which publications.ts mark* functions to use —
 * there is no boolean/flag that weakens or bypasses assertEditor() for the
 * user-facing path, and executePublicationAsSystem is never exported to,
 * or reachable from, any Server Action, API route, or client component; it
 * is called only from publication-scheduler.ts, which is itself only ever
 * invoked by a Netlify Scheduled Function (server-side, no browser entry
 * point). Both entry points call the SAME database as their final
 * business-rule authority — enforce_publication_approval_gate and
 * enforce_publication_lifecycle_transitions fire regardless of which
 * client performs the update.
 *
 * Service-role usage is narrowly scoped: the one Vault-read RPC call
 * (both entry points) plus, for executePublicationAsSystem only, the
 * publications/content_variants/social_accounts reads and the mark*
 * writes — there being no authenticated user for RLS to scope those to in
 * the unattended path. executePublication (user-facing) is unchanged: RLS-
 * scoped client throughout, never service-role for anything but Vault.
 *
 * The resolved credential lives only in runExecution's local scope for the
 * duration of the adapter call. It is never returned, logged, or included
 * in any thrown error — only ProviderError's normalized code/message/
 * providerResponse (none of which ever contain the raw credential) cross
 * back out of this function.
 */
async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to execute publications in this workspace");
  }
}

type MarkPublishingFn = (workspaceId: string, publicationId: string) => Promise<Publication>;
type MarkPublishedFn = (
  workspaceId: string,
  publicationId: string,
  result: Parameters<typeof markPublished>[2],
) => Promise<Publication>;
type MarkFailedFn = (
  workspaceId: string,
  publicationId: string,
  failure: Parameters<typeof markFailed>[2],
) => Promise<Publication>;

async function runExecution(
  client: SupabaseClient<Database>,
  workspaceId: string,
  publicationId: string,
  requiredStatus: "scheduled" | "publishing",
  markPublishingFn: MarkPublishingFn | null,
  markPublishedFn: MarkPublishedFn,
  markFailedFn: MarkFailedFn,
): Promise<Publication> {
  const supabase = client;

  const { data: publication, error: publicationError } = await supabase
    .from("publications")
    .select("id, content_variant_id, social_account_id, idempotency_key, status")
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .maybeSingle();
  if (publicationError) {
    throw new Error(`Failed to load publication: ${publicationError.message}`);
  }
  if (!publication) {
    throw new Error("Publication not found in this workspace");
  }
  if (publication.status !== requiredStatus) {
    throw new Error(
      `Publication ${publicationId} cannot be executed from status '${publication.status}' — expected '${requiredStatus}'`,
    );
  }

  const { data: variant, error: variantError } = await supabase
    .from("content_variants")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", publication.content_variant_id)
    .maybeSingle();
  if (variantError) {
    throw new Error(`Failed to load content variant: ${variantError.message}`);
  }
  if (!variant) {
    throw new Error("Content variant for this publication no longer resolves in this workspace");
  }

  const { data: socialAccount, error: accountError } = await supabase
    .from("social_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", publication.social_account_id)
    .maybeSingle();
  if (accountError) {
    throw new Error(`Failed to load social account: ${accountError.message}`);
  }
  if (!socialAccount) {
    throw new Error("Social account for this publication no longer resolves in this workspace");
  }
  if (!socialAccount.vault_secret_id) {
    throw new Error("Social account has no stored credential to resolve (it may be disconnected)");
  }

  const vault = createServiceRoleClient();
  const { data: credential, error: credentialError } = await vault.rpc("read_social_account_vault_secret", {
    p_secret_id: socialAccount.vault_secret_id,
  });
  if (credentialError || !credential) {
    throw new Error(`Failed to resolve social account credential: ${credentialError?.message ?? "not found"}`);
  }

  if (markPublishingFn) {
    await markPublishingFn(workspaceId, publicationId);
  }

  const adapter = resolveProviderAdapter(socialAccount.platform);

  try {
    const result = await adapter.publish({
      credential,
      idempotencyKey: publication.idempotency_key,
      variant,
      socialAccount,
    });
    return await markPublishedFn(workspaceId, publicationId, result);
  } catch (err) {
    const providerError =
      err instanceof ProviderError
        ? err
        : new ProviderError(err instanceof Error ? err.message : "Unknown provider error", "unknown");
    return await markFailedFn(workspaceId, publicationId, {
      errorCode: providerError.code,
      errorMessage: providerError.message,
      providerResponse: providerError.providerResponse,
    });
  }
}

/**
 * User-facing execution: editor-gated, RLS-scoped client throughout
 * (unchanged from MVP-2.3). Expects a 'scheduled' publication and performs
 * the scheduled -> publishing transition itself via markPublishing.
 */
export async function executePublication(workspaceId: string, publicationId: string): Promise<Publication> {
  await assertEditor(workspaceId);
  const client = await createClient();
  return runExecution(client, workspaceId, publicationId, "scheduled", markPublishing, markPublished, markFailed);
}

/**
 * Trusted-system execution for the unattended scheduler
 * (publication-scheduler.ts) only. No assertEditor() call — there is no
 * end-user session to check — and no RLS-scoped client. workspaceId and
 * publicationId must come only from the scheduler's own database claim
 * (claim_due_publications), never from browser/user input; this function
 * has no way to enforce that itself, which is exactly why it is not
 * exported for use anywhere else in the application.
 *
 * Expects a 'publishing' publication, not 'scheduled': claim_due_publications
 * already performs the scheduled -> publishing transition atomically as
 * part of the claim itself (that is the whole point of the claim — mark
 * the row as being worked on before this function ever runs). Re-attempting
 * that transition here would be a publishing -> publishing double
 * invocation, which enforce_publication_lifecycle_transitions correctly
 * rejects — so markPublishingFn is passed as null and skipped entirely.
 */
export async function executePublicationAsSystem(workspaceId: string, publicationId: string): Promise<Publication> {
  const client = createServiceRoleClient();
  return runExecution(
    client,
    workspaceId,
    publicationId,
    "publishing",
    null,
    (wsId, pubId, result) => markPublishedAsSystem(client, wsId, pubId, result),
    (wsId, pubId, failure) => markFailedAsSystem(client, wsId, pubId, failure),
  );
}
