import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { Asset, AssetType } from "@/types/database";

const STORAGE_BUCKET = "assets";
const SIGNED_URL_TTL_SECONDS = 300;

/**
 * All Assets-domain reads/writes are scoped by an explicit `workspaceId`
 * argument the caller must have already resolved server-side (e.g. via
 * getWorkspaceBySlug, RLS-scoped to the current user's membership). This
 * module never accepts workspace_id as an authorization mechanism on its
 * own — Supabase RLS on `marqos_assets` (marqos_assets_select_members /
 * _insert_editors / _update_editors, Database Architecture §6) is the
 * actual boundary. The table is named `marqos_assets`, not `assets`
 * (MVP-5.24/MVP-5.25): the hosted Supabase project also contains a
 * differently-shaped, pre-existing `assets` table belonging to a separate
 * application sharing the project. The Storage bucket is unaffected and
 * keeps its original name (`assets`, STORAGE_BUCKET below) — the two are
 * different namespaces.
 *
 * One deliberate exception to "RLS alone is enough": storage.objects RLS
 * for the `assets` bucket (Foundation, 20260915063158) grants INSERT/
 * UPDATE/DELETE to any workspace *member*, not just editors — narrower
 * than the `marqos_assets` table's editor-only write policies. This module
 * does not change that (Foundation migration is out of scope here), but it does
 * add an explicit editor check before any storage write, so this app's
 * upload/archive paths enforce the intended owner/admin/marketer-only rule
 * even though the storage bucket's own RLS is broader. Flagged in the
 * milestone report as a known limitation, not silently relied upon.
 */
async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to manage assets in this workspace");
  }
}

function deriveAssetType(mimeType: string): AssetType {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType === "application/msword" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "document";
  }
  return "other";
}

function deriveExtension(fileName: string, mimeType: string): string {
  const fromName = fileName.includes(".") ? fileName.split(".").pop() : undefined;
  if (fromName) return fromName.toLowerCase();
  const fromMime = mimeType.split("/").pop();
  return fromMime ? fromMime.toLowerCase() : "bin";
}

export type AssetListFilters = {
  assetType?: AssetType;
  includeArchived?: boolean;
};

export async function listAssetsForWorkspace(workspaceId: string, filters: AssetListFilters = {}): Promise<Asset[]> {
  const supabase = await createClient();
  let query = supabase.from("marqos_assets").select("*").eq("workspace_id", workspaceId);

  if (filters.assetType) {
    query = query.eq("asset_type", filters.assetType);
  }
  if (!filters.includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list assets: ${error.message}`);
  }
  return data ?? [];
}

export async function getAssetDetail(workspaceId: string, assetId: string): Promise<Asset | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marqos_assets")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", assetId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load asset: ${error.message}`);
  }
  return data;
}

/** Short-lived signed URL for private preview — never a public/permanent URL. Image assets only for this slice. */
export async function getAssetSignedUrl(asset: Asset): Promise<string | null> {
  if (asset.asset_type !== "image") {
    return null;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(asset.storage_path, SIGNED_URL_TTL_SECONDS);

  if (error) {
    return null;
  }
  return data.signedUrl;
}

/**
 * Uploads a file to the workspace's private storage folder and creates the
 * corresponding `marqos_assets` row. If the DB insert fails after a successful
 * storage upload, the orphaned storage object is removed. If the storage
 * upload itself fails, no DB row is ever attempted.
 */
export async function uploadAsset(workspaceId: string, file: File, brandId?: string, aiJobId?: string): Promise<Asset> {
  await assertEditor(workspaceId);

  if (!file || file.size === 0) {
    throw new Error("A non-empty file is required");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Authentication required");
  }

  const assetId = crypto.randomUUID();
  const extension = deriveExtension(file.name, file.type || "application/octet-stream");
  const storagePath = `${workspaceId}/${assetId}.${extension}`;

  const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });

  if (uploadError) {
    throw new Error(`Failed to upload file: ${uploadError.message}`);
  }

  const { data, error: insertError } = await supabase
    .from("marqos_assets")
    .insert({
      id: assetId,
      workspace_id: workspaceId,
      brand_id: brandId || null,
      storage_bucket: STORAGE_BUCKET,
      storage_path: storagePath,
      file_name: file.name || `${assetId}.${extension}`,
      mime_type: file.type || "application/octet-stream",
      asset_type: deriveAssetType(file.type || ""),
      file_size: file.size,
      created_by: user.id,
      // MVP-5.3: completes the MVP-1.2 traceability deferral. NULL (the
      // default) for human/uploaded assets — never populated silently.
      ai_job_id: aiJobId || null,
    })
    .select()
    .single();

  if (insertError) {
    // Clean up the orphaned storage object — the DB row is the source of
    // truth for what "exists" as an asset; a storage object with no row
    // must not be left behind.
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    throw new Error(`Failed to save asset record: ${insertError.message}`);
  }

  return data;
}

export async function setAssetArchived(workspaceId: string, assetId: string, archived: boolean): Promise<Asset> {
  await assertEditor(workspaceId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marqos_assets")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("workspace_id", workspaceId)
    .eq("id", assetId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update asset: ${error.message}`);
  }
  return data;
}
