import { afterEach, describe, expect, it, vi } from "vitest";

import { exchangeInstagramAuthorizationCode } from "@/lib/social/instagram-adapter";
import { ProviderError } from "@/lib/social/provider";

/**
 * MVP-5.35B.1 — lossless Instagram user id. Instagram's token exchange
 * returns `user_id` as a raw JSON number (MVP-5.17 evidence). Bodies here
 * are RAW TEXT, not JSON.stringify output, because JSON.stringify cannot
 * even express an integer above Number.MAX_SAFE_INTEGER exactly — which is
 * precisely the bug being fixed. Tokens are fake sentinels.
 */

const TOKEN = "IGAAfakeShortLivedTokenSentinelLossless0001";
const SECRET = "fake-client-secret-lossless-0002";
const CODE = "AQDfakeCodeLossless0003";

function rawResponse(text: string, status = 200) {
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

function tokenBody(userIdLiteral: string) {
  return `{"data":[{"access_token":"${TOKEN}","user_id":${userIdLiteral},"permissions":["instagram_business_basic"]}]}`;
}

async function exchange(text: string, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => rawResponse(text, status)));
  return exchangeInstagramAuthorizationCode({
    clientId: "9990000000000001",
    clientSecret: SECRET,
    redirectUri: "https://marqos-staging.netlify.app/auth/instagram/callback",
    code: CODE,
  });
}

describe("MVP-5.35B.1 lossless Instagram user id", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("demonstrates the root cause: plain JSON parsing rounds an id above MAX_SAFE_INTEGER", () => {
    const parsed = JSON.parse('{"user_id":38281000000004703}') as { user_id: number };
    expect(38281000000004703 > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(String(parsed.user_id)).not.toBe("38281000000004703");
    // The rounded double prints in shortest form — the same trailing-"00" shape
    // as the id persisted on staging by the old code path.
    expect(String(parsed.user_id)).toBe("38281000000004700");
    // Several distinct provider ids collapse to that one string.
    expect(String(JSON.parse("38281000000004708"))).toBe("38281000000004700");
    expect(String(JSON.parse("38281000000004701"))).toBe("38281000000004700");
  });

  it("preserves a numeric user_id above MAX_SAFE_INTEGER byte-for-byte", async () => {
    const result = await exchange(tokenBody("38281000000004703"));
    expect(result.userId).toBe("38281000000004703");
    expect(typeof result.userId).toBe("string");
  });

  it("preserves an Instagram-professional-account-sized id exactly", async () => {
    const result = await exchange(tokenBody("17849990000000062"));
    expect(result.userId).toBe("17849990000000062");
  });

  it("never produces scientific notation or rounding for very large ids", async () => {
    const huge = "123456789012345678901234567890";
    const result = await exchange(tokenBody(huge));
    expect(result.userId).toBe(huge);
    expect(result.userId).not.toMatch(/e|E|\./);
  });

  it("keeps string-form ids exact", async () => {
    const result = await exchange(tokenBody('"98765432109876543210"'));
    expect(result.userId).toBe("98765432109876543210");
  });

  it("keeps small numeric ids compatible", async () => {
    const result = await exchange(tokenBody("12345"));
    expect(result.userId).toBe("12345");
  });

  it("rejects a non-integer literal id instead of persisting a guess, without leaking the token", async () => {
    let caught: unknown;
    try {
      await exchange(tokenBody("3.8281000000004703e16"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe("unrecoverable_account_identifier");
    expect((caught as ProviderError).stage).toBe("short_lived_exchange");
    const serialized = JSON.stringify({ message: (caught as Error).message, response: (caught as ProviderError).providerResponse });
    for (const sentinel of [TOKEN, SECRET, CODE]) expect(serialized).not.toContain(sentinel);
  });

  it("malformed success body keeps the existing safe no_access_token_in_response behavior", async () => {
    await expect(exchange("not json")).rejects.toMatchObject({ code: "no_access_token_in_response", stage: "short_lived_exchange" });
  });

  it("malformed error body keeps the existing unknown_error_shape behavior", async () => {
    await expect(exchange("<html>bad gateway</html>", 502)).rejects.toMatchObject({ code: "unknown_error_shape", stage: "short_lived_exchange" });
  });

  it("OAuth error bodies still parse into the stage-tagged provider error", async () => {
    await expect(
      exchange('{"error_type":"OAuthException","code":400,"error_message":"Invalid authorization code"}', 400),
    ).rejects.toMatchObject({ code: "OAuthException", message: "Invalid authorization code", stage: "short_lived_exchange" });
  });

  it("a missing user_id stays undefined (caller rejects it as before)", async () => {
    const result = await exchange(`{"data":[{"access_token":"${TOKEN}","permissions":[]}]}`);
    expect(result.userId).toBeUndefined();
  });
});
