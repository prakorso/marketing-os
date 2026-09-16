import type { SocialPlatform } from "@/types/database";

import { MockProviderAdapter, type SocialProviderAdapter } from "./provider";

/**
 * Provider registry — resolves an adapter from `social_accounts.platform`,
 * per Engineering Blueprint §16's Social Provider Interface. All four
 * platforms currently share the same mock adapter instance (MVP-2.3
 * decision: no real provider SDKs yet); the registry still keys off
 * platform, so the architecture is genuinely provider-based and a real
 * per-platform adapter can be substituted here later without touching any
 * caller.
 */
const mockAdapter = new MockProviderAdapter();

const registry: Record<SocialPlatform, SocialProviderAdapter> = {
  instagram: mockAdapter,
  tiktok: mockAdapter,
  youtube: mockAdapter,
  threads: mockAdapter,
};

export function resolveProviderAdapter(platform: SocialPlatform): SocialProviderAdapter {
  const adapter = registry[platform];
  if (!adapter) {
    throw new Error(`No provider adapter registered for platform: ${platform}`);
  }
  return adapter;
}
