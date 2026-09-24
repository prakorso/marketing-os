import type { SocialAccount } from "@/types/database";

import { InstagramProviderAdapter } from "./instagram-adapter";
import { MockProviderAdapter, type SocialProviderAdapter } from "./provider";

/**
 * Provider registry (MVP-2.3, revised MVP-5.21) — resolves an adapter from
 * a social account's platform AND, for Instagram, whether that specific
 * account is marked as using a real, verified credential.
 *
 * MVP-5.21 finding: `social_accounts.metadata` (JSONB, existing since the
 * original social_accounts migration, default `'{}'::jsonb`) is never
 * written by `connectSocialAccount()` — confirmed by direct inspection —
 * so it is empty for every account in every environment today, including
 * every existing test fixture. This makes it a safe, zero-schema-change,
 * zero-collision routing signal: absence of the flag below (the default
 * for literally every account that exists right now) means "route to the
 * mock adapter," exactly preserving today's behavior for every existing
 * caller. No database migration was introduced — the column already
 * exists and already defaults to a value that means "mock."
 *
 * `REAL_CREDENTIAL_METADATA_KEY`/`REAL_CREDENTIAL_METADATA_VALUE` are not
 * a new general credential-architecture — they are the single explicit
 * marker a future real-account-connection flow (OAuth, not implemented
 * yet — see Decisions/roadmap) would set on `social_accounts.metadata`
 * once it exists, so that this registry can then route that specific
 * account's traffic to the real, already-implemented, already-tested
 * `InstagramProviderAdapter` (MVP-5.19) instead of the mock — without any
 * further registry change when that day comes.
 */
const mockAdapter = new MockProviderAdapter();
const instagramAdapter = new InstagramProviderAdapter();

const mockRegistry: Record<SocialAccount["platform"], SocialProviderAdapter> = {
  instagram: mockAdapter,
  tiktok: mockAdapter,
  youtube: mockAdapter,
  threads: mockAdapter,
};

/** The single explicit marker meaning "this account's stored credential is real, verified, and safe to send to the real provider adapter." Absent (the default for every account today) means mock. */
export const REAL_CREDENTIAL_METADATA_KEY = "credentialKind";
export const REAL_CREDENTIAL_METADATA_VALUE = "real";

export function usesRealProviderCredential(metadata: Record<string, unknown> | null | undefined): boolean {
  return !!metadata && metadata[REAL_CREDENTIAL_METADATA_KEY] === REAL_CREDENTIAL_METADATA_VALUE;
}

/**
 * Resolves the adapter for one social account. Takes the account (not
 * just its platform) because, for Instagram specifically, routing is now
 * per-account: only an account explicitly marked with the real-credential
 * metadata flag routes to `InstagramProviderAdapter`; every other
 * Instagram account (i.e. every one that exists today) routes to the same
 * shared mock adapter every other platform already uses — unchanged
 * behavior for every existing caller and every existing test.
 */
export function resolveProviderAdapter(socialAccount: Pick<SocialAccount, "platform" | "metadata">): SocialProviderAdapter {
  if (socialAccount.platform === "instagram" && usesRealProviderCredential(socialAccount.metadata)) {
    return instagramAdapter;
  }

  const adapter = mockRegistry[socialAccount.platform];
  if (!adapter) {
    throw new Error(`No provider adapter registered for platform: ${socialAccount.platform}`);
  }
  return adapter;
}
