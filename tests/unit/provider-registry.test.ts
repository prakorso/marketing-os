import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveNormalizer } from "@/lib/analytics/normalizer-registry";
import { normalizeInstagramProviderResponse } from "@/lib/analytics/normalizers/instagram-normalizer";
import { normalizeMockProviderResponse } from "@/lib/analytics/normalizers/mock-normalizer";
import { InstagramProviderAdapter } from "@/lib/social/instagram-adapter";
import { MockProviderAdapter } from "@/lib/social/provider";
import { REAL_CREDENTIAL_METADATA_KEY, REAL_CREDENTIAL_METADATA_VALUE, resolveProviderAdapter, usesRealProviderCredential } from "@/lib/social/registry";
import type { SocialAccount } from "@/types/database";

/**
 * MVP-5.21: provider-routing tests. `resolveProviderAdapter` is pure and
 * synchronous (no I/O of its own) — these tests verify routing decisions
 * directly, and separately prove (test 5) that the mock path never
 * reaches the network, using the exact real-evidence-derived fixture
 * already established in MVP-5.20's normalizer tests for the end-to-end
 * check.
 */

function account(overrides: Partial<Pick<SocialAccount, "platform" | "metadata">> = {}): Pick<SocialAccount, "platform" | "metadata"> {
  return { platform: "instagram", metadata: {}, ...overrides };
}

describe("resolveProviderAdapter — routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("1. real Instagram credential/context (metadata.credentialKind = 'real') resolves to InstagramProviderAdapter", () => {
    const adapter = resolveProviderAdapter(account({ metadata: { [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE } }));
    expect(adapter).toBeInstanceOf(InstagramProviderAdapter);
  });

  it("2. mock/fixture context (empty metadata — the default for every account today) resolves to MockProviderAdapter", () => {
    const adapter = resolveProviderAdapter(account({ metadata: {} }));
    expect(adapter).toBeInstanceOf(MockProviderAdapter);
  });

  it("3. the real Instagram path never accidentally resolves to MockProviderAdapter", () => {
    const adapter = resolveProviderAdapter(account({ metadata: { [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE } }));
    expect(adapter).not.toBeInstanceOf(MockProviderAdapter);
  });

  it("4. the mock/fixture path never accidentally resolves to InstagramProviderAdapter", () => {
    const adapter = resolveProviderAdapter(account({ metadata: {} }));
    expect(adapter).not.toBeInstanceOf(InstagramProviderAdapter);

    // Also: a near-miss metadata shape (wrong key, wrong value, null) must
    // never be mistaken for the real marker.
    expect(resolveProviderAdapter(account({ metadata: { credentialKind: "mock" } }))).not.toBeInstanceOf(InstagramProviderAdapter);
    expect(resolveProviderAdapter(account({ metadata: { somethingElse: "real" } }))).not.toBeInstanceOf(InstagramProviderAdapter);
    expect(resolveProviderAdapter(account({ metadata: null as never }))).not.toBeInstanceOf(InstagramProviderAdapter);
  });

  it("4b. other platforms are entirely unaffected by the metadata flag — only 'instagram' is routed per-account", () => {
    const adapter = resolveProviderAdapter({ platform: "tiktok", metadata: { [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE } });
    expect(adapter).toBeInstanceOf(MockProviderAdapter);
  });

  it("5. the mock path never makes a real network call", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must never be called for the mock provider path");
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = resolveProviderAdapter(account({ metadata: {} }));
    const result = await adapter.getMetrics({
      credential: "dev-only-fixture-secret",
      externalPublicationId: "ext-1",
      socialAccount: account() as SocialAccount,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.payload).toBeDefined();
  });

  it("6. the Instagram normalizer registry resolution remains correct", () => {
    expect(resolveNormalizer("instagram")).toBe(normalizeInstagramProviderResponse);
    expect(resolveNormalizer("tiktok")).toBe(normalizeMockProviderResponse);
  });

  it("usesRealProviderCredential: exact matches only, no partial/loose truthiness", () => {
    expect(usesRealProviderCredential({ [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE })).toBe(true);
    expect(usesRealProviderCredential({})).toBe(false);
    expect(usesRealProviderCredential(null)).toBe(false);
    expect(usesRealProviderCredential(undefined)).toBe(false);
    expect(usesRealProviderCredential({ [REAL_CREDENTIAL_METADATA_KEY]: "REAL" })).toBe(false);
  });
});

describe("End-to-end: real routing -> InstagramProviderAdapter -> RawProviderResponse -> InstagramNormalizer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Real evidence (MVP-5.17): Feed/CAROUSEL_ALBUM Insights response.
  const REAL_FEED_INSIGHTS_RESPONSE = {
    data: [
      { name: "reach", period: "lifetime", values: [{ value: 384 }] },
      { name: "likes", period: "lifetime", values: [{ value: 7 }] },
      { name: "comments", period: "lifetime", values: [{ value: 0 }] },
      { name: "shares", period: "lifetime", values: [{ value: 4 }] },
      { name: "saved", period: "lifetime", values: [{ value: 0 }] },
      { name: "views", period: "lifetime", values: [{ value: 626 }] },
    ],
  };

  it("a real-credential-tagged account flows through InstagramProviderAdapter and InstagramNormalizer end-to-end, using only mocked HTTP", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(REAL_FEED_INSIGHTS_RESPONSE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const socialAccount = account({ metadata: { [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE } }) as SocialAccount;

    // 1. Routing selects the real adapter.
    const adapter = resolveProviderAdapter(socialAccount);
    expect(adapter).toBeInstanceOf(InstagramProviderAdapter);

    // 2. The real adapter fetches (mocked HTTP only) and returns a raw response.
    const rawResponse = await adapter.getMetrics({
      credential: "fake-long-lived-token-for-testing",
      externalPublicationId: "18100000000033712",
      socialAccount,
    });
    expect(rawResponse.provider).toBe("instagram");
    expect(rawResponse.observedAt).toBeNull();

    // 3. Normalizer dispatch (by the raw response's own provider field, not an assumption) selects the Instagram normalizer.
    const normalize = resolveNormalizer(rawResponse.provider);
    expect(normalize).toBe(normalizeInstagramProviderResponse);

    // 4. Normalization produces canonical Marqos metrics matching real evidence exactly.
    const observation = normalize(rawResponse, { collectedAt: "2026-01-01T00:00:00.000Z" });
    expect(observation.metrics).toEqual({
      impressions: null,
      reach: 384,
      views: 626,
      likes: 7,
      comments: 0,
      shares: 4,
      saves: 0,
      clicks: null,
    });
    expect(observation.metricStates.impressions.state).toBe("unsupported");
    expect(observation.metricStates.reach.state).toBe("reported");
    expect(observation.capturedAtProvenance).toBe("marqos_fallback");

    // Never a live/real network call — only the stubbed fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("18100000000033712/insights");
  });
});
