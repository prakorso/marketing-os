import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { AiProviderAdapter, AiProviderImageResult } from "@/lib/ai/provider";
import { generateImage, generateText } from "@/server/services/ai";
import { setAssetArchived, uploadAsset } from "@/server/services/assets";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type {
  Asset,
  Content,
  ContentApproval,
  ContentApprovalStatus,
  ContentBrief,
  ContentStatus,
  ContentVariant,
  ContentVariantStatus,
  ContentVersion,
} from "@/types/database";

/**
 * All Content-domain reads/writes are scoped by an explicit `workspaceId`
 * the caller has already resolved server-side (via getWorkspaceBySlug,
 * RLS-scoped). Supabase RLS on each table (Database Architecture §5/§7,
 * 20260915154503_content.sql) is the actual authorization boundary.
 *
 * One gap worth documenting rather than silently relying on: unlike
 * `content.brand_id` (composite-FK-checked against `brands(id,
 * workspace_id)`), `content.brief_id` and `content_briefs.
 * audience_profile_id`/`content_pillar_id` are PLAIN foreign keys with no
 * composite tenant check — confirmed live and consistent with Database
 * Architecture §16's own composite-FK list, which does not name these
 * pairs. That's a deliberate canonical design choice, not a defect: those
 * associations rely on the application layer using RLS-scoped lookups
 * before writing, exactly like this module does below (`getContentBrief`
 * before ever using a brief_id, `listBrandsForWorkspace`-style scoping for
 * audience/pillar pickers in the UI). `content_assets` and
 * `content_approvals.content_version_id`, by contrast, ARE
 * composite-FK-protected at the database level (verified live).
 */
async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to modify content in this workspace");
  }
}

async function assertAdmin(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin") {
    throw new Error("Only a workspace owner or admin may record an approval decision");
  }
}

// =============================================================================
// Content
// =============================================================================

export type ContentListFilters = {
  status?: ContentStatus;
  contentType?: string;
  brandId?: string;
};

export async function listContentForWorkspace(workspaceId: string, filters: ContentListFilters = {}): Promise<Content[]> {
  const supabase = await createClient();
  let query = supabase.from("content").select("*").eq("workspace_id", workspaceId);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.contentType) query = query.eq("content_type", filters.contentType);
  if (filters.brandId) query = query.eq("brand_id", filters.brandId);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list content: ${error.message}`);
  return data ?? [];
}

export async function getContent(workspaceId: string, contentId: string): Promise<Content | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", contentId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load content: ${error.message}`);
  return data;
}

