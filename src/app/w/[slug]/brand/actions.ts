"use server";

import { redirect } from "next/navigation";

import {
  createAudienceProfile,
  createBrand,
  createContentPillar,
  setBrandStatus,
  updateBrand,
  updateBrandVoice,
} from "@/server/services/brands";
import { getWorkspaceBySlug } from "@/server/services/workspaces";

/**
 * Every action re-resolves workspace_id from the slug via getWorkspaceBySlug
 * (RLS-scoped to the current user's membership) rather than trusting a
 * workspace_id posted from the client — the slug is just a lookup key, not
 * an authorization mechanism; RLS on the underlying tables is what actually
 * enforces tenant isolation for the write itself (Engineering Blueprint §8).
 */
async function resolveWorkspaceOrThrow(slug: string) {
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new Error("Workspace not found or not accessible");
  }
  return workspace;
}

export async function createBrandAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    throw new Error("Brand name is required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  const brand = await createBrand(workspace.id, {
    name,
    description: String(formData.get("description") ?? "").trim(),
    websiteUrl: String(formData.get("website_url") ?? "").trim(),
  });

  redirect(`/w/${slug}/brand/${brand.id}`);
}

export async function updateBrandAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    throw new Error("Brand name is required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await updateBrand(workspace.id, brandId, {
    name,
    description: String(formData.get("description") ?? "").trim(),
    websiteUrl: String(formData.get("website_url") ?? "").trim(),
  });

  redirect(`/w/${slug}/brand/${brandId}`);
}

export async function setBrandStatusAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "active" && status !== "archived") {
    throw new Error("Invalid brand status");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await setBrandStatus(workspace.id, brandId, status);

  redirect(`/w/${slug}/brand/${brandId}`);
}

export async function updateBrandVoiceAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");

  const workspace = await resolveWorkspaceOrThrow(slug);
  await updateBrandVoice(workspace.id, brandId, {
    tone: String(formData.get("tone") ?? "").trim(),
    personality: String(formData.get("personality") ?? "").trim(),
    writingGuidelines: String(formData.get("writing_guidelines") ?? "").trim(),
  });

  redirect(`/w/${slug}/brand/${brandId}`);
}

export async function createAudienceProfileAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    throw new Error("Audience profile name is required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createAudienceProfile(workspace.id, brandId, {
    name,
    description: String(formData.get("description") ?? "").trim(),
  });

  redirect(`/w/${slug}/brand/${brandId}`);
}

export async function createContentPillarAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    throw new Error("Content pillar name is required");
  }

  const rawPriority = String(formData.get("priority") ?? "").trim();
  const priority = rawPriority ? Number.parseInt(rawPriority, 10) : undefined;

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createContentPillar(workspace.id, brandId, {
    name,
    description: String(formData.get("description") ?? "").trim(),
    priority: priority !== undefined && !Number.isNaN(priority) ? priority : undefined,
  });

  redirect(`/w/${slug}/brand/${brandId}`);
}
