import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { AudienceProfile, Brand, BrandIdentity, BrandVoice, ContentPillar } from "@/types/database";

/**
 * All Brand-domain reads/writes are scoped by an explicit `workspaceId`
 * argument that callers must have already resolved server-side (e.g. via
 * getWorkspaceBySlug, which is itself RLS-scoped to the current user's
 * membership). This module never accepts a workspace_id as an
 * authorization mechanism on its own — every query still goes through
 * Supabase RLS (brands_select_members / is_workspace_editor, Database
 * Architecture §3/§20), which is what actually enforces tenant isolation
 * regardless of what workspaceId a caller passes in.
 */

export type BrandDetail = {
  brand: Brand;
  identity: BrandIdentity | null;
  voice: BrandVoice | null;
  audienceProfiles: AudienceProfile[];
  pillars: ContentPillar[];
};

export async function listBrandsForWorkspace(workspaceId: string): Promise<Brand[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brands")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list brands: ${error.message}`);
  }

  return data ?? [];
}

/** Full context for one brand: identity/voice (nullable 1:1) + audience profiles/pillars (1:N). */
export async function getBrandDetail(workspaceId: string, brandId: string): Promise<BrandDetail | null> {
  const supabase = await createClient();

  const { data: brand, error: brandError } = await supabase
    .from("brands")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", brandId)
    .maybeSingle();

  if (brandError) {
    throw new Error(`Failed to load brand: ${brandError.message}`);
  }
  if (!brand) {
    return null;
  }

  const [identityResult, voiceResult, audienceResult, pillarsResult] = await Promise.all([
    supabase.from("brand_identity").select("*").eq("brand_id", brandId).maybeSingle(),
    supabase.from("brand_voice").select("*").eq("brand_id", brandId).maybeSingle(),
    supabase.from("audience_profiles").select("*").eq("brand_id", brandId).order("created_at", { ascending: true }),
    supabase.from("content_pillars").select("*").eq("brand_id", brandId).order("created_at", { ascending: true }),
  ]);

  if (identityResult.error) throw new Error(`Failed to load brand identity: ${identityResult.error.message}`);
  if (voiceResult.error) throw new Error(`Failed to load brand voice: ${voiceResult.error.message}`);
  if (audienceResult.error) throw new Error(`Failed to load audience profiles: ${audienceResult.error.message}`);
  if (pillarsResult.error) throw new Error(`Failed to load content pillars: ${pillarsResult.error.message}`);

  return {
    brand,
    identity: identityResult.data,
    voice: voiceResult.data,
    audienceProfiles: audienceResult.data ?? [],
    pillars: pillarsResult.data ?? [],
  };
}

export async function createBrand(
  workspaceId: string,
  input: { name: string; description?: string; websiteUrl?: string },
): Promise<Brand> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brands")
    .insert({
      workspace_id: workspaceId,
      name: input.name,
      description: input.description || null,
      website_url: input.websiteUrl || null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create brand: ${error.message}`);
  }

  return data;
}

export async function updateBrand(
  workspaceId: string,
  brandId: string,
  input: { name?: string; description?: string; websiteUrl?: string },
): Promise<Brand> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brands")
    .update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.websiteUrl !== undefined ? { website_url: input.websiteUrl || null } : {}),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", brandId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update brand: ${error.message}`);
  }

  return data;
}

/** Archive is the only supported removal path — brands are never hard-deleted (Database Architecture §19). */
export async function setBrandStatus(
  workspaceId: string,
  brandId: string,
  status: "active" | "archived",
): Promise<Brand> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brands")
    .update({ status })
    .eq("workspace_id", workspaceId)
    .eq("id", brandId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update brand status: ${error.message}`);
  }

  return data;
}

/**
 * brand_voice is 1:1 and nullable (no row until one is created) — upserts
 * on the table's UNIQUE(brand_id) constraint. Only the plain-text columns
 * (tone/personality/writing_guidelines) are editable here; preferred_terms/
 * avoid_terms/example_copy are JSONB with no canonical shape specified in
 * Database Architecture §3, so this slice displays them read-only rather
 * than inventing a structure for them.
 */
export async function updateBrandVoice(
  workspaceId: string,
  brandId: string,
  input: { tone?: string; personality?: string; writingGuidelines?: string },
): Promise<BrandVoice> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("brand_voice")
    .upsert(
      {
        brand_id: brandId,
        workspace_id: workspaceId,
        tone: input.tone || null,
        personality: input.personality || null,
        writing_guidelines: input.writingGuidelines || null,
      },
      { onConflict: "brand_id" },
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update brand voice: ${error.message}`);
  }

  return data;
}

export async function createAudienceProfile(
  workspaceId: string,
  brandId: string,
  input: { name: string; description?: string },
): Promise<AudienceProfile> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audience_profiles")
    .insert({
      workspace_id: workspaceId,
      brand_id: brandId,
      name: input.name,
      description: input.description || null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create audience profile: ${error.message}`);
  }

  return data;
}

export async function createContentPillar(
  workspaceId: string,
  brandId: string,
  input: { name: string; description?: string; priority?: number },
): Promise<ContentPillar> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_pillars")
    .insert({
      workspace_id: workspaceId,
      brand_id: brandId,
      name: input.name,
      description: input.description || null,
      priority: input.priority ?? null,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create content pillar: ${error.message}`);
  }

  return data;
}
