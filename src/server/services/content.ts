import "server-only";

import { createClient } from "@/lib/supabase/server";
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
  input: { generationMethod: string; payloadText: string; sourceVersionId?: string },
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
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create version: ${error.message}`);
  return data;
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
    .from("content_assets")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("content_id", contentId)
    .order("sort_order", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Failed to list linked assets: ${error.message}`);
  if (!links || links.length === 0) return [];

  const assetIds = links.map((link) => link.asset_id);
  const { data: assetRows, error: assetsError } = await supabase
    .from("assets")
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
  const { error } = await supabase.from("content_assets").insert({
    content_id: contentId,
    asset_id: assetId,
    workspace_id: workspaceId,
    role: input.role || null,
    sort_order: input.sortOrder ?? null,
  });
  // Composite FKs (content_assets_content_id_workspace_id_fkey /
  // _asset_id_workspace_id_fkey) reject this outright if either side
  // doesn't belong to workspaceId — no extra app-layer check needed here.
  if (error) throw new Error(`Failed to attach asset: ${error.message}`);
}

export async function detachAsset(workspaceId: string, contentId: string, assetId: string) {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { error } = await supabase
    .from("content_assets")
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
