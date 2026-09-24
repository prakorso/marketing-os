import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { insertPublicationFailedNotification } from "@/server/services/publication-transitions";
import type { Notification } from "@/types/database";

/**
 * MVP-2.6 Notifications — narrowly scoped: create-on-publication-failure,
 * list-own, mark-own-read. No generic notification framework, no other
 * producer, no UI. The sole integration point is
 * src/server/services/publications.ts's markFailed/markFailedAsSystem.
 *
 * notifyPublicationFailed writes through the service-role client, narrowly,
 * for this one insert only — never as a general-purpose substitute for the
 * RLS-scoped client. This mirrors the existing precedent in this codebase
 * (publication-execution.ts's Vault credential read, and
 * executePublicationAsSystem's business-table access) of reaching for
 * createServiceRoleClient() for one specific, deliberate operation
 * alongside an otherwise RLS-scoped flow. It is required here because
 * `notifications` has no `authenticated` INSERT policy by design (MVP-2.6
 * approved decision) — notifications are created only by trusted
 * server-side code, never by a direct client-attributable write, for
 * either the user-triggered or the scheduler/system failure path.
 *
 * listNotificationsForUser and markNotificationRead use the normal
 * RLS-scoped client: both operate on the calling user's own authenticated
 * session, and RLS (notifications_select_own / notifications_update_own)
 * is the authoritative boundary — workspace membership AND
 * user_id = auth.uid() — not application code.
 */

export type NotifyPublicationFailedInput = {
  workspaceId: string;
  publicationId: string;
  /** publications.created_by at the moment of failure. Never fabricated. */
  recipientUserId: string | null;
  errorCode: string;
  errorMessage: string;
};

/**
 * Creates exactly one `publication_failed` notification addressed to
 * `publications.created_by`. If `recipientUserId` is null (the publication
 * has no recorded creator), no notification is created and no recipient is
 * fabricated (MVP-2.6 approved Recipient Resolution). This is not an error
 * condition — a publication failing is valid regardless of whether there is
 * anyone to notify.
 *
 * `data` carries only safe, non-secret references (publication id, error
 * code) — never provider credentials, Vault secrets, tokens, idempotency
 * keys, or raw provider_response.
 */
export async function notifyPublicationFailed(input: NotifyPublicationFailedInput): Promise<Notification | null> {
  return insertPublicationFailedNotification(createServiceRoleClient(), input);
}

/**
 * Returns the authenticated user's own notifications in this workspace,
 * newest first. RLS (notifications_select_own) is the authoritative
 * boundary: workspace membership AND user_id = auth.uid(). No pagination —
 * not required by approved MVP-2.6 scope.
 */
export async function listNotificationsForUser(workspaceId: string): Promise<Notification[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list notifications: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Marks one of the authenticated user's own notifications as read. Only
 * `read_at` is ever written by this function — RLS
 * (notifications_update_own) additionally enforces workspace membership
 * AND user_id = auth.uid(), so this cannot touch another user's row even
 * if a caller supplied a foreign notificationId; such a call matches zero
 * rows and surfaces as an error below, not a silent no-op.
 */
export async function markNotificationRead(workspaceId: string, notificationId: string): Promise<Notification> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", notificationId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to mark notification as read: ${error.message}`);
  }
  return data;
}
