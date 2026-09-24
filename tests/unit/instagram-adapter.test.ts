import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/social/provider";
import {
  InstagramProviderAdapter,
  exchangeInstagramAuthorizationCode,
  exchangeInstagramLongLivedToken,
  fetchInstagramMediaInsights,
  listInstagramMedia,
  redactInstagramAccessTokens,
} from "@/lib/social/instagram-adapter";

/**
 * MVP-5.19: fixtures below are the REAL response shapes captured in
 * MVP-5.17 (evidence/instagram/mvp-5.17-real-oauth-and-insights-capture.json)
 * and MVP-5.18 (evidence/instagram/mvp-5.18-impressions-and-rate-limit-capture.json),
 * with only the real account's specific numeric values/IDs replaced by
 * clearly-fake placeholders — the SHAPE, field names, and error text are
 * exactly as observed, not invented. The two malformed-response cases
 * (non-JSON body, missing access_token) are the only fixtures not drawn
 * from a real capture, per the task's own allowance for defensive-path
 * testing.
 */

const REAL_SHORT_LIVED_TOKEN_RESPONSE = {
  // MVP-5.17 real evidence: `permissions` is a JSON array, not the comma-
  // separated string MVP-5.16's documentation fetch had recorded — this
  // was itself a documented CONTRADICTION finding, and this fixture must
  // reflect the real shape, not the refuted documented one.
  data: [{ access_token: "IGAAfakeShortLivedTokenForTestingOnly", user_id: 38281000000004700, permissions: ["instagram_business_basic", "instagram_business_manage_insights"] }],
};

const REAL_LONG_LIVED_TOKEN_RESPONSE = {
  access_token: "IGAAfakeLongLivedTokenForTestingOnly",
  token_type: "bearer",
  expires_in: 5183999,
};

const REAL_OAUTH_ERROR_RESPONSE = {
  error_type: "OAuthException",
  code: 400,
  error_message: "Invalid authorization code",
};

const REAL_IG_API_ERROR_RESPONSE = {
  error: {
    message: "The Media Insights API does not support the impressions metric for this media product type.",
    type: "IGApiException",
    code: 100,
    fbtrace_id: "Ad3MirLamO9--4J1Ps5jaus",
  },
};

