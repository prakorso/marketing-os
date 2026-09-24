"use server";

import { redirect } from "next/navigation";

import { cancelPublication, schedulePublication } from "@/server/services/publications";
import { getWorkspaceBySlug } from "@/server/services/workspaces";

/**
 * Every action re-resolves workspace_id from the slug via getWorkspaceBySlug
 * (RLS-scoped to the current user's membership) rather than trusting a
 * workspace_id posted from the client (Engineering Blueprint §8) — the
 * same pattern used by every other actions.ts in this app.
 *
 * Both actions are thin wrappers: all business rules (approval gate,
 * allowed source states, editor authorization) remain enforced entirely
 * inside schedulePublication()/cancelPublication() and the database
 * triggers — nothing here performs a direct `publications` update or
 * duplicates any rule.
 */
async function resolveWorkspaceOrThrow(slug: string) {
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new Error("Workspace not found or not accessible");
  }
  return workspace;
}

function calendarRedirectPath(formData: FormData): string {
  const slug = String(formData.get("slug") ?? "");
  const year = String(formData.get("year") ?? "");
  const month = String(formData.get("month") ?? "");
  const status = String(formData.get("status") ?? "");

  const params = new URLSearchParams();
  if (year) params.set("year", year);
  if (month) params.set("month", month);
  if (status) params.set("status", status);

  const query = params.toString();
  return `/w/${slug}/calendar${query ? `?${query}` : ""}`;
}

export async function reschedulePublicationAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const publicationId = String(formData.get("publication_id") ?? "");
  const newScheduledAt = String(formData.get("scheduled_at") ?? "");

  if (!publicationId || !newScheduledAt) {
    throw new Error("A publication and a new scheduled time are required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await schedulePublication(workspace.id, publicationId, new Date(newScheduledAt).toISOString());

  redirect(calendarRedirectPath(formData));
}

export async function cancelPublicationAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const publicationId = String(formData.get("publication_id") ?? "");

  if (!publicationId) {
    throw new Error("A publication is required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await cancelPublication(workspace.id, publicationId);

  redirect(calendarRedirectPath(formData));
}
