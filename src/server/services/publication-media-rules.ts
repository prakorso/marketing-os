// MVP-5.36: no `server-only` in this module — it is pure validation plus
// client-injected reads/signing (no env, no Vault, no secret), so the
// Level-6 scheduled-function runtime can bundle it. publication-media.ts
// (server-only) re-exports it and keeps the service-role wrapper.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Asset, ContentVariant, Database, SocialAccount } from "@/types/database";

/**
 * MVP-5.35C-B — IMAGE-only publish media resolution and eligibility
 * (MVP-5.35C-A §2/§3; Decision #43: explicit variant-level media, JPEG-only,
 * image-first, Model-B account target).
 *
 *   publication → variant → marqos_content_variant_assets (sort_order)
 *   → exactly one marqos_assets row → eligibility → signed fetchable URL
 *
 * The signed URL is created with the service-role storage client (so the
 * unattended path does not depend on an end-user RLS session), only
 * immediately before container creation, and is never persisted or logged.
 */

export const PUBLISH_SIGNED_URL_TTL_SECONDS = 900;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_ASPECT = 4 / 5;
const MAX_ASPECT = 1.91;
const MAX_CAPTION_CHARS = 2200;
const MAX_HASHTAGS = 30;
const MAX_MENTIONS = 20;

export type ImageEligibilityFailureCode =
  | "unsupported_variant_format"
  | "caption_limit_exceeded"
  | "account_not_publish_ready"
  | "no_publish_media"
  | "unsupported_media_count"
  | "unsupported_media_type"
  | "asset_archived"
  | "invalid_storage_path"
  | "image_spec_violation";

export type ImageEligibility =
  | { ok: true; asset: Asset; caption: string | null; targetAccountId: string }
  | { ok: false; code: ImageEligibilityFailureCode; message: string };

/** Mirrors legacyInstagramIdRendering (social-accounts.ts) — compatibility check only. */
function legacyRendering(id: string): string | null {
  return /^\d+$/.test(id) ? String(Number(id)) : null;
}

/**
 * Model B (Decision #43): the account must have been reconnected under
 * Model B — external_account_id is the exact professional <IG_ID>, never
 * the legacy rounded token-scoped rendering.
 */
export function isModelBPublishReady(account: Pick<SocialAccount, "platform" | "status" | "metadata" | "external_account_id" | "vault_secret_id">): boolean {
  const metadata = (account.metadata ?? {}) as Record<string, unknown>;
  const scoped = metadata.instagramScopedUserId;
  return (
    account.platform === "instagram" &&
    account.status === "connected" &&
    metadata.credentialKind === "real" &&
    !!account.vault_secret_id &&
    typeof scoped === "string" &&
    scoped !== "" &&
    /^\d+$/.test(account.external_account_id) &&
    account.external_account_id !== legacyRendering(scoped)
  );
}

function fail(code: ImageEligibilityFailureCode, message: string): ImageEligibility {
  return { ok: false, code, message };
}

/** Pure validation — no I/O. `assets` are the variant's bound assets in sort_order. */
export function validateImagePublishEligibility(input: {
  workspaceId: string;
  variant: Pick<ContentVariant, "platform" | "format" | "caption">;
  socialAccount: Pick<SocialAccount, "platform" | "status" | "metadata" | "external_account_id" | "vault_secret_id">;
  assets: Asset[];
}): ImageEligibility {
  const { variant, socialAccount, assets, workspaceId } = input;

  if ((variant.platform ?? "").trim().toLowerCase() !== "instagram" || (variant.format ?? "").trim().toLowerCase() !== "image") {
    return fail("unsupported_variant_format", "Only Instagram variants with format 'image' can be published in this slice");
  }

  const caption = variant.caption && variant.caption.length > 0 ? variant.caption : null;
  if (caption) {
    const hashtags = (caption.match(/(^|\s)#[^\s#]+/g) ?? []).length;
    const mentions = (caption.match(/(^|\s)@[^\s@]+/g) ?? []).length;
    if ([...caption].length > MAX_CAPTION_CHARS || hashtags > MAX_HASHTAGS || mentions > MAX_MENTIONS) {
      return fail("caption_limit_exceeded", "Caption exceeds Instagram limits (2200 characters, 30 hashtags, 20 mentions)");
    }
  }

  if (!isModelBPublishReady(socialAccount)) {
    return fail("account_not_publish_ready", "The Instagram account is not a connected, Model-B-migrated real account");
  }

  if (assets.length === 0) {
    return fail("no_publish_media", "The variant has no selected publish media");
  }
  if (assets.length > 1) {
    return fail("unsupported_media_count", "Image publishing requires exactly one selected asset (carousel is not supported yet)");
  }

  const asset = assets[0];
  const path = asset.storage_path ?? "";
  if (asset.asset_type !== "image" || asset.mime_type.toLowerCase() !== "image/jpeg" || !/\.jpe?g$/i.test(path)) {
    return fail("unsupported_media_type", "Only JPEG images (image/jpeg, .jpg/.jpeg) can be published");
  }
  if (asset.archived_at) {
    return fail("asset_archived", "The selected asset is archived");
  }
  if (
    asset.workspace_id !== workspaceId ||
    asset.storage_bucket !== "assets" ||
    !path.startsWith(`${workspaceId}/`) ||
    path.includes("..") ||
    path.includes("//")
  ) {
    return fail("invalid_storage_path", "The selected asset's storage location is not valid for this workspace");
  }
  if (asset.file_size > MAX_IMAGE_BYTES) {
    return fail("image_spec_violation", "Image exceeds the 8 MB limit");
  }
  if (asset.width && asset.height) {
    const aspect = asset.width / asset.height;
    if (aspect < MIN_ASPECT - 1e-9 || aspect > MAX_ASPECT + 1e-9) {
      return fail("image_spec_violation", "Image aspect ratio must be between 4:5 and 1.91:1");
    }
  }

  return { ok: true, asset, caption, targetAccountId: socialAccount.external_account_id };
}

/** Loads the variant's bound assets in publish order (workspace-scoped, defense in depth). */
export async function loadVariantPublishAssets(
  client: SupabaseClient<Database>,
  workspaceId: string,
  contentVariantId: string,
): Promise<Asset[]> {
  const { data: bindings, error } = await client
    .from("marqos_content_variant_assets")
    .select("asset_id, sort_order")
    .eq("workspace_id", workspaceId)
    .eq("content_variant_id", contentVariantId)
    .order("sort_order");
  if (error) {
    throw new Error(`Failed to load variant media: ${error.message}`);
  }
  if (!bindings || bindings.length === 0) {
    return [];
  }

  const { data: assets, error: assetsError } = await client
    .from("marqos_assets")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in(
      "id",
      bindings.map((binding) => binding.asset_id),
    );
  if (assetsError) {
    throw new Error(`Failed to load variant assets: ${assetsError.message}`);
  }
  const byId = new Map((assets ?? []).map((asset) => [asset.id, asset]));
  return bindings.map((binding) => byId.get(binding.asset_id)).filter((asset): asset is Asset => !!asset);
}

/**
 * Provider-fetchable signed URL for one asset, using the given (service-role)
 * storage client. Generated just before container creation; the caller must
 * never persist or log the returned value.
 */
export async function createPublishSignedUrlWith(
  client: Pick<SupabaseClient<Database>, "storage">,
  asset: Pick<Asset, "storage_bucket" | "storage_path">,
): Promise<string> {
  const { data, error } = await client.storage.from(asset.storage_bucket).createSignedUrl(asset.storage_path, PUBLISH_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error("Failed to create a signed publish URL for the selected asset");
  }
  return data.signedUrl;
}
