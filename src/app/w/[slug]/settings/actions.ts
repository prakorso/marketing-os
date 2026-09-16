"use server";

import { redirect } from "next/navigation";

import { connectSocialAccount, disconnectSocialAccount } from "@/server/services/social-accounts";
import { getWorkspaceBySlug } from "@/server/services/workspaces";
import type { SocialPlatform } from "@/types/database";

const SOCIAL_PLATFORMS: SocialPlatform[] = ["instagram", "tiktok", "youtube", "threads"];

/**
 * Every action re-resolves workspace_id from the slug via getWorkspaceBySlug
 * (RLS-scoped to the current user's membership) rather than trusting a
 * workspace_id posted from the client (Engineering Blueprint §8).
 */
async function resolveWorkspaceOrThrow(slug: string) {
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new Error("Workspace not found or not accessible");
  }
  return workspace;
}

export async function connectSocialAccountAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const platform = String(formData.get("platform") ?? "") as SocialPlatform;
  const externalAccountId = String(formData.get("external_account_id") ?? "").trim();
  const accountName = String(formData.get("account_name") ?? "").trim();
  const accountHandle = String(formData.get("account_handle") ?? "").trim();
  const credential = String(formData.get("credential") ?? "");

  if (!SOCIAL_PLATFORMS.includes(platform)) {
    throw new Error("Please choose a valid platform");
  }
  if (!externalAccountId || !accountName) {
    throw new Error("Account ID and account name are required");
  }
  if (!credential) {
    throw new Error("A credential value is required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await connectSocialAccount(workspace.id, {
    platform,
    externalAccountId,
    accountName,
    accountHandle: accountHandle || undefined,
    credential,
  });

  redirect(`/w/${slug}/settings`);
}

export async function disconnectSocialAccountAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const accountId = String(formData.get("account_id") ?? "");

  const workspace = await resolveWorkspaceOrThrow(slug);
  await disconnectSocialAccount(workspace.id, accountId);

  redirect(`/w/${slug}/settings`);
}
