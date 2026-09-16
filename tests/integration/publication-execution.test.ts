import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL } from "@/lib/social/provider";
import { executePublication } from "@/server/services/publication-execution";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "../database/helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Integration tests for the MVP-2.3 executePublication orchestration
 * (Engineering Blueprint §24: "Integration: application services,
 * Supabase queries, provider adapters" — a distinct category from the
 * pure database/RLS tests in tests/database/).
 *
 * These are the only tests in this codebase that import a
 * `server-only`-guarded service file. That import only resolves because
 * vitest.config.ts aliases `server-only`, `next/headers`, and
 * `@supabase/ssr` to test-only stubs (tests/mocks/*.ts) — see those files
 * and the config comment for exactly what's stubbed and why. Nothing here
 * runs through the real Next.js request/cookie machinery; the RLS-scoped
 * client instead authenticates via a real signed-in test user's bearer
 * token (setTestAccessToken), so RLS and workspace-role checks are still
 * exercised for real against the local Supabase stack — only Next's
 * cookie plumbing itself is bypassed, not Postgres authorization.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("executePublication — provider execution orchestration", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  // Untyped service-role client for the Vault wrapper RPCs, which are
  // deliberately not part of the typed Database interface (mirrors
  // tests/database/social-accounts-tenant-isolation.test.ts's vaultAdmin).
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let variantId: string;
  let accountId: string;
  const vaultSecretIds: string[] = [];
  const publicationIds: string[] = [];

  async function createVaultSecret(secret: string): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: secret,
      p_description: "publication-execution-test",
    });
    if (error || !data) throw new Error(`Failed to create test vault secret: ${error?.message}`);
    vaultSecretIds.push(data as string);
    return data as string;
  }

  async function insertScheduledPublication(idempotencyKey: string): Promise<string> {
    const { data, error } = await editor.client
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: accountId,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: idempotencyKey,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert scheduled publication fixture: ${error?.message}`);
    publicationIds.push(data.id);
    return data.id;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Publication Execution Tenant",
      p_slug: `publication-execution-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const { data: brand, error: brandError } = await editor.client
      .from("brands")
      .insert({ workspace_id: workspaceId, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) throw new Error(`Failed to create brand fixture: ${brandError?.message}`);

    const { data: content, error: contentError } = await editor.client
      .from("content")
      .insert({ workspace_id: workspaceId, brand_id: brand.id, title: "Fixture Content" })
      .select()
      .single();
    if (contentError || !content) throw new Error(`Failed to create content fixture: ${contentError?.message}`);

    const { data: version, error: versionError } = await editor.client
      .from("content_versions")
      .insert({
        content_id: content.id,
        workspace_id: workspaceId,
        version_number: 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    if (versionError || !version) throw new Error(`Failed to create content_version fixture: ${versionError?.message}`);

    const { data: variant, error: variantError } = await editor.client
      .from("content_variants")
      .insert({ content_version_id: version.id, workspace_id: workspaceId, platform: "instagram" })
      .select()
      .single();
    if (variantError || !variant) throw new Error(`Failed to create content_variant fixture: ${variantError?.message}`);
    variantId = variant.id;

    const { error: approvalError } = await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: content.id,
      content_version_id: version.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    if (approvalError) throw new Error(`Failed to seed approval: ${approvalError.message}`);

    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "publication-execution-fixture-account",
        account_name: "Fixture Account",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);
    accountId = account.id;
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (publicationIds.length > 0) {
      await admin.from("publications").delete().in("id", publicationIds);
    }
    for (const secretId of vaultSecretIds) {
      await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: secretId });
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId].filter(Boolean),
      userIds: [editor?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  it("(a, l, m, n, o, q) executes scheduled -> publishing -> published, resolving the credential server-side without ever returning it", async () => {
    const secretValue = "dev-only-fixture-secret-do-not-use";
    const secretId = await createVaultSecret(secretValue);
    await editor.client.from("social_accounts").update({ vault_secret_id: secretId, status: "connected" }).eq("id", accountId);

    const idempotencyKey = crypto.randomUUID();
    const publicationId = await insertScheduledPublication(idempotencyKey);

    const result = await executePublication(workspaceId, publicationId);

    expect(result.status).toBe("published");
    expect(result.published_at).not.toBeNull();
    // (n) idempotency_key passed through unchanged and reflected in the
    // mock adapter's deterministic external_publication_id.
    expect(result.idempotency_key).toBe(idempotencyKey);
    expect(result.external_publication_id).toBe(`mock-${idempotencyKey}`);
    expect(result.external_url).toContain(idempotencyKey);
    // (q) provider response persisted.
    expect(result.provider_response).toMatchObject({ mock: true, platform: "instagram", variantId });

    // (m) the raw credential must never appear anywhere in the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretValue);
  });

  it("(b, p, q) executes scheduled -> publishing -> failed when the adapter throws, persisting normalized error info", async () => {
    const secretId = await createVaultSecret(MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL);
    await editor.client.from("social_accounts").update({ vault_secret_id: secretId, status: "connected" }).eq("id", accountId);

    const idempotencyKey = crypto.randomUUID();
    const publicationId = await insertScheduledPublication(idempotencyKey);

    const result = await executePublication(workspaceId, publicationId);

    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("mock_forced_failure");
    expect(result.error_message).toBe("Mock provider forced failure");
    expect(result.provider_response).toMatchObject({ mock: true, platform: "instagram" });
    expect(result.external_publication_id).toBeNull();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL);
  });

  it("rejects executing a publication that is not in status='scheduled'", async () => {
    const secretId = await createVaultSecret("dev-only-fixture-secret-do-not-use-2");
    await editor.client.from("social_accounts").update({ vault_secret_id: secretId, status: "connected" }).eq("id", accountId);

    const { data: draft, error } = await editor.client
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: accountId,
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    expect(error).toBeNull();
    publicationIds.push(draft!.id);

    await expect(executePublication(workspaceId, draft!.id)).rejects.toThrow(/expected 'scheduled'/);
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/integration] Skipping publication-execution.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
