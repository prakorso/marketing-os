import type { ContentVariant, SocialAccount } from "@/types/database";

/**
 * Social Provider Interface (Engineering Blueprint §16). An adapter's job
 * is exactly: given an already-resolved credential and the content/account
 * to publish to, perform the publish call and return the provider's
 * identifiers/response, or throw a ProviderError on failure.
 *
 * MVP-2.3 scope: this interface has exactly one implementation
 * (MockProviderAdapter, below) — no real provider SDK, no network call,
 * no OAuth. Adapters never see or resolve credentials themselves; the
 * credential is resolved by the execution service
 * (src/server/services/publication-execution.ts) immediately before this
 * method is called, and is passed in as a plain argument — an adapter
 * must never persist it, log it, or return it as part of its result.
 */
export type ProviderPublishInput = {
  /** Resolved from Supabase Vault immediately before this call. Never log or return this value. */
  credential: string;
  /** Passed through unchanged from publications.idempotency_key — never regenerated. */
  idempotencyKey: string;
  variant: ContentVariant;
  socialAccount: SocialAccount;
};

export type ProviderPublishResult = {
  externalPublicationId: string;
  externalUrl: string | null;
  providerResponse: Record<string, unknown>;
};

/** Normalized provider failure (Engineering Blueprint §16: "provider error normalization"). */
export class ProviderError extends Error {
  code: string;
  providerResponse: Record<string, unknown>;

  constructor(message: string, code: string, providerResponse: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.providerResponse = providerResponse;
  }
}

export interface SocialProviderAdapter {
  publish(input: ProviderPublishInput): Promise<ProviderPublishResult>;
}

/**
 * Deterministic mock adapter — no network call, no real credential
 * validation. Used for every platform this phase (see registry.ts); real
 * per-platform adapters are out of scope until a later phase explicitly
 * requires them.
 *
 * Testing seam: if `credential` is exactly this sentinel value, `publish`
 * throws a ProviderError instead of succeeding, so execution-service tests
 * can exercise the markFailed path deterministically without any special
 * flag on the public interface (a real adapter wouldn't have one either).
 */
export const MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL = "mock-provider-force-failure";

export class MockProviderAdapter implements SocialProviderAdapter {
  async publish(input: ProviderPublishInput): Promise<ProviderPublishResult> {
    if (input.credential === MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL) {
      throw new ProviderError("Mock provider forced failure", "mock_forced_failure", {
        mock: true,
        platform: input.socialAccount.platform,
      });
    }

    return {
      externalPublicationId: `mock-${input.idempotencyKey}`,
      externalUrl: `https://mock.invalid/${input.socialAccount.platform}/${input.idempotencyKey}`,
      providerResponse: {
        mock: true,
        platform: input.socialAccount.platform,
        variantId: input.variant.id,
      },
    };
  }
}
