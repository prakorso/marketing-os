import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exchangeInstagramAuthorizationCode, exchangeInstagramLongLivedToken, toSafeInstagramOAuthDiagnostics } from "@/lib/social/instagram-adapter";
import { ProviderError } from "@/lib/social/provider";

/**
 * MVP-5.34A — Instagram OAuth safe observability. Exercises the REAL
 * callback route and connectRealInstagramAccount with the two Meta token
 * endpoints stubbed via global fetch (no automated test may call Meta),
 * and with the workspace/Supabase layers faked so no database is touched.
 * Every sentinel below is a fake value that must never appear in the
 * callback response body or in any console output.
 */

const AUTH_CODE = "AQDfakeAuthorizationCodeSentinel_0001";
const SHORT_LIVED_TOKEN = "IGAAfakeShortLivedTokenSentinel0000000000002";
const LONG_LIVED_TOKEN = "IGAAfakeLongLivedTokenSentinel00000000000003";
const CLIENT_SECRET = "fake-client-secret-sentinel-0004";
const VAULT_SECRET_ID = "5e1f0000-fake-vault-secret-id-000000000005";
const SENTINELS = [AUTH_CODE, SHORT_LIVED_TOKEN, LONG_LIVED_TOKEN, CLIENT_SECRET, VAULT_SECRET_ID];

const CALLBACK_URL = `https://marqos-staging.netlify.app/auth/instagram/callback?code=${AUTH_CODE}&state=test-workspace`;

// Fakes for the persistence layer — only reached by the Vault/DB cases.
const db = vi.hoisted(() => ({
  vaultResult: { data: null as string | null, error: null as { message: string } | null },
  insertResult: { data: null as unknown, error: null as { message: string; code?: string } | null },
  // MVP-5.35B.3: spies proving persistence order and payload.
  vaultCalls: 0,
  inserted: [] as Record<string, unknown>[],
}));

vi.mock("@/server/services/workspaces", () => ({
  getWorkspaceBySlug: vi.fn(async () => ({ id: "workspace-1", slug: "test-workspace" })),
  getCurrentUserRole: vi.fn(async () => "owner"),
}));

vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => ({
    rpc: vi.fn(async () => {
      db.vaultCalls += 1;
      return db.vaultResult;
    }),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    // The client itself must NOT be thenable (it is awaited from an async
    // createClient()); only the query builder resolves like PostgREST.
    const chain: Record<string, unknown> = {};
    const client = { from: () => chain };
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.is = () => chain;
    chain.in = () => chain;
    chain.insert = (row: Record<string, unknown>) => {
      db.inserted.push(row);
      return chain;
    };
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.single = async () => db.insertResult;
    // List queries (legacy-candidate lookup) are awaited directly: no rows.
    chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
    return client;
  },
}));

const { GET } = await import("@/app/auth/instagram/callback/route");

type FetchStub = {
  shortLived: Response | (() => Response);
  longLived?: Response | (() => Response);
  profile?: Response | (() => Response);
};