export async function createContent(
  workspaceId: string,
  input: { brandId: string; briefId?: string; title: string; contentType?: string },
): Promise<Content> {
  await assertEditor(workspaceId);

  // Explicit workspace-scoped validation for brief_id — see module header:
  // this FK has no composite tenant check at the database level, so the
  // application layer is the enforcement point.
  if (input.briefId) {
    const brief = await getContentBrief(workspaceId, input.briefId);
    if (!brief) {
      throw new Error("The selected brief does not belong to this workspace");
    }
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content")
    .insert({
      workspace_id: workspaceId,
      brand_id: input.brandId,
      brief_id: input.briefId || null,
      title: input.title,
      content_type: input.contentType || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create content: ${error.message}`);
  return data;
}

export async function updateContentStatus(workspaceId: string, contentId: string, status: ContentStatus) {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content")
    .update({ status })
    .eq("workspace_id", workspaceId)
    .eq("id", contentId)
    .select()
    .single();
  if (error) throw new Error(`Failed to update content status: ${error.message}`);
  return data;
}

// =============================================================================
// Content Briefs
// =============================================================================

export async function listContentBriefsForWorkspace(workspaceId: string): Promise<ContentBrief[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_briefs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list briefs: ${error.message}`);
  return data ?? [];
}

export async function getContentBrief(workspaceId: string, briefId: string): Promise<ContentBrief | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_briefs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", briefId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load brief: ${error.message}`);
  return data;
}

export type ContentBriefInput = {
  brandId: string;
  audienceProfileId?: string;
  contentPillarId?: string;
  title: string;
  objective?: string;
  angle?: string;
  coreMessage?: string;
  cta?: string;
  format?: string;
  /** MVP-4.2: manually-selected Opportunity link (content_briefs.opportunity_id). Optional — clearing is supported via updateContentBrief. */
  opportunityId?: string;
  /**
   * MVP-5.5: wires up the already-canonical, already-migrated
   * `content_briefs.creative_direction` JSONB column (Database Architecture
   * §5) — never previously exposed by this service or any UI. Stored as
   * `{ text: <value> }`, mirroring `content_versions.content_payload`'s own
   * `{ text }` shape (Database Architecture does not specify an internal
   * schema for this column beyond "JSONB"). Used as optional, non-blocking
   * input to AI image generation (see generateImageAssetFromBrief) —
   * generation falls back to the brief's other existing fields when this
   * is empty, so no new required field is introduced.
   */
  creativeDirection?: string;
};

export async function createContentBrief(workspaceId: string, input: ContentBriefInput): Promise<ContentBrief> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_briefs")
    .insert({
      workspace_id: workspaceId,
      brand_id: input.brandId,
      audience_profile_id: input.audienceProfileId || null,
      content_pillar_id: input.contentPillarId || null,
      title: input.title,
      objective: input.objective || null,
      angle: input.angle || null,
      core_message: input.coreMessage || null,
      cta: input.cta || null,
      format: input.format || null,
      opportunity_id: input.opportunityId || null,
      creative_direction: input.creativeDirection ? { text: input.creativeDirection } : null,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create brief: ${error.message}`);
  return data;
}

export async function updateContentBrief(
  workspaceId: string,
  briefId: string,
  input: Partial<ContentBriefInput>,
): Promise<ContentBrief> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_briefs")
    .update({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.objective !== undefined ? { objective: input.objective || null } : {}),
      ...(input.angle !== undefined ? { angle: input.angle || null } : {}),
      ...(input.coreMessage !== undefined ? { core_message: input.coreMessage || null } : {}),
      ...(input.cta !== undefined ? { cta: input.cta || null } : {}),
      ...(input.format !== undefined ? { format: input.format || null } : {}),
      // opportunityId === "" (explicit clear, from the form's "None" option) -> null;
      // opportunityId === undefined (field not submitted at all) -> key omitted, existing value untouched.
      ...(input.opportunityId !== undefined ? { opportunity_id: input.opportunityId || null } : {}),
      ...(input.creativeDirection !== undefined
        ? { creative_direction: input.creativeDirection ? { text: input.creativeDirection } : null }
        : {}),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", briefId)
    .select()
    .single();
  if (error) throw new Error(`Failed to update brief: ${error.message}`);
  return data;
}

/** Links a content item to a brief after both have been independently validated as belonging to this workspace. */
export async function attachBriefToContent(workspaceId: string, contentId: string, briefId: string) {
  await assertEditor(workspaceId);
  const brief = await getContentBrief(workspaceId, briefId);
  if (!brief) {
    throw new Error("The selected brief does not belong to this workspace");
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("content")
    .update({ brief_id: briefId })
    .eq("workspace_id", workspaceId)
    .eq("id", contentId);
  if (error) throw new Error(`Failed to attach brief: ${error.message}`);
}

// =============================================================================
// Content Versions — immutable: create only, never update
// =============================================================================

export async function listContentVersions(workspaceId: string, contentId: string): Promise<ContentVersion[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_versions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("content_id", contentId)
    .order("version_number", { ascending: false });
  if (error) throw new Error(`Failed to list versions: ${error.message}`);
  return data ?? [];
}

export async function createContentVersion(
  workspaceId: string,
  contentId: string,
  input: { generationMethod: string; payloadText: string; sourceVersionId?: string; aiJobId?: string },
): Promise<ContentVersion> {
  await assertEditor(workspaceId);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const existing = await listContentVersions(workspaceId, contentId);
  const nextVersionNumber = existing.length > 0 ? Math.max(...existing.map((v) => v.version_number)) + 1 : 1;

  const { data, error } = await supabase
    .from("content_versions")
    .insert({
      content_id: contentId,
      workspace_id: workspaceId,
      version_number: nextVersionNumber,
      source_version_id: input.sourceVersionId || null,
      generation_method: input.generationMethod || "human",
      content_payload: { text: input.payloadText },
      created_by: user?.id,
      // MVP-5.3: completes the MVP-1.2 traceability deferral. NULL (the
      // default) for human-authored versions — never populated silently.
      ai_job_id: input.aiJobId || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create version: ${error.message}`);
  return data;
}

// =============================================================================
// MVP-5.4 — Content AI Text Generation Consumer
//
// This is the "Content Application Service" half of the approved chain
// (Content Application Service -> AI Service -> AI Provider Interface ->
// OpenAI Provider Adapter). It never calls the AI Provider Interface or an
// adapter directly — it only calls generateText() from
// src/server/services/ai.ts (the AI Service), then reuses
// createContentVersion() unchanged, passing through the returned jobId.
//
// PROMPT_PURPOSE is fixed, not user-configurable — there is no
// prompt-management UI in this phase (approved scope). An editor must have
// already created an active prompt_versions row for this purpose (via
// ai.ts's createPromptVersion, no UI) for generation to succeed; if none
// exists, resolveActivePromptVersion's existing explicit-failure behavior
// (Engineering Blueprint §12, DECISIONS #26) surfaces as this function's
// own thrown error — no fallback content is ever fabricated.
// =============================================================================

const CONTENT_TEXT_GENERATION_PROMPT_PURPOSE = "content_generate_text";

/** `deps.adapter` is the same test-only injection seam defined in ai.ts's generateText — never passed by production callers (see generateContentVersionWithAiAction). */
export async function generateContentVersionFromBrief(
  workspaceId: string,
  contentId: string,
  deps?: { adapter?: AiProviderAdapter },
): Promise<ContentVersion> {
  const content = await getContent(workspaceId, contentId);
  if (!content) {
    throw new Error("Content not found");
  }
  if (!content.brief_id) {
    throw new Error("This content has no attached Content Brief — AI generation requires one");
  }
  const brief = await getContentBrief(workspaceId, content.brief_id);
  if (!brief) {
    throw new Error("The attached Content Brief could not be loaded");
  }

  // generateText() performs its own editor authorization, creates the
  // ai_jobs row, resolves the prompt, calls the AI Provider Interface, and
  // drives the job to completed/failed — none of that is duplicated here.
  const generation = await generateText(workspaceId, {
    promptPurpose: CONTENT_TEXT_GENERATION_PROMPT_PURPOSE,
    promptVariables: {
      title: brief.title,
      objective: brief.objective ?? "",
      angle: brief.angle ?? "",
      core_message: brief.core_message ?? "",
      cta: brief.cta ?? "",
      format: brief.format ?? "",
    },
    contentBriefId: brief.id,
  }, deps);

  // createContentVersion() is unchanged from MVP-5.3/earlier: a new,
  // immutable version is always created — an existing version is never
  // updated. ai_job_id is set here exactly as it would be for any other
  // caller; approval/publication gates are untouched and apply identically.
  return createContentVersion(workspaceId, contentId, {
    generationMethod: "ai",
    payloadText: generation.text,
    aiJobId: generation.jobId,
  });
}

// =============================================================================
// MVP-5.5 — Content AI Image Generation Consumer
//
// Same "Content Application Service" pattern as generateContentVersionFromBrief
// above: this function calls generateImage() (the AI Service) and reuses
// uploadAsset()/attachAsset() unchanged — no new storage mechanism, no new
// AI execution path, no new content-linking relationship.
//
// Creative Direction interpretation (documented per MVP-5.5 instructions):
// this codebase already has a canonical, migrated, typed column for exactly
// this concept — content_briefs.creative_direction (Database Architecture
// §5) — which no prior slice ever wired into the service layer or UI. This
// function reuses that column as-is rather than inventing a new field or
// table. It is treated as OPTIONAL input: generation falls back to the
// brief's other existing fields (title/objective/angle/core_message) when
// creative_direction is empty, so no new required field is introduced and
// generation remains usable on every existing brief today.
//
// Persistence contract: generateImage()'s optional `onSuccess` hook (added
// in this milestone, see ai.ts) is used to persist the provider's image
// output into Asset Storage and link it via content_assets BEFORE the
// ai_jobs row is marked completed — a provider success with a persistence
// failure therefore still surfaces as a failed AI job, never a "completed"
// job with no real Asset behind it.
// =============================================================================

const CONTENT_IMAGE_GENERATION_PROMPT_PURPOSE = "content_generate_image";

function extractCreativeDirectionText(brief: ContentBrief): string {
  const value = brief.creative_direction;
  if (value && typeof value === "object" && "text" in value && typeof (value as { text: unknown }).text === "string") {
    return (value as { text: string }).text;
  }
  return "";
}

/**
 * Converts the AI provider's image output into bytes suitable for
 * uploadAsset(). Handles both representations documented in
 * AiProviderImageResult: a base64 payload (decoded directly) or a
 * provider-hosted URL (fetched server-side — never exposed to the browser,
 * never used as the final Asset's own URL; the bytes are re-hosted into
 * this app's private Supabase Storage exactly like any other asset).
 */
async function materializeGeneratedImageBytes(
  result: AiProviderImageResult,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string; fileName: string }> {
  if (result.imageBase64) {
    const decoded = Buffer.from(result.imageBase64, "base64");
    // Copied into a fresh, definite ArrayBuffer-backed Uint8Array — Buffer's
    // own .buffer is typed ArrayBufferLike (it may be a pooled/shared
    // allocation), which File/Blob's BlobPart type does not accept directly.
    const bytes = new Uint8Array(decoded.length);
    bytes.set(decoded);
    if (bytes.byteLength === 0) {
      throw new Error("AI provider returned empty base64 image data");
    }
    return { bytes, mimeType: "image/png", fileName: `ai-generated-${Date.now()}.png` };
  }

  if (result.imageUrl) {
    let response: Response;
    try {
      response = await fetch(result.imageUrl);
    } catch (err) {
      throw new Error(`Failed to retrieve generated image from provider: ${err instanceof Error ? err.message : "network error"}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to retrieve generated image from provider (status ${response.status})`);
    }
    const contentType = response.headers.get("content-type") || "image/png";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error("Retrieved generated image was empty");
    }
    const extension = contentType.split("/")[1]?.split(";")[0] || "png";
    return { bytes, mimeType: contentType, fileName: `ai-generated-${Date.now()}.${extension}` };
  }

  throw new Error("AI provider did not return usable image data (no base64 payload or URL)");
}

