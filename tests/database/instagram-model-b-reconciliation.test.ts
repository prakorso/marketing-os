import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { connectRealInstagramAccount } from "@/server/services/social-accounts";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * MVP-5.35B.3 — Model B legacy reconciliation (compatibility-only).
 *
 * Before Model B, external_account_id held the token-scoped Instagram id as
 * String() of a JSON-parsed (rounded) number — e.g. "38281000000004700" for
 * any exact id …700–…708. A reconnect must migrate THAT row in place to the
 * professional <IG_ID>, never create a duplicate, and fail closed on
 * ambiguity or collision. Real local Supabase; Meta calls are stubbed.
 */
describe.skipIf(!hasLocalSupabase)("connectRealInstagramAccount — Model B legacy reconciliation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const realFetch = globalThis.fetch.bind(globalThis);
  const LEGACY_RENDERING = "38281000000004700";
  const REDIRECT_URI = "https://marqos-staging.netlify.app/auth/instagram/callback";

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  const workspaceIds: string[] = [];

  function stubMeta(opts: { tokenUserId: string; professionalId: string; profileStatus?: number }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("api.instagram.com/oauth/access_token")) {
          // Raw text: the token id is an unquoted integer literal, as Instagram sends it.
          return new Response(
            `{"data":[{"access_token":"fake-short","user_id":${opts.tokenUserId},"permissions":["instagram_business_basic"]}]}`,
            { status: 200 },
          );
        }
        if (url.includes("graph.instagram.com/access_token")) {
          return new Response(JSON.stringify({ access_token: "fake-long", token_type: "bearer", expires_in: 5183999 }), { status: 200 });
        }
        if (url.startsWith("https://graph.instagram.com/me?")) {
          if (opts.profileStatus && opts.profileStatus !== 200) {
            return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }), {
              status: opts.profileStatus,
            });
          }
          return new Response(`{"id":"app-${opts.tokenUserId}","user_id":${opts.professionalId},"username":"marqos.test.account"}`, { status: 200 });
        }
        return realFetch(url, init);
      }),
    );
  }

  async function newWorkspace(): Promise<string> {
    const { data, error } = await editor.client.rpc("create_workspace", {
      p_name: "Model B Reconciliation",
      p_slug: `model-b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
    if (error || !data) throw new Error(`workspace: ${error?.message}`);
    workspaceIds.push(data.id);
    return data.id;
  }

  async function insertRow(workspaceId: string, externalAccountId: string, metadata: Record<string, unknown> = { credentialKind: "real" }) {
    const { data, error } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: externalAccountId,
        account_name: `Instagram ${externalAccountId}`,
        status: "connected",
        metadata,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`row: ${error?.message}`);
    return data;
  }

  async function instagramRows(workspaceId: string) {
    const { data } = await admin
      .from("social_accounts")
      .select("id, external_account_id, account_handle, metadata, vault_secret_id, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("platform", "instagram")
      .order("created_at");
    return data ?? [];
  }

  async function signIn() {
    const {
      data: { session },
    } = await editor.client.auth.getSession();
    setTestAccessToken(session!.access_token);
  }

  async function connect(workspaceId: string, code = "code") {
    await signIn();
    return connectRealInstagramAccount(workspaceId, { code, redirectUri: REDIRECT_URI });
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setTestAccessToken(null);
  });

  afterAll(async () => {
    await cleanupTestData(admin, { workspaceIds, userIds: [editor?.userId].filter((id): id is string => Boolean(id)) });
  });

  it("legacy …700 + exact token …700 → the SAME row is migrated to the professional <IG_ID>", async () => {
    const ws = await newWorkspace();
    const legacy = await insertRow(ws, LEGACY_RENDERING, { credentialKind: "real", unrelatedKey: "kept" });
    stubMeta({ tokenUserId: "38281000000004700", professionalId: "17849990000000062" });

    const { account } = await connect(ws);

    expect(account.id).toBe(legacy.id);
    expect(account.external_account_id).toBe("17849990000000062");
    expect(account.account_handle).toBe("marqos.test.account");
    expect(account.metadata).toEqual({
      credentialKind: "real",
      unrelatedKey: "kept",
      instagramScopedUserId: "38281000000004700",
      instagramAppScopedId: "app-38281000000004700",
    });
    expect(account.vault_secret_id).toBeTruthy();
    expect(await instagramRows(ws)).toHaveLength(1);
  });

  it("legacy …700 + exact tokens …701 through …708 each reconcile to the legacy row (old Number→String rendering)", async () => {
    for (let suffix = 1; suffix <= 8; suffix += 1) {
      const ws = await newWorkspace();
      const legacy = await insertRow(ws, LEGACY_RENDERING);
      const tokenUserId = `3828100000000470${suffix}`;
      stubMeta({ tokenUserId, professionalId: `1784999000000006${suffix}` });

      const { account } = await connect(ws, `code-${suffix}`);

      expect(account.id).toBe(legacy.id);
      expect(account.external_account_id).toBe(`1784999000000006${suffix}`);
      expect((account.metadata as Record<string, unknown>).instagramScopedUserId).toBe(tokenUserId);
      const rows = await instagramRows(ws);
      expect(rows).toHaveLength(1);
      expect(rows.some((row) => row.external_account_id === LEGACY_RENDERING)).toBe(false);
    }
  });

  it("reconnect after migration is idempotent (same row, still one row)", async () => {
    const ws = await newWorkspace();
    const legacy = await insertRow(ws, LEGACY_RENDERING);
    stubMeta({ tokenUserId: "38281000000004703", professionalId: "17849990000000062" });
    await connect(ws, "first");
    const { account } = await connect(ws, "second");

    expect(account.id).toBe(legacy.id);
    expect(account.external_account_id).toBe("17849990000000062");
    expect(await instagramRows(ws)).toHaveLength(1);
  });

  it("a different Instagram account creates a separate row and leaves the legacy row untouched", async () => {
    const ws = await newWorkspace();
    const legacy = await insertRow(ws, LEGACY_RENDERING);
    stubMeta({ tokenUserId: "44444444444444444", professionalId: "17840000000000001" });

    const { account } = await connect(ws);

    expect(account.id).not.toBe(legacy.id);
    const rows = await instagramRows(ws);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === legacy.id)!.external_account_id).toBe(LEGACY_RENDERING);
  });

  it("a legacy row in a different workspace is never reconciled", async () => {
    const wsA = await newWorkspace();
    const wsB = await newWorkspace();
    const legacyB = await insertRow(wsB, LEGACY_RENDERING);
    stubMeta({ tokenUserId: "38281000000004700", professionalId: "17849990000000062" });

    const { account } = await connect(wsA);

    expect(account.workspace_id).toBe(wsA);
    expect(account.id).not.toBe(legacyB.id);
    const rowsB = await instagramRows(wsB);
    expect(rowsB).toEqual([expect.objectContaining({ id: legacyB.id, external_account_id: LEGACY_RENDERING })]);
  });

  it("a mock (non-real) account with a matching id is never reconciled", async () => {
    const ws = await newWorkspace();
    const mock = await insertRow(ws, LEGACY_RENDERING, {});
    stubMeta({ tokenUserId: "38281000000004700", professionalId: "17849990000000062" });

    const { account } = await connect(ws);

    expect(account.id).not.toBe(mock.id);
    const rows = await instagramRows(ws);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === mock.id)!.metadata).toEqual({});
  });

  it("ambiguous legacy candidates fail closed with no mutation", async () => {
    const ws = await newWorkspace();
    await insertRow(ws, LEGACY_RENDERING);
    await insertRow(ws, "38281000000004703");
    const before = await instagramRows(ws);
    stubMeta({ tokenUserId: "38281000000004703", professionalId: "17849990000000062" });

    await expect(connect(ws)).rejects.toThrow(/ambiguous/);

    expect(await instagramRows(ws)).toEqual(before);
  });

  it("a professional-id collision fails closed with no mutation", async () => {
    const ws = await newWorkspace();
    await insertRow(ws, LEGACY_RENDERING);
    await insertRow(ws, "17849990000000062", { credentialKind: "real", instagramScopedUserId: "99999999999999999" });
    const before = await instagramRows(ws);
    stubMeta({ tokenUserId: "38281000000004700", professionalId: "17849990000000062" });

    await expect(connect(ws)).rejects.toThrow(/collision/);

    expect(await instagramRows(ws)).toEqual(before);
  });

  it("a profile_lookup failure leaves the legacy row completely unchanged", async () => {
    const ws = await newWorkspace();
    await insertRow(ws, LEGACY_RENDERING);
    const before = await instagramRows(ws);
    stubMeta({ tokenUserId: "38281000000004700", professionalId: "17849990000000062", profileStatus: 400 });

    await expect(connect(ws)).rejects.toMatchObject({ stage: "profile_lookup", code: "OAuthException" });

    expect(await instagramRows(ws)).toEqual(before);
  });
});
