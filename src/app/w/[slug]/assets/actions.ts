"use server";

import { redirect } from "next/navigation";

import { setAssetArchived, uploadAsset } from "@/server/services/assets";
import { getWorkspaceBySlug } from "@/server/services/workspaces";

/**
 * Every action re-resolves workspace_id from the slug via getWorkspaceBySlug
 * (RLS-scoped to the current user's membership) rather than trusting a
 * workspace_id posted from the client — the slug is a lookup key, not an
 * authorization mechanism (Engineering Blueprint §8).
 */
async function resolveWorkspaceOrThrow(slug: string) {
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new Error("Workspace not found or not accessible");
  }
  return workspace;
}

export async function uploadAssetAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Please choose a file to upload");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await uploadAsset(workspace.id, file);

  redirect(`/w/${slug}/assets`);
}

export async function setAssetArchivedAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const assetId = String(formData.get("asset_id") ?? "");
  const archived = String(formData.get("archived") ?? "") === "true";

  const workspace = await resolveWorkspaceOrThrow(slug);
  await setAssetArchived(workspace.id, assetId, archived);

  redirect(`/w/${slug}/assets/${assetId}`);
}