export type GenerateImageAssetResult = {
  jobId: string;
  asset: Asset;
};

/** `deps.adapter` is the same test-only injection seam used by generateContentVersionFromBrief — never passed by production callers. */
export async function generateImageAssetFromBrief(
  workspaceId: string,
  contentId: string,
  deps?: { adapter?: AiProviderAdapter },
): Promise<GenerateImageAssetResult> {
  const content = await getContent(workspaceId, contentId);
  if (!content) {
    throw new Error("Content not found");
  }
  if (!content.brief_id) {
    throw new Error("This content has no attached Content Brief — AI generation requires one");
  }
  const brief = await getContentBrief(workspaceId, content.brief_id);
  if (!brief) {
    throw new Error("The attached Content Brief could not be loaded");
  }

  let createdAsset: Asset | null = null;

  const generation = await generateImage(
    workspaceId,
    {
      promptPurpose: CONTENT_IMAGE_GENERATION_PROMPT_PURPOSE,
      promptVariables: {
        title: brief.title,
        objective: brief.objective ?? "",
        angle: brief.angle ?? "",
        core_message: brief.core_message ?? "",
        creative_direction: extractCreativeDirectionText(brief),
      },
      contentBriefId: brief.id,
    },
    {
      adapter: deps?.adapter,
      onSuccess: async (providerResult, jobId) => {
        const { bytes, mimeType, fileName } = await materializeGeneratedImageBytes(providerResult);
        const file = new File([bytes], fileName, { type: mimeType });
        const asset = await uploadAsset(workspaceId, file, content.brand_id, jobId);

        try {
          await attachAsset(workspaceId, contentId, asset.id, { role: "ai_generated" });
        } catch (linkError) {
          // The Asset itself was created successfully, but the overall
          // consumer-level promise (a generated image visibly linked to
          // this Content) was not fulfilled — archive it (assets has no
          // authenticated DELETE grant; service_role is not used here
          // since this is a normal application-level failure, not a
          // system/cleanup path) so it never appears as a usable,
          // successful result, then let the failure propagate so the AI
          // job is marked failed, not completed.
          await setAssetArchived(workspaceId, asset.id, true);
          throw linkError;
        }

        createdAsset = asset;
        return { assetId: asset.id, mimeType, fileSize: bytes.byteLength };
      },
    },
  );

  if (!createdAsset) {
    // Unreachable in practice (onSuccess either sets this or throws, and a
    // thrown onSuccess error fails generateImage() itself before this line
    // is reached) — guards against ever reporting success with no Asset.
    throw new Error("Image generation completed without producing an Asset");
  }

  return { jobId: generation.jobId, asset: createdAsset };
}

