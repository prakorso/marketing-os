import type { ContentVariant, SocialAccount } from "@/types/database";

import type { RawProviderResponse } from "@/lib/analytics/raw-response";

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

/**
 * MVP-3.1: input for the "metric retrieval" adapter responsibility named
 * in Engineering Blueprint §16, alongside publish(). Mirrors
 * ProviderPublishInput's shape: a credential resolved immediately before
 * the call (never persisted/logged/returned by the adapter), plus the
 * provider identifiers needed to look up a specific publication's metrics.
 */
export type ProviderMetricsInput = {
  /** Resolved from Supabase Vault immediately before this call. Never log or return this value. */
  credential: string;
  /** publications.external_publication_id — identifies which published item to measure. */
  externalPublicationId: string;
  socialAccount: SocialAccount;
};

/** Normalized provider failure (Engineering Blueprint §16: "provider error normalization"). */
export class ProviderError extends Error {
  code: string;
  providerResponse: Record<string, unknown>;
  /** Which provider call failed (e.g. "short_lived_exchange"), when the thrower knows it. */
  stage?: string;

  constructor(message: string, code: string, providerResponse: Record<string, unknown> = {}, stage?: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.providerResponse = providerResponse;
    this.stage = stage;
  }
}

export interface SocialProviderAdapter {
  publish(input: ProviderPublishInput): Promise<ProviderPublishResult>;
  /**
   * Decision #39 (MVP-5.10D/E): returns the provider's raw, unnormalized
   * response only. Normalization (mapping into Marqos's canonical metric
   * vocabulary, determining per-metric state) is the Analytics
   * Normalizer's job (Decision #41), never the adapter's — an adapter
   * must never normalize, and must never persist anything.
   */
  getMetrics(input: ProviderMetricsInput): Promise<RawProviderResponse>;
}

/**
 * MVP-5.35C-B: optional staged media-publishing capability (additive).
 * Multi-step providers (Instagram: container → readiness → publish) expose
 * each remote step separately so the execution layer can checkpoint the
 * irreversible boundary (publication_attempts) BEFORE invoking it. The
 * adapter owns HTTP, parsing, redaction and classification only — never DB
 * access, never a retry of the publish step. Results are classified values,
 * not thrown errors. Ids are opaque, lossless strings.
 */
export type ProviderFailureDetails = {
  code: string;
  message: string;
  httpStatus: number | null;
  providerCode: number | null;
  providerSubcode: number | null;
  fbtraceId: string | null;
};

/**
 * MVP-5.36H2: `outcome` classifies a failed container creation (G1).
 * `rejected` = an authoritative structured provider rejection (4xx with the
 * Graph error envelope): no container was created. `unknown` = anything else
 * (timeout, transport error, 5xx, malformed 2xx): a container MAY exist, so
 * creation must never be repeated automatically. Absent ⇒ treat as unknown.
 */
export type MediaContainerCreateResult =
  | { ok: true; containerId: string }
  | ({ ok: false; outcome?: "rejected" | "unknown" } & ProviderFailureDetails);

export type MediaContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED" | "UNKNOWN_VALUE";

export type MediaContainerStatusResult =
  | { ok: true; status: MediaContainerStatus }
  | ({ ok: false } & ProviderFailureDetails);

/**
 * `rejected` = an authoritative structured provider rejection (known not
 * published). `unknown` = anything else once the publish request began
 * (timeout, transport error of any kind, 5xx, malformed body): the remote
 * outcome is NOT known and the step must never be repeated automatically.
 */
export type MediaPublishResult =
  | { ok: true; mediaId: string }
  | ({ ok: false; outcome: "rejected" | "unknown" } & ProviderFailureDetails);

export type RecentMediaItem = { id: string; caption: string | null; timestamp: string | null };

export type RecentMediaResult = { ok: true; items: RecentMediaItem[] } | ({ ok: false } & ProviderFailureDetails);

/** MVP-5.35C-D: every staged call accepts a per-call timeout derived from the execution deadline. */
export interface StagedMediaPublisher {
  createMediaContainer(input: {
    credential: string;
    accountId: string;
    imageUrl: string;
    caption: string | null;
    timeoutMs?: number;
  }): Promise<MediaContainerCreateResult>;
  getMediaContainerStatus(input: { credential: string; containerId: string; timeoutMs?: number }): Promise<MediaContainerStatusResult>;
  publishMediaContainer(input: { credential: string; accountId: string; containerId: string; timeoutMs?: number }): Promise<MediaPublishResult>;
  /** Read-only; reconciliation evidence only (heuristic, never auto-finalized). */
  listRecentMedia(input: { credential: string; accountId: string; timeoutMs?: number }): Promise<RecentMediaResult>;
}

/**
 * MVP-5.35C-D: the pre-publish subset. A dry run receives ONLY this — it
 * has no publishMediaContainer capability at all.
 */
export type ContainerPreparationProvider = Pick<StagedMediaPublisher, "createMediaContainer" | "getMediaContainerStatus">;

export function isStagedMediaPublisher(adapter: unknown): adapter is StagedMediaPublisher {
  const candidate = adapter as Partial<StagedMediaPublisher> | null;
  return (
    !!candidate &&
    typeof candidate.createMediaContainer === "function" &&
    typeof candidate.getMediaContainerStatus === "function" &&
    typeof candidate.publishMediaContainer === "function" &&
    typeof candidate.listRecentMedia === "function"
  );
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

  /**
   * MVP-3.1, reshaped MVP-5.10E (Decision #39): deterministic mock raw
   * response — no network call, no real provider data. Fixed values, not
   * derived by any formula (this is mock data reported "by the provider",
   * exactly as publish()'s externalPublicationId is a fabricated
   * identifier, not a computed one). Reuses
   * MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL as the same testing seam
   * publish() already uses, rather than inventing a second sentinel.
   *
   * Returns a raw, unnormalized envelope (Decision #39) — normalization
   * happens downstream, in the Analytics Normalizer
   * (src/lib/analytics/normalizers/mock-normalizer.ts), which understands
   * exactly this payload shape. `observedAt` is set (a real observation
   * time), so a default call resolves `captured_at_provenance` to
   * `"provider"` — the fallback path is exercised only by fixture
   * scenarios that omit it (see src/lib/analytics/fixtures/).
   */
  async getMetrics(input: ProviderMetricsInput): Promise<RawProviderResponse> {
    if (input.credential === MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL) {
      throw new ProviderError("Mock provider forced failure", "mock_forced_failure", {
        mock: true,
        platform: input.socialAccount.platform,
      });
    }

    return {
      provider: input.socialAccount.platform,
      observedAt: new Date().toISOString(),
      payload: {
        mock: true,
        platform: input.socialAccount.platform,
        externalPublicationId: input.externalPublicationId,
        metrics: {
          impressions: 1000,
          reach: 800,
          views: 600,
          likes: 50,
          comments: 5,
          shares: 3,
          saves: 2,
          clicks: 10,
        },
        engagementRate: 0.05,
      },
    };
  }
}
