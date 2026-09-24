import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Notification, Publication } from "@/types/database";

/**
 * MVP-5.36 — publication lifecycle writes with an INJECTED client, split out
 * of publications.ts without `server-only` so the Level-6 scheduled-function
 * runtime can bundle them (MVP-5.36A §4). Nothing here reads the
 * environment, Vault, or any secret: the caller supplies the client.
 * publications.ts re-exports the system transitions for existing importers;
 * its user-facing (RLS-scoped, editor-gated) functions are unchanged.
 *
 * The database remains the authority: enforce_publication_lifecycle_transitions
 * and the approval gate fire regardless of which client performs the update.
 */

export async function updatePublicationRow(
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

export type MarkPublishedInput = {
  externalPublicationId: string;
  externalUrl: string | null;
  providerResponse: Record<string, unknown>;
};

/**
 * Transitions a publication to 'published'. Only publishing → published is
 * allowed — enforced by enforce_publication_lifecycle_transitions.
 */
export function publishedFields(result: MarkPublishedInput): Database["public"]["Tables"]["publications"]["Update"] {
  return {
    status: "published",
    published_at: new Date().toISOString(),
    external_publication_id: result.externalPublicationId,
    external_url: result.externalUrl,
    provider_response: result.providerResponse,
  };
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
export function failedFields(failure: MarkFailedInput): Database["public"]["Tables"]["publications"]["Update"] {
  return {
    status: "failed",
    error_code: failure.errorCode,
    error_message: failure.errorMessage,
    provider_response: failure.providerResponse ?? {},
  };
}

export type PublicationFailedNotificationInput = {
  workspaceId: string;
  publicationId: string;
  /** publications.created_by at the moment of failure. Never fabricated. */
  recipientUserId: string | null;
  errorCode: string;
  errorMessage: string;
};

/**
 * Inserts exactly one `publication_failed` notification (MVP-2.6) using the
 * given trusted (service-role) client; no row when there is no recipient.
 */
export async function insertPublicationFailedNotification(
  client: SupabaseClient<Database>,
  input: PublicationFailedNotificationInput,
): Promise<Notification | null> {
  if (!input.recipientUserId) {
    return null;
  }
  const { data, error } = await client
    .from("notifications")
    .insert({
      workspace_id: input.workspaceId,
      user_id: input.recipientUserId,
      type: "publication_failed",
      title: "Publication failed",
      message: `Your publication failed to send: ${input.errorMessage}`,
      data: {
        publication_id: input.publicationId,
        error_code: input.errorCode,
      },
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create publication-failed notification: ${error.message}`);
  }
  return data;
}

/** Trusted-system publishing → published (no end-user session). */
export async function markPublishedAsSystem(
  client: SupabaseClient<Database>,
  workspaceId: string,
  publicationId: string,
  result: MarkPublishedInput,
): Promise<Publication> {
  return updatePublicationRow(client, workspaceId, publicationId, publishedFields(result));
}

/**
 * Trusted-system publishing → failed, then the MVP-2.6 failure notification
 * through the same trusted client. The notification is a side effect: its
 * failure is logged and never makes the committed transition look failed.
 */
export async function markFailedAsSystem(
  client: SupabaseClient<Database>,
  workspaceId: string,
  publicationId: string,
  failure: MarkFailedInput,
): Promise<Publication> {
  const publication = await updatePublicationRow(client, workspaceId, publicationId, failedFields(failure));
  try {
    await insertPublicationFailedNotification(client, {
      workspaceId: publication.workspace_id,
      publicationId: publication.id,
      recipientUserId: publication.created_by,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    });
  } catch (err) {
    console.error(`Failed to create publication_failed notification for publication ${publication.id}:`, err);
  }
  return publication;
}