const REAL_MEDIA_LIST_RESPONSE_WITH_LIVE_TOKEN = {
  data: [
    { id: "18100000000033712", media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", timestamp: "2026-09-10T08:20:09+0000", permalink: "https://www.instagram.com/p/FAKEPOST001/" },
    { id: "18100000000516633", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-09-14T11:57:19+0000", permalink: "https://www.instagram.com/reel/FAKEREEL001/" },
  ],
  paging: {
    cursors: { before: "QVFIVEZAKESTFAKECURSOR", after: "QVFIVElFAKECURSORVALUE" },
    next: "https://graph.instagram.com/v26.0/17849990000000062/media?fields=id%2Cmedia_type&access_token=IGAAthisIsALiveFakeTokenThatMustBeRedacted1234567890&limit=25&after=QVFIVElFAKECURSORVALUE",
  },
};

const REAL_FEED_INSIGHTS_RESPONSE = {
  data: [
    { name: "reach", period: "lifetime", values: [{ value: 384 }], title: "Accounts reached" },
    { name: "likes", period: "lifetime", values: [{ value: 7 }], title: "Likes" },
    { name: "comments", period: "lifetime", values: [{ value: 0 }], title: "Comments" },
    { name: "shares", period: "lifetime", values: [{ value: 4 }], title: "Shares" },
    { name: "saved", period: "lifetime", values: [{ value: 0 }], title: "Saved" },
    { name: "views", period: "lifetime", values: [{ value: 626 }], title: "Views" },
  ],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("InstagramProviderAdapter and Instagram OAuth/Insights functions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("1. exchangeInstagramAuthorizationCode: successful token exchange", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(REAL_SHORT_LIVED_TOKEN_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeInstagramAuthorizationCode({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "https://marqos-staging.netlify.app/auth/instagram/callback",
      code: "fake-authorization-code",
    });

    expect(result.accessToken).toBe("IGAAfakeShortLivedTokenForTestingOnly");
    expect(result.userId).toBe("38281000000004700");
    expect(result.permissions).toEqual(["instagram_business_basic", "instagram_business_manage_insights"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.instagram.com/oauth/access_token");
    expect(init?.method).toBe("POST");
  });

  it("2. exchangeInstagramLongLivedToken: successful long-lived exchange, matches real ~60-day expiry", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(REAL_LONG_LIVED_TOKEN_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeInstagramLongLivedToken({
      clientSecret: "test-client-secret",
      shortLivedAccessToken: "short-lived-token",
    });

    expect(result.accessToken).toBe("IGAAfakeLongLivedTokenForTestingOnly");
    expect(result.tokenType).toBe("bearer");
    expect(result.expiresInSeconds).toBe(5183999);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("https://graph.instagram.com/access_token");
    expect(url).toContain("grant_type=ig_exchange_token");
  });

  it("3. listInstagramMedia: successful media retrieval, real media_product_type values distinguish Feed/Reel", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REAL_MEDIA_LIST_RESPONSE_WITH_LIVE_TOKEN));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listInstagramMedia({ accessToken: "fake-access-token" });

    expect(result.httpStatus).toBe(200);
    expect(result.ok).toBe(true);
    const data = (result.payload as { data: Array<{ media_product_type: string }> }).data;
    expect(data.map((item) => item.media_product_type)).toEqual(["FEED", "REELS"]);
  });

  it("4. fetchInstagramMediaInsights / InstagramProviderAdapter.getMetrics: successful Insights retrieval", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(REAL_FEED_INSIGHTS_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new InstagramProviderAdapter();
    const result = await adapter.getMetrics({
      credential: "fake-access-token",
      externalPublicationId: "18100000000033712",
      socialAccount: { platform: "instagram" } as never,
    });

    expect(result.provider).toBe("instagram");
    expect(result.observedAt).toBeNull();
    const data = (result.payload as { data: Array<{ name: string; values: Array<{ value: number }> }> }).data;
    expect(data.find((m) => m.name === "comments")?.values[0].value).toBe(0);
    expect(data.find((m) => m.name === "saved")?.values[0].value).toBe(0);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("18100000000033712/insights");
    expect(url).toContain("metric=reach%2Clikes%2Ccomments%2Cshares%2Csaved%2Cviews");
    expect(url).not.toContain("impressions");
  });

  it("5. real OAuthException-style error is thrown as ProviderError with the real shape's fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REAL_OAUTH_ERROR_RESPONSE, 400));
    vi.stubGlobal("fetch", fetchMock);

    let caught: ProviderError | null = null;
    try {
      await exchangeInstagramAuthorizationCode({
        clientId: "id",
        clientSecret: "secret",
        redirectUri: "https://example.com/callback",
        code: "invalid-code",
      });
    } catch (err) {
      caught = err as ProviderError;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught!.code).toBe("OAuthException");
    expect(caught!.message).toBe("Invalid authorization code");
  });

  it("6. real IGApiException-style error is thrown as ProviderError with the real shape's fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REAL_IG_API_ERROR_RESPONSE, 400));
    vi.stubGlobal("fetch", fetchMock);

    let caught: ProviderError | null = null;
    try {
      await fetchInstagramMediaInsights({ mediaId: "18100000000033712", accessToken: "fake", metric: "impressions" });
    } catch (err) {
      caught = err as ProviderError;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught!.code).toBe("IGApiException");
    expect(caught!.message).toBe("The Media Insights API does not support the impressions metric for this media product type.");
    expect((caught!.providerResponse as { error?: { fbtrace_id?: string } }).error?.fbtrace_id).toBe("Ad3MirLamO9--4J1Ps5jaus");
  });

  it("7. HTTP-level failure with an unrecognized/malformed body is still thrown as a ProviderError, not a crash", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchInstagramMediaInsights({ mediaId: "x", accessToken: "fake" })).rejects.toThrow(ProviderError);
  });

  it("8. paging.next containing a live access_token is redacted before the payload is returned", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REAL_MEDIA_LIST_RESPONSE_WITH_LIVE_TOKEN));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listInstagramMedia({ accessToken: "fake-access-token" });
    const serialized = JSON.stringify(result.payload);

    expect(serialized).not.toContain("IGAAthisIsALiveFakeTokenThatMustBeRedacted1234567890");
    expect(serialized).toContain("access_token=[REDACTED]");
  });

  it("9. a live access token never appears anywhere in a thrown ProviderError, even when the failing request used one", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // Simulate a provider error response that happens to echo the request URL/token back (defensive case).
      return jsonResponse({ error: { message: "failed", type: "IGApiException", code: 1, echoedUrl: url } }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const liveLookingToken = "IGAAliveTokenThatMustNeverLeak0987654321";
    let caught: ProviderError | null = null;
    try {
      await fetchInstagramMediaInsights({ mediaId: "x", accessToken: liveLookingToken });
    } catch (err) {
      caught = err as ProviderError;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const serialized = JSON.stringify({ message: caught!.message, providerResponse: caught!.providerResponse });
    expect(serialized).not.toContain(liveLookingToken);
  });

  it("10. x-app-usage header is safely captured when present, using the real observed shape", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(REAL_FEED_INSIGHTS_RESPONSE, 200, { "x-app-usage": '{"call_volume":0,"cpu_time":0}' }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchInstagramMediaInsights({ mediaId: "18100000000033712", accessToken: "fake" });
    expect(result.rateLimitHeaders["x-app-usage"]).toBe('{"call_volume":0,"cpu_time":0}');
  });

  it("11. absence of optional rate-limit headers does not cause a failure, and is recorded as absence not a guess", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REAL_FEED_INSIGHTS_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchInstagramMediaInsights({ mediaId: "18100000000033712", accessToken: "fake" });
    expect(result.ok).toBe(true);
    expect(result.rateLimitHeaders).toEqual({});
  });

  it("redactInstagramAccessTokens: leaves non-token strings and nested structures untouched", () => {
    const input = { a: "no token here", b: { c: ["fine", "also fine"] } };
    expect(redactInstagramAccessTokens(input)).toEqual(input);
  });

  it("InstagramProviderAdapter.publish: throws rather than fabricating a publish success (not evidenced this session)", async () => {
    const adapter = new InstagramProviderAdapter();
    await expect(
      adapter.publish({
        credential: "fake",
        idempotencyKey: "k",
        variant: {} as never,
        socialAccount: { platform: "instagram" } as never,
      }),
    ).rejects.toThrow(/not implemented/i);
  });
});
