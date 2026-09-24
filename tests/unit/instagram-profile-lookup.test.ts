import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchInstagramProfile } from "@/lib/social/instagram-adapter";
import { ProviderError } from "@/lib/social/provider";

/**
 * MVP-5.35B.3 — GET /me?fields=id,user_id,username (Model B). Raw-text
 * bodies so integer literals above Number.MAX_SAFE_INTEGER can be
 * expressed. The token is a fake sentinel and must never surface.
 */

const TOKEN = "IGAAfakeLongLivedTokenProfileLookup0001";

function stub(text: string, status = 200) {
  const fetchMock = vi.fn(async (url: string) => {
    expect(url).toContain("graph.instagram.com");
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function lookup() {
  return fetchInstagramProfile({ accessToken: TOKEN });
}

function expectNoToken(err: unknown) {
  const serialized = JSON.stringify({ message: (err as Error).message, response: (err as ProviderError).providerResponse });
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toMatch(/access_token=(?!\[REDACTED\])/);
}

describe("fetchInstagramProfile (MVP-5.35B.3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls GET graph.instagram.com/me with fields id,user_id,username", async () => {
    const fetchMock = stub('{"id":"1","user_id":"17849990000000062","username":"marqostest"}');
    await lookup();
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://graph.instagram.com/me");
    expect(url.searchParams.get("fields")).toBe("id,user_id,username");
  });

  it("preserves a string professional user_id and string app-scoped id exactly", async () => {
    stub('{"id":"38281000000004703","user_id":"17849990000000062","username":"marqos.test.account"}');
    expect(await lookup()).toEqual({
      appScopedId: "38281000000004703",
      professionalAccountId: "17849990000000062",
      username: "marqos.test.account",
    });
  });

  it("preserves large JSON-number ids byte-for-byte (no rounding, no exponent)", async () => {
    stub('{"id":38281000000004703,"user_id":17849990000000062,"username":"marqostest"}');
    const profile = await lookup();
    expect(profile.professionalAccountId).toBe("17849990000000062");
    expect(profile.appScopedId).toBe("38281000000004703");
  });

  it("accepts the documented data[] envelope", async () => {
    stub('{"data":[{"user_id":"17849990000000062","username":"marqostest"}]}');
    const profile = await lookup();
    expect(profile.professionalAccountId).toBe("17849990000000062");
    expect(profile.appScopedId).toBeUndefined();
  });

  it("treats a missing or non-string username as undefined", async () => {
    stub('{"user_id":"17849990000000062","username":12}');
    expect((await lookup()).username).toBeUndefined();
  });

  it("fails closed when the professional user_id is missing — no fallback to the app-scoped id", async () => {
    stub('{"id":"38281000000004703","username":"marqostest"}');
    await expect(lookup()).rejects.toMatchObject({ code: "missing_professional_account_id", stage: "profile_lookup" });
  });

  it("fails closed when the professional user_id cannot be preserved exactly", async () => {
    stub('{"user_id":1.7841439729341562e16}');
    await expect(lookup()).rejects.toMatchObject({ code: "unrecoverable_account_identifier", stage: "profile_lookup" });
  });

  it("drops an inexact app-scoped id instead of guessing", async () => {
    stub('{"id":3.8e16,"user_id":"17849990000000062"}');
    expect((await lookup()).appScopedId).toBeUndefined();
  });

  it("fails safely on a malformed success body", async () => {
    stub("not json");
    await expect(lookup()).rejects.toMatchObject({ code: "missing_professional_account_id", stage: "profile_lookup" });
  });

  it("normalizes a Graph error with stage profile_lookup and never leaks the token", async () => {
    stub(
      `{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190,"fbtrace_id":"Aprofile1","echo":"https://graph.instagram.com/me?access_token=${TOKEN}"}}`,
      400,
    );
    let caught: unknown;
    try {
      await lookup();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ code: "OAuthException", stage: "profile_lookup", message: "Invalid OAuth access token" });
    expectNoToken(caught);
  });
});
