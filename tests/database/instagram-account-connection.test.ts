import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveProviderAdapter } from "@/lib/social/registry";
import { InstagramProviderAdapter } from "@/lib/social/instagram-adapter";
import { MockProviderAdapter } from "@/lib/social/provider";
import { connectRealInstagramAccount, connectSocialAccount, disconnectSocialAccount } from "@/server/services/social-accounts";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * MVP-5.22 — real Instagram account connection flow
 * (connectRealInstagramAccount, src/server/services/social-accounts.ts).
 *
 * Follows the established convention (analytics-service.test.ts,
 * social-accounts-tenant-isolation.test.ts) of calling the REAL exported
 * service function against the local Supabase stack, authenticated via a
 * real signed-in test user (setTestAccessToken) — with the two real
 * Instagram HTTP calls (exchangeInstagramAuthorizationCode /
 * exchangeInstagramLongLivedToken) stubbed via a mocked global fetch, since
 * no automated test may call the real Meta API (MVP-5.22 scope rule).
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("connectRealInstagramAccount", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;

  const accountIds: string[] = [];
  const vaultSecretIds: string[] = [];

  const REAL_USER_ID = "38281000000004700"; // MVP-5.17 real evidence shape (numeric string, exceeds Number.MAX_SAFE_INTEGER)
  const REDIRECT_URI = "https://marqos-staging.netlify.app/auth/instagram/callback";

  // Captured before any vi.stubGlobal("fetch", ...) call — the mocked
  // @supabase/ssr client (tests/mocks/supabase-ssr.ts) also uses the
  // global fetch for its own REST calls against the local Supabase stack,
  // so every stub below must pass those through untouched and only
  // intercept the two Instagram token-exchange URLs.
  const realFetch = globalThis.fetch.bind(globalThis);

  // MVP-5.35B.3 (Model B): each fake token-scoped id maps to a distinct fake
  // professional account <IG_ID>, served by GET graph.instagram.com/me.
  const professionalIdFor = (userId: string) => `1784${userId.slice(4)}`;

  function mockSuccessfulExchange(userId: string = REAL_USER_ID, longLivedToken = "fake-long-lived-token-for-testing") {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://graph.instagram.com/me?")) {
        return new Response(JSON.stringify({ id: `app-${userId}`, user_id: professionalIdFor(userId), username: `handle_${userId.slice(-4)}` }), { status: 200 });
      }
      if (url.includes("api.instagram.com/oauth/access_token")) {
        return new Response(JSON.stringify({ data: [{ access_token: "fake-short-lived-token", user_id: userId, permissions: ["instagram_business_basic"] }] }), { status: 200 });
      }
      if (url.includes("graph.instagram.com/access_token")) {
        return new Response(JSON.stringify({ access_token: longLivedToken, token_type: "bearer", expires_in: 5183999 }), { status: 200 });
      }
      return realFetch(url, init);
    });
  }

  async function fetchOriginalRow(accountId: string) {
    const { data } = await admin.from("social_accounts").select("*").eq("id", accountId).single();
    return data!;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Instagram Connection Tenant",
      p_slug: `ig-connect-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Instagram Connection Tenant B",
      p_slug: `ig-connect-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const { error: memberError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (memberError) throw new Error(`Failed to add viewer to workspace: ${memberError.message}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setTestAccessToken(null);
  });

  afterAll(async () => {
    for (const id of accountIds) {
      const { data } = await admin.from("social_accounts").select("vault_secret_id").eq("id", id).maybeSingle();
      if (data?.vault_secret_id) {
        await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: data.vault_secret_id });
      }
    }
    for (const id of vaultSecretIds) {
      try {
        await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
      } catch {
        // best-effort cleanup only
      }
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId, viewer?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  async function signInAs(user: Awaited<ReturnType<typeof createSignedInTestUser>>) {
    const {
      data: { session },
    } = await user.client.auth.getSession();
    if (!session) throw new Error("Test user has no session after sign-in");
    setTestAccessToken(session.access_token);
  }

  it("1. a successful OAuth exchange creates a connected social_accounts row", async () => {
    vi.stubGlobal("fetch", mockSuccessfulExchange());
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-1", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    expect(account.platform).toBe("instagram");
    expect(account.status).toBe("connected");
    expect(account.workspace_id).toBe(workspaceId);
  });

  it("2. identity resolution (Model B): external_account_id is the professional <IG_ID> from /me; the token id is provenance", async () => {
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004701"));
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-2", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    expect(account.external_account_id).toBe(professionalIdFor("38281000000004701"));
    expect((account.metadata as Record<string, unknown>).instagramScopedUserId).toBe("38281000000004701");
    expect(account.account_handle).toBe("handle_4701");
  });

  it("3. workspace association: the row belongs to the initiating workspace, not any other", async () => {
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004702"));
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-3", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    expect(account.workspace_id).toBe(workspaceId);
    expect(account.workspace_id).not.toBe(otherWorkspaceId);
  });

  it("4. metadata carries exactly credentialKind plus the Model B identity provenance", async () => {
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004703"));
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-4", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    expect(account.metadata).toEqual({
      credentialKind: "real",
      instagramScopedUserId: "38281000000004703",
      instagramAppScopedId: "app-38281000000004703",
    });
  });

  it("5. the access token never appears anywhere in metadata (name or value)", async () => {
    const token = "super-secret-long-lived-token-value";
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004704", token));
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-5", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    const serializedMetadata = JSON.stringify(account.metadata);
    expect(serializedMetadata).not.toContain(token);
    expect(Object.keys(account.metadata).sort()).toEqual(["credentialKind", "instagramAppScopedId", "instagramScopedUserId"]);
  });

  it("6. the access token never appears anywhere in the returned SocialAccount object", async () => {
    const token = "another-secret-long-lived-token-value";
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004705", token));
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-6", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    expect(JSON.stringify(account)).not.toContain(token);
    expect(account.vault_secret_id).toBeTruthy();
  });

  it("7. reconnecting the same Instagram identity updates the existing row instead of creating a duplicate", async () => {
    const userId = "38281000000004706";
    vi.stubGlobal("fetch", mockSuccessfulExchange(userId, "first-token"));
    await signInAs(editor);
    const { account: first } = await connectRealInstagramAccount(workspaceId, { code: "test-code-7a", redirectUri: REDIRECT_URI });
    accountIds.push(first.id);

    vi.stubGlobal("fetch", mockSuccessfulExchange(userId, "second-token"));
    const { account: second } = await connectRealInstagramAccount(workspaceId, { code: "test-code-7b", redirectUri: REDIRECT_URI });

    expect(second.id).toBe(first.id);

    const { count } = await admin
      .from("social_accounts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("platform", "instagram")
      .eq("external_account_id", professionalIdFor(userId));
    expect(count).toBe(1);
  });

  it("8. a real-tagged connected account routes to InstagramProviderAdapter", async () => {
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004707"));
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-8", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    const adapter = resolveProviderAdapter(account);
    expect(adapter).toBeInstanceOf(InstagramProviderAdapter);
  });

  it("9. a manually-connected (non-real) account is unaffected — still routes to MockProviderAdapter", async () => {
    await signInAs(editor);
    const account = await connectSocialAccount(workspaceId, {
      platform: "instagram",
      externalAccountId: "manual-mock-account-1",
      accountName: "Manual Mock",
      credential: "dev-only-fixture-secret",
    });
    accountIds.push(account.id);

    expect(account.metadata).toEqual({});
    const adapter = resolveProviderAdapter(account);
    expect(adapter).toBeInstanceOf(MockProviderAdapter);
  });

  it("10. a failed OAuth exchange surfaces a safe error and creates no record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("api.instagram.com/oauth/access_token")) {
          return new Response(JSON.stringify({ error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" }), { status: 400 });
        }
        return realFetch(url, init);
      }),
    );
    await signInAs(editor);

    const { count: before } = await admin
      .from("social_accounts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("external_account_id", "should-never-exist");

    await expect(connectRealInstagramAccount(workspaceId, { code: "bad-code", redirectUri: REDIRECT_URI })).rejects.toThrow(
      /Invalid authorization code/,
    );

    const { count: after } = await admin
      .from("social_accounts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("external_account_id", "should-never-exist");
    expect(after).toBe(before);
  });

  it("11. a failed long-lived-token exchange also creates no record", async () => {
    const userId = "38281000000004708";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("api.instagram.com/oauth/access_token")) {
          return new Response(JSON.stringify({ data: [{ access_token: "short-lived", user_id: userId, permissions: [] }] }), { status: 200 });
        }
        if (url.includes("graph.instagram.com/access_token")) {
          return new Response(JSON.stringify({ error: { message: "Invalid access token", type: "IGApiException", code: 190 } }), { status: 400 });
        }
        return realFetch(url, init);
      }),
    );
    await signInAs(editor);

    await expect(connectRealInstagramAccount(workspaceId, { code: "test-code-11", redirectUri: REDIRECT_URI })).rejects.toThrow(
      /Invalid access token/,
    );

    const { data } = await admin
      .from("social_accounts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("external_account_id", userId)
      .maybeSingle();
    expect(data).toBeNull();
  });

  it("12. tenant isolation: a viewer (non-editor) cannot connect a real Instagram account", async () => {
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004709"));
    await signInAs(viewer);

    await expect(connectRealInstagramAccount(workspaceId, { code: "test-code-12", redirectUri: REDIRECT_URI })).rejects.toThrow(
      /permission/i,
    );
  });

  it("13. tenant isolation: a non-member cannot connect a real Instagram account into someone else's workspace", async () => {
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004710"));
    await signInAs(outsider);

    await expect(connectRealInstagramAccount(workspaceId, { code: "test-code-13", redirectUri: REDIRECT_URI })).rejects.toThrow();
  });

  it("14. Vault genuinely stores the real (mocked) long-lived token — not a pass-through fake", async () => {
    const token = "vault-round-trip-token-value";
    vi.stubGlobal("fetch", mockSuccessfulExchange("38281000000004711", token));
    await signInAs(editor);

    const { account } = await connectRealInstagramAccount(workspaceId, { code: "test-code-14", redirectUri: REDIRECT_URI });
    accountIds.push(account.id);

    const { data: decrypted, error } = await vaultAdmin.rpc("read_social_account_vault_secret", { p_secret_id: account.vault_secret_id });
    expect(error).toBeNull();
    expect(decrypted).toBe(token);
  });

  it("15. reconnect works after a disconnect (same row reused via the natural key)", async () => {
    const userId = "38281000000004712";
    vi.stubGlobal("fetch", mockSuccessfulExchange(userId, "pre-disconnect-token"));
    await signInAs(editor);
    const { account: connected } = await connectRealInstagramAccount(workspaceId, { code: "test-code-15a", redirectUri: REDIRECT_URI });
    accountIds.push(connected.id);

    await disconnectSocialAccount(workspaceId, connected.id);
    const disconnectedRow = await fetchOriginalRow(connected.id);
    expect(disconnectedRow.status).toBe("disconnected");
    expect(disconnectedRow.vault_secret_id).toBeNull();

    vi.stubGlobal("fetch", mockSuccessfulExchange(userId, "post-reconnect-token"));
    const { account: reconnected } = await connectRealInstagramAccount(workspaceId, { code: "test-code-15b", redirectUri: REDIRECT_URI });

    expect(reconnected.id).toBe(connected.id);
    expect(reconnected.status).toBe("connected");
    expect(reconnected.metadata).toEqual({
      credentialKind: "real",
      instagramScopedUserId: userId,
      instagramAppScopedId: `app-${userId}`,
    });
  });

  it("configuration guard: missing INSTAGRAM_CLIENT_ID/SECRET throws a clear error before any network call", async () => {
    const originalId = process.env.INSTAGRAM_CLIENT_ID;
    const originalSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    delete process.env.INSTAGRAM_CLIENT_ID;
    delete process.env.INSTAGRAM_CLIENT_SECRET;

    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must never be called when credentials are unconfigured");
    });
    vi.stubGlobal("fetch", fetchMock);
    await signInAs(editor);

    try {
      await expect(connectRealInstagramAccount(workspaceId, { code: "test-code-config", redirectUri: REDIRECT_URI })).rejects.toThrow(
        /INSTAGRAM_CLIENT_ID/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (originalId !== undefined) process.env.INSTAGRAM_CLIENT_ID = originalId;
      if (originalSecret !== undefined) process.env.INSTAGRAM_CLIENT_SECRET = originalSecret;
    }
  });
});
