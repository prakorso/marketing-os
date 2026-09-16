import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { ProviderError } from "@/lib/social/provider";
import { resolveProviderAdapter } from "@/lib/social/registry";
import { markFailed, markPublished, markPublishing } from "@/server/services/publications";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { Publication } from "@/types/database";

/**
 * MVP-2.3 Provider Execution — the execution *contract* only (Engineering
 * Blueprint §22): given a publication that is already 'scheduled', resolve
 * its credential, call the platform's (mock, this phase) provider adapter,
 * and mark the outcome. Nothing in this module schedules, queues, or
 * retries anything — something else (a manual trigger today, later
 * whatever scheduling mechanism a future phase introduces) must call
 * executePublication() once per publication it wants executed.
 *
 * Authorization matches every other publications operation: workspace
 * editor (owner/admin/marketer), not admin-only (MVP-2.3 decision).
 *
 * Service-role usage is narrowly scoped to exactly one call — resolving
 * the social account's Vault secret — never for reading/writing
 * publications, content_variants, or social_accounts themselves, which
 * all go through the normal RLS-scoped client and remain subject to
 * workspace-editor RLS and the composite tenant FKs.
 *
 * The resolved credential lives only in this function's local scope for
 * the duration of the adapter call. It is never returned, logged, or
 * included in any thrown error — only ProviderError's normalized
 * code/message/providerResponse (none of which ever contain the raw
 * credential) cross back out of this function.
 */
async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to execute publications in this workspace");
  }
}

export async function executePublication(workspaceId: string, publicationId: string): Promise<Publication> {
  await assertEditor(workspaceId);

  const supabase = await createClient();

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
  if (publication.status !== "scheduled") {
    throw new Error(
      `Publication ${publicationId} cannot be executed from status '${publication.status}' — only a 'scheduled' publication can be executed`,
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

  await markPublishing(workspaceId, publicationId);

  const adapter = resolveProviderAdapter(socialAccount.platform);

  try {
    const result = await adapter.publish({
      credential,
      idempotencyKey: publication.idempotency_key,
      variant,
      socialAccount,
    });
    return await markPublished(workspaceId, publicationId, result);
  } catch (err) {
    const providerError =
      err instanceof ProviderError
        ? err
        : new ProviderError(err instanceof Error ? err.message : "Unknown provider error", "unknown");
    return await markFailed(workspaceId, publicationId, {
      errorCode: providerError.code,
      errorMessage: providerError.message,
      providerResponse: providerError.providerResponse,
    });
  }
}
