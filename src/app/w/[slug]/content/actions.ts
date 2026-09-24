"use server";

import { redirect } from "next/navigation";

import {
  attachAsset,
  attachBriefToContent,
  createContent,
  createContentApproval,
  createContentBrief,
  createContentVariant,
  createContentVersion,
  detachAsset,
  generateContentVersionFromBrief,
  generateImageAssetFromBrief,
  updateContentBrief,
  updateContentStatus,
  updateContentVariant,
} from "@/server/services/content";
import { getWorkspaceBySlug } from "@/server/services/workspaces";
import type { ContentApprovalStatus, ContentStatus, ContentVariantStatus } from "@/types/database";

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

export async function createContentAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!brandId || !title) {
    throw new Error("Brand and title are required");
  }
  const briefId = String(formData.get("brief_id") ?? "").trim();

  const workspace = await resolveWorkspaceOrThrow(slug);
  const content = await createContent(workspace.id, {
    brandId,
    briefId: briefId || undefined,
    title,
    contentType: String(formData.get("content_type") ?? "").trim() || undefined,
  });

  redirect(`/w/${slug}/content/${content.id}`);
}

export async function updateContentStatusAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const status = String(formData.get("status") ?? "") as ContentStatus;

  const workspace = await resolveWorkspaceOrThrow(slug);
  await updateContentStatus(workspace.id, contentId, status);

  redirect(`/w/${slug}/content/${contentId}`);
}

export async function createContentBriefAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!brandId || !title) {
    throw new Error("Brand and title are required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  const brief = await createContentBrief(workspace.id, {
    brandId,
    title,
    objective: String(formData.get("objective") ?? "").trim() || undefined,
    angle: String(formData.get("angle") ?? "").trim() || undefined,
    coreMessage: String(formData.get("core_message") ?? "").trim() || undefined,
    cta: String(formData.get("cta") ?? "").trim() || undefined,
    format: String(formData.get("format") ?? "").trim() || undefined,
    opportunityId: String(formData.get("opportunity_id") ?? "").trim() || undefined,
    creativeDirection: String(formData.get("creative_direction") ?? "").trim() || undefined,
  });

  if (contentId) {
    await attachBriefToContent(workspace.id, contentId, brief.id);
    redirect(`/w/${slug}/content/${contentId}`);
  }
  redirect(`/w/${slug}/content`);
}

export async function updateContentBriefAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const briefId = String(formData.get("brief_id") ?? "");

  const workspace = await resolveWorkspaceOrThrow(slug);
  await updateContentBrief(workspace.id, briefId, {
    title: String(formData.get("title") ?? "").trim(),
    objective: String(formData.get("objective") ?? "").trim(),
    angle: String(formData.get("angle") ?? "").trim(),
    coreMessage: String(formData.get("core_message") ?? "").trim(),
    cta: String(formData.get("cta") ?? "").trim(),
    format: String(formData.get("format") ?? "").trim(),
    // Empty string (the form's "None" option) clears the relationship;
    // this field is always submitted, so opportunityId is never undefined
    // here, matching updateContentBrief's "always touch" update semantics.
    opportunityId: String(formData.get("opportunity_id") ?? "").trim(),
    // MVP-5.5: wires up content_briefs.creative_direction (see
    // ContentBriefInput's doc comment). Same "always touch" semantics as
    // the other text fields above — empty string clears it.
    creativeDirection: String(formData.get("creative_direction") ?? "").trim(),
  });

  redirect(`/w/${slug}/content/${contentId}`);
}

export async function createContentVersionAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const payloadText = String(formData.get("payload_text") ?? "").trim();
  if (!payloadText) {
    throw new Error("Version content is required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createContentVersion(workspace.id, contentId, {
    generationMethod: String(formData.get("generation_method") ?? "human").trim() || "human",
    payloadText,
  });

  redirect(`/w/${slug}/content/${contentId}`);
}

/**
 * MVP-5.4: triggers real AI text generation via
 * generateContentVersionFromBrief (Content Application Service -> AI
 * Service -> AI Provider Interface -> OpenAI Provider Adapter). On failure
 * (no active prompt, provider error, etc.) the error is surfaced via a
 * query param rather than crashing to Next's generic error boundary — the
 * smallest surface that lets the page render an explicit failure state
 * (see ContentDetailPage). No fallback content is ever created on failure.
 */
export async function generateContentVersionWithAiAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");

  const workspace = await resolveWorkspaceOrThrow(slug);
  try {
    await generateContentVersionFromBrief(workspace.id, contentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI generation failed";
    redirect(`/w/${slug}/content/${contentId}?ai_error=${encodeURIComponent(message)}`);
  }

  redirect(`/w/${slug}/content/${contentId}`);
}

/**
 * MVP-5.5: triggers real AI image generation via generateImageAssetFromBrief
 * (Content Application Service -> AI Service -> AI Provider Interface ->
 * OpenAI Provider Adapter -> Asset Storage -> content_assets). Mirrors
 * generateContentVersionWithAiAction's failure-surfacing pattern exactly,
 * using a distinct query param so the page can tell which generation type
 * failed. No fallback image is ever created on failure.
 */
export async function generateImageAssetWithAiAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");

  const workspace = await resolveWorkspaceOrThrow(slug);
  try {
    await generateImageAssetFromBrief(workspace.id, contentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI image generation failed";
    redirect(`/w/${slug}/content/${contentId}?ai_image_error=${encodeURIComponent(message)}`);
  }

  redirect(`/w/${slug}/content/${contentId}`);
}

export async function createContentVariantAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const contentVersionId = String(formData.get("content_version_id") ?? "");

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createContentVariant(workspace.id, contentVersionId, {
    platform: String(formData.get("platform") ?? "").trim() || undefined,
    format: String(formData.get("format") ?? "").trim() || undefined,
    caption: String(formData.get("caption") ?? "").trim() || undefined,
  });

  redirect(`/w/${slug}/content/${contentId}`);
}

export async function updateContentVariantAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const variantId = String(formData.get("variant_id") ?? "");
  const status = String(formData.get("status") ?? "") as ContentVariantStatus;

  const workspace = await resolveWorkspaceOrThrow(slug);
  await updateContentVariant(workspace.id, variantId, { status });

  redirect(`/w/${slug}/content/${contentId}`);
}

export async function attachAssetAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const assetId = String(formData.get("asset_id") ?? "");
  if (!assetId) {
    throw new Error("Please choose an asset to attach");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await attachAsset(workspace.id, contentId, assetId, {
    role: String(formData.get("role") ?? "").trim() || undefined,
  });

  redirect(`/w/${slug}/content/${contentId}`);
}

export async function detachAssetAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const assetId = String(formData.get("asset_id") ?? "");

  const workspace = await resolveWorkspaceOrThrow(slug);
  await detachAsset(workspace.id, contentId, assetId);

  redirect(`/w/${slug}/content/${contentId}`);
}

export async function createContentApprovalAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const contentId = String(formData.get("content_id") ?? "");
  const status = String(formData.get("status") ?? "") as ContentApprovalStatus;
  const contentVersionId = String(formData.get("content_version_id") ?? "").trim();

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createContentApproval(workspace.id, contentId, {
    status,
    comment: String(formData.get("comment") ?? "").trim() || undefined,
    contentVersionId: contentVersionId || undefined,
  });

  redirect(`/w/${slug}/content/${contentId}`);
}
