import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service-role";
import type { Asset } from "@/types/database";

import { createPublishSignedUrlWith } from "@/server/services/publication-media-rules";

// MVP-5.35C-B media rules live in publication-media-rules.ts since MVP-5.36
// (bundle-safe for the scheduled runtime); re-exported for existing importers.
export * from "@/server/services/publication-media-rules";

/**
 * Provider-fetchable signed URL for one asset. Service-role storage client;
 * generated just before container creation; the caller must never persist
 * or log the returned value.
 */
export async function createPublishSignedUrl(asset: Pick<Asset, "storage_bucket" | "storage_path">): Promise<string> {
  return createPublishSignedUrlWith(createServiceRoleClient(), asset);
}