const PROFESSIONAL_ACCOUNT_ID = "17849990000000062";
const profileSuccess = () =>
  new Response(`{"id":"38281000000004701","user_id":${PROFESSIONAL_ACCOUNT_ID},"username":"marqos.test.account"}`, {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubMetaEndpoints(stub: FetchStub) {
  const fetchMock = vi.fn(async (url: string) => {
    const pick = (r: Response | (() => Response) | undefined) => (typeof r === "function" ? r() : r);
    if (url.startsWith("https://api.instagram.com/oauth/access_token")) return pick(stub.shortLived)!;
    if (url.startsWith("https://graph.instagram.com/access_token")) return pick(stub.longLived)!;
    if (url.startsWith("https://graph.instagram.com/me?")) return pick(stub.profile ?? profileSuccess)!;
    throw new Error(`Unexpected fetch in test: ${new URL(url).host}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const PUBLISH_SCOPE_SET = ["instagram_business_basic", "instagram_business_manage_insights", "instagram_business_content_publish"];

const shortLivedWithPermissions = (permissions: unknown[]) => () =>
  jsonResponse({ data: [{ access_token: SHORT_LIVED_TOKEN, user_id: 38281000000004700, permissions }] });

// What the DB returns after persistence — includes vault_secret_id, which the callback must never echo.
const persistedRow = () => ({
  id: "social-account-1",
  workspace_id: "workspace-1",
  platform: "instagram",
  external_account_id: PROFESSIONAL_ACCOUNT_ID,
  account_name: "marqos.test.account",
  account_handle: "marqos.test.account",
  status: "connected",
  vault_secret_id: VAULT_SECRET_ID,
  metadata: { credentialKind: "real", instagramScopedUserId: "38281000000004700", instagramAppScopedId: "38281000000004701" },
});

const shortLivedSuccess = () =>
  jsonResponse({
    data: [{ access_token: SHORT_LIVED_TOKEN, user_id: 38281000000004700, permissions: ["instagram_business_basic", "instagram_business_manage_insights"] }],
  });

async function runCallback() {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  const res = await GET(new Request(CALLBACK_URL, { headers: { host: "marqos-staging.netlify.app" } }));
  const body = (await res.json()) as Record<string, unknown>;
  const logged = JSON.stringify([...errorSpy.mock.calls, ...infoSpy.mock.calls]);
  return { res, body, logged, errorSpy, infoSpy };
}

function expectNoSentinels(...outputs: string[]) {
  for (const output of outputs) {
    for (const sentinel of SENTINELS) expect(output).not.toContain(sentinel);
    // A request URL may only ever surface with its credential params already redacted.
    expect(output).not.toMatch(/(?:client_secret|access_token|code)=(?!\[REDACTED\])/);
  }
}

describe("MVP-5.34A Instagram OAuth safe observability", () => {
  beforeEach(() => {
    vi.stubEnv("INSTAGRAM_CLIENT_ID", "9990000000000001");
    vi.stubEnv("INSTAGRAM_CLIENT_SECRET", CLIENT_SECRET);
    db.vaultResult = { data: null, error: null };
    db.insertResult = { data: null, error: null };
    db.vaultCalls = 0;
    db.inserted = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("short-lived exchange OAuthException is identified as providerStage=short_lived_exchange", async () => {
    stubMetaEndpoints({
      shortLived: jsonResponse({ error_type: "OAuthException", code: 400, error_message: "API access blocked." }, 400),
    });

    const { res, body, logged } = await runCallback();

    expect(res.status).toBe(502);
    expect(body).toEqual({
      status: "error",
      stage: "connection",
      providerStage: "short_lived_exchange",
      error: "OAuthException",
      message: "API access blocked.",
      httpStatus: 400,
      providerCode: 400,
      providerSubcode: null,
      fbtraceId: null,
    });
    expect(logged).toContain("short_lived_exchange");
    expectNoSentinels(JSON.stringify(body), logged);
  });

  it("long-lived exchange OAuthException is identified as providerStage=long_lived_exchange, with safe Meta fields preserved", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedSuccess,
      longLived: jsonResponse(
        { error: { message: "API access blocked.", type: "OAuthException", code: 200, error_subcode: 2207050, fbtrace_id: "AfakeTraceId123" } },
        403,
      ),
    });

    const { body, logged } = await runCallback();

    expect(body).toEqual({
      status: "error",
      stage: "connection",
      providerStage: "long_lived_exchange",
      error: "OAuthException",
      message: "API access blocked.",
      httpStatus: 403,
      providerCode: 200,
      providerSubcode: 2207050,
      fbtraceId: "AfakeTraceId123",
    });
    expectNoSentinels(JSON.stringify(body), logged);
  });

  it("granted permission names are observable after a successful short-lived exchange, without the token", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedSuccess,
      longLived: jsonResponse({ error: { message: "blocked", type: "OAuthException", code: 200 } }, 400),
    });

    const { logged, infoSpy } = await runCallback();

    expect(infoSpy).toHaveBeenCalledWith(
      '[instagram-oauth] short_lived_exchange succeeded {"grantedPermissions":["instagram_business_basic","instagram_business_manage_insights"]}',
    );
    expectNoSentinels(logged);
  });

  it("MVP-5.34I: a successful callback returns grantedPermissions (names only), including content_publish when granted", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedWithPermissions(PUBLISH_SCOPE_SET),
      longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }),
    });
    db.vaultResult = { data: VAULT_SECRET_ID, error: null };
    db.insertResult = { data: persistedRow(), error: null };

    const { res, body, logged } = await runCallback();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "connected",
      platform: "instagram",
      socialAccountId: "social-account-1",
      externalAccountId: PROFESSIONAL_ACCOUNT_ID,
      workspaceSlug: "test-workspace",
      grantedPermissions: PUBLISH_SCOPE_SET,
    });
    expect(body.grantedPermissions).toContain("instagram_business_content_publish");
    // No token, code, client secret, Vault value/id, or raw provider response in the body or logs.
    expectNoSentinels(JSON.stringify(body), logged);
    expect(JSON.stringify(body)).not.toMatch(/access_token|user_id|vault_secret_id|"data"/);
  });

  it("MVP-5.34I: only values passing safeGrantedPermissionNames survive into the success body", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedWithPermissions([
        "instagram_business_basic",
        "Instagram_Business_Basic",
        "instagram business",
        SHORT_LIVED_TOKEN,
        42,
        null,
        { name: "instagram_business_content_publish" },
        "instagram_business_content_publish",
      ]),
      longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }),
    });
    db.vaultResult = { data: VAULT_SECRET_ID, error: null };
    db.insertResult = { data: persistedRow(), error: null };

    const { body, logged } = await runCallback();

    expect(body.grantedPermissions).toEqual(["instagram_business_basic", "instagram_business_content_publish"]);
    expectNoSentinels(JSON.stringify(body), logged);
  });

  it("MVP-5.34I: the success log is exactly one string argument carrying names only", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedWithPermissions(PUBLISH_SCOPE_SET),
      longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }),
    });
    db.vaultResult = { data: VAULT_SECRET_ID, error: null };
    db.insertResult = { data: persistedRow(), error: null };

    const { infoSpy, errorSpy, logged } = await runCallback();

    const oauthLogs = infoSpy.mock.calls.filter((args) => String(args[0]).startsWith("[instagram-oauth]"));
    expect(oauthLogs).toHaveLength(1);
    expect(oauthLogs[0]).toHaveLength(1);
    expect(typeof oauthLogs[0][0]).toBe("string");
    expect(oauthLogs[0][0]).not.toContain("\n");
    for (const scope of PUBLISH_SCOPE_SET) expect(oauthLogs[0][0]).toContain(scope);
    expect(errorSpy).not.toHaveBeenCalled();
    expectNoSentinels(logged);
  });

  it("does not expose the code, tokens, client secret, or request URL even when Meta echoes them back", async () => {
    const echoed = `echo code=${AUTH_CODE} client_secret=${CLIENT_SECRET} token ${SHORT_LIVED_TOKEN} url https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${CLIENT_SECRET}&access_token=${SHORT_LIVED_TOKEN}`;
    stubMetaEndpoints({
      shortLived: shortLivedSuccess,
      longLived: jsonResponse({ error: { message: echoed, type: "OAuthException", code: 190, fbtrace_id: `trace-${LONG_LIVED_TOKEN}` } }, 400),
    });

    const { body, logged } = await runCallback();

    expect(body.providerStage).toBe("long_lived_exchange");
    expectNoSentinels(JSON.stringify(body), logged);
  });

  it("a Vault storage failure exposes neither the long-lived token (the Vault value) nor Meta request data", async () => {
    stubMetaEndpoints({ shortLived: shortLivedSuccess, longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }) });
    db.vaultResult = { data: null, error: { message: "vault unavailable" } };

    const { body, logged } = await runCallback();

    expect(body).toMatchObject({ stage: "connection", providerStage: null, error: "connection_failed" });
    expect(body.message).toMatch(/Failed to store credential in Vault/);
    expectNoSentinels(JSON.stringify(body), logged);
  });

  it("a social_accounts write failure after Vault storage exposes neither the Vault secret id nor the token", async () => {
    stubMetaEndpoints({ shortLived: shortLivedSuccess, longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }) });
    db.vaultResult = { data: VAULT_SECRET_ID, error: null };
    db.insertResult = { data: null, error: { message: "permission denied for table social_accounts" } };

    const { body, logged } = await runCallback();

    expect(body).toMatchObject({ providerStage: null, error: "connection_failed" });
    expect(body.message).toMatch(/Failed to connect social account/);
    expectNoSentinels(JSON.stringify(body), logged);
  });

  it("MVP-5.35B.3: persists Model B identity (professional <IG_ID>, scoped-id provenance, handle) and returns only the <IG_ID>", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedWithPermissions(PUBLISH_SCOPE_SET),
      longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }),
    });
    db.vaultResult = { data: VAULT_SECRET_ID, error: null };
    db.insertResult = { data: persistedRow(), error: null };

    const { body, logged } = await runCallback();

    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      platform: "instagram",
      external_account_id: PROFESSIONAL_ACCOUNT_ID,
      account_handle: "marqos.test.account",
      metadata: { credentialKind: "real", instagramScopedUserId: "38281000000004700", instagramAppScopedId: "38281000000004701" },
    });
    expect(body.externalAccountId).toBe(PROFESSIONAL_ACCOUNT_ID);
    // Provenance ids never reach the browser.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("38281000000004700");
    expect(serialized).not.toContain("38281000000004701");
    expect(serialized).not.toMatch(/instagramScopedUserId|instagramAppScopedId|metadata/);
    expectNoSentinels(serialized, logged);
  });

  it("MVP-5.35B.3: a profile_lookup failure is stage-tagged and nothing is persisted (no Vault secret, no row)", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedSuccess,
      longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }),
      profile: jsonResponse({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190, fbtrace_id: "Aprof" } }, 400),
    });

    const { res, body, logged } = await runCallback();

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ stage: "connection", providerStage: "profile_lookup", error: "OAuthException", providerCode: 190, fbtraceId: "Aprof" });
    expect(db.vaultCalls).toBe(0);
    expect(db.inserted).toHaveLength(0);
    expectNoSentinels(JSON.stringify(body), logged);
  });

  it("MVP-5.35B.3: a missing professional id fails closed before any persistence", async () => {
    stubMetaEndpoints({
      shortLived: shortLivedSuccess,
      longLived: jsonResponse({ access_token: LONG_LIVED_TOKEN, token_type: "bearer", expires_in: 5183999 }),
      profile: jsonResponse({ id: "38281000000004701", username: "marqostest" }),
    });

    const { body } = await runCallback();

    expect(body).toMatchObject({ providerStage: "profile_lookup", error: "missing_professional_account_id" });
    expect(db.vaultCalls).toBe(0);
    expect(db.inserted).toHaveLength(0);
  });

  it("the diagnostic shape is an explicit allowlist — extra providerResponse fields never pass through", () => {
    const err = new ProviderError(
      "blocked",
      "OAuthException",
      { httpStatus: 400, error: { type: "OAuthException", code: 1, fbtrace_id: "t", unexpected: "leak" }, extra: "leak" },
      "short_lived_exchange",
    );

    const diagnostics = toSafeInstagramOAuthDiagnostics(err);

    expect(Object.keys(diagnostics).sort()).toEqual(
      ["error", "fbtraceId", "httpStatus", "message", "providerCode", "providerStage", "providerSubcode", "stage"].sort(),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("leak");
  });

  it("the adapter exchange functions tag their own ProviderErrors directly", async () => {
    stubMetaEndpoints({
      shortLived: () => jsonResponse({ error_type: "OAuthException", code: 400, error_message: "x" }, 400),
      longLived: () => jsonResponse({ error: { message: "y", type: "OAuthException", code: 190 } }, 400),
    });

    await expect(
      exchangeInstagramAuthorizationCode({ clientId: "id", clientSecret: CLIENT_SECRET, redirectUri: "https://example.com/cb", code: AUTH_CODE }),
    ).rejects.toMatchObject({ stage: "short_lived_exchange", code: "OAuthException" });
    await expect(exchangeInstagramLongLivedToken({ clientSecret: CLIENT_SECRET, shortLivedAccessToken: SHORT_LIVED_TOKEN })).rejects.toMatchObject({
      stage: "long_lived_exchange",
      code: "OAuthException",
    });
  });
});