// =============================================================================
// Content Variants
// =============================================================================

export async function listContentVariants(workspaceId: string, contentVersionId: string): Promise<ContentVariant[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_variants")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("content_version_id", contentVersionId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list variants: ${error.message}`);
  return data ?? [];
}

export async function createContentVariant(
  workspaceId: string,
  contentVersionId: string,
  input: { platform?: string; format?: string; caption?: string },
): Promise<ContentVariant> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_variants")
    .insert({
      content_version_id: contentVersionId,
      workspace_id: workspaceId,
      platform: input.platform || null,
      format: input.format || null,
      caption: input.caption || null,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create variant: ${error.message}`);
  return data;
}

export async function updateContentVariant(
  workspaceId: string,
  variantId: string,
  input: { platform?: string; format?: string; caption?: string; status?: ContentVariantStatus },
): Promise<ContentVariant> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_variants")
    .update({
      ...(input.platform !== undefined ? { platform: input.platform || null } : {}),
      ...(input.format !== undefined ? { format: input.format || null } : {}),
      ...(input.caption !== undefined ? { caption: input.caption || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", variantId)
    .select()
    .single();
  if (error) throw new Error(`Failed to update variant: ${error.message}`);
  return data;
}

// =============================================================================
// Content <-> Asset linking (reuses the Assets domain; no upload logic here)
// =============================================================================

export type LinkedAsset = { content_id: string; asset_id: string; role: string | null; sort_order: number | null; asset: Asset };

export async function listLinkedAssets(workspaceId: string, contentId: string): Promise<LinkedAsset[]> {
  const supabase = await createClient();
  const { data: links, error } = await supabase
    .from("marqos_content_assets")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("content_id", contentId)
    .order("sort_order", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Failed to list linked assets: ${error.message}`);
  if (!links || links.length === 0) return [];

  const assetIds = links.map((link) => link.asset_id);
  const { data: assetRows, error: assetsError } = await supabase
    .from("marqos_assets")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("id", assetIds);
  if (assetsError) throw new Error(`Failed to load linked asset details: ${assetsError.message}`);

  const assetById = new Map((assetRows ?? []).map((asset) => [asset.id, asset]));
  return links
    .map((link) => {
      const asset = assetById.get(link.asset_id);
      if (!asset) return null;
      return { content_id: link.content_id, asset_id: link.asset_id, role: link.role, sort_order: link.sort_order, asset };
    })
    .filter((link): link is LinkedAsset => link !== null);
}

export async function attachAsset(
  workspaceId: string,
  contentId: string,
  assetId: string,
  input: { role?: string; sortOrder?: number } = {},
) {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { error } = await supabase.from("marqos_content_assets").insert({
    content_id: contentId,
    asset_id: assetId,
    workspace_id: workspaceId,
    role: input.role || null,
    sort_order: input.sortOrder ?? null,
  });
  // Composite FKs on marqos_content_assets (content_id, workspace_id) and
  // (asset_id, workspace_id) reject this outright if either side doesn't
  // belong to workspaceId — no extra app-layer check needed here.
  if (error) throw new Error(`Failed to attach asset: ${error.message}`);
}

export async function detachAsset(workspaceId: string, contentId: string, assetId: string) {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { error } = await supabase
    .from("marqos_content_assets")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("content_id", contentId)
    .eq("asset_id", assetId);
  if (error) throw new Error(`Failed to remove asset: ${error.message}`);
}

// =============================================================================
// Content Approvals — append-only; INSERT is owner/admin only
// =============================================================================

export async function listContentApprovals(workspaceId: string, contentId: string): Promise<ContentApproval[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_approvals")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("content_id", contentId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list approvals: ${error.message}`);
  return data ?? [];
}

export async function createContentApproval(
  workspaceId: string,
  contentId: string,
  input: { status: ContentApprovalStatus; comment?: string; contentVersionId?: string },
): Promise<ContentApproval> {
  await assertAdmin(workspaceId);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from("content_approvals")
    .insert({
      workspace_id: workspaceId,
      content_id: contentId,
      content_version_id: input.contentVersionId || null,
      status: input.status,
      comment: input.comment || null,
      reviewed_by: user?.id,
      reviewed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to record approval: ${error.message}`);
  return data;
}
