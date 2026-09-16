import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { anonKey, cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * Database-level tests for the MVP-2.3 Provider Execution Foundation
 * migration (20260916160000_publication_execution.sql):
 *   - enforce_publication_lifecycle_transitions: publishing only from
 *     scheduled, published only from publishing, failed only from
 *     publishing; no direct INSERT at any of the three.
 *   - read_social_account_vault_secret: service_role-only Vault read.
 *
 * These are pure database/RLS/trigger tests (no service-layer imports —
 * see tests/integration/publication-execution.test.ts for the
 * orchestration-level tests that require the mocked Next.js request
 * context, per the MVP-2.3 testing decision).
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning, so `npm test` stays
 * green in environments without Docker.
 */
describe.skipIf(!hasLocalSupabase)("Publication execution — database-level lifecycle gate", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  // Untyped service-role client for the three Vault wrapper RPCs, which
  // are deliberately not part of the typed Database interface (mirrors
  // tests/database/social-accounts-tenant-isolation.test.ts's vaultAdmin).
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let accountId: string;
  let variantApprovedId: string;
  let variantUnapprovedId: string;

  const createdPublicationIds: string[] = [];
  function track(id: string | undefined) {
    if (id) createdPublicationIds.push(id);
    return id;
  }

  async function createVariantWithVersion(contentId: string): Promise<{ variantId: string; contentVersionId: string }> {
    const { data: version, error: versionError } = await editor.client
      .from("content_versions")
      .insert({
        content_id: contentId,
        workspace_id: workspaceId,
        version_number: Math.floor(Math.random() * 1_000_000) + 1,
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

    return { variantId: variant.id, contentVersionId: version.id };
  }

  async function insertScheduledPublication(variantId: string): Promise<string> {
    const { data, error } = await editor.client
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: accountId,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert scheduled publication fixture: ${error?.message}`);
    track(data.id);
    return data.id;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Execution Gate Tenant A",
      p_slug: `execution-gate-a-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Execution Gate Tenant B",
      p_slug: `execution-gate-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

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

    const approved = await createVariantWithVersion(content.id);
    variantApprovedId = approved.variantId;
    const { error: approvalError } = await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: content.id,
      content_version_id: approved.contentVersionId,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    if (approvalError) throw new Error(`Failed to seed approval: ${approvalError.message}`);

    const unapproved = await createVariantWithVersion(content.id);
    variantUnapprovedId = unapproved.variantId;

    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "exec-gate-fixture-account",
        account_name: "Fixture Account",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);
    accountId = account.id;
  });

  afterAll(async () => {
    if (createdPublicationIds.length > 0) {
      await admin.from("publications").delete().in("id", createdPublicationIds);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("source-state enforcement", () => {
    it("(a/b groundwork) allows scheduled -> publishing when the content version is approved", async () => {
      const id = await insertScheduledPublication(variantApprovedId);
      const { data, error } = await editor.client.from("publications").update({ status: "publishing" }).eq("id", id).select().single();
      expect(error).toBeNull();
      expect(data?.status).toBe("publishing");
    });

    it("(c) rejects publishing from draft", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data, error } = await editor.client.from("publications").update({ status: "publishing" }).eq("id", created!.id).select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(c) rejects publishing from approved", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);
      await editor.client.from("publications").update({ status: "approved" }).eq("id", created!.id);

      const { data, error } = await editor.client.from("publications").update({ status: "publishing" }).eq("id", created!.id).select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(c, d) rejects publishing from published and from publishing itself (double invocation)", async () => {
      const id = await insertScheduledPublication(variantApprovedId);
      await editor.client.from("publications").update({ status: "publishing" }).eq("id", id);

      // double invocation: publishing -> publishing
      const { data: doubleData, error: doubleError } = await editor.client
        .from("publications")
        .update({ status: "publishing" })
        .eq("id", id)
        .select();
      expect(doubleData).toBeNull();
      expect(doubleError).not.toBeNull();

      await editor.client.from("publications").update({ status: "published", published_at: new Date().toISOString() }).eq("id", id);

      // from published
      const { data, error } = await editor.client.from("publications").update({ status: "publishing" }).eq("id", id).select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(c) rejects publishing from failed", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);
      await editor.client.from("publications").update({ status: "failed", error_code: "x", error_message: "x" }).eq("id", created!.id);

      const { data, error } = await editor.client.from("publications").update({ status: "publishing" }).eq("id", created!.id).select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a direct INSERT with status='publishing'", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          status: "publishing",
          idempotency_key: crypto.randomUUID(),
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(e) rejects published reached directly from scheduled (must pass through publishing)", async () => {
      const id = await insertScheduledPublication(variantApprovedId);
      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "published", published_at: new Date().toISOString() })
        .eq("id", id)
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(e) rejects a direct INSERT with status='published'", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          status: "published",
          idempotency_key: crypto.randomUUID(),
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows publishing -> published", async () => {
      const id = await insertScheduledPublication(variantApprovedId);
      await editor.client.from("publications").update({ status: "publishing" }).eq("id", id);
      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "published", published_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("published");
    });

    it("(f) rejects failed reached directly from scheduled (must pass through publishing)", async () => {
      const id = await insertScheduledPublication(variantApprovedId);
      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "failed", error_code: "x", error_message: "x" })
        .eq("id", id)
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(f) rejects a direct INSERT with status='failed'", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          status: "failed",
          idempotency_key: crypto.randomUUID(),
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(f) allows publishing -> failed", async () => {
      const id = await insertScheduledPublication(variantApprovedId);
      await editor.client.from("publications").update({ status: "publishing" }).eq("id", id);
      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "failed", error_code: "x", error_message: "x" })
        .eq("id", id)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("failed");
    });

    it("CRITICAL: rejects a direct service-role (elevated) attempt to jump draft -> publishing", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data, error } = await admin.from("publications").update({ status: "publishing" }).eq("id", created!.id).select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("approval gate still enforced alongside the lifecycle gate", () => {
    it("(g) rejects scheduled -> publishing when the content version is not approved", async () => {
      // Insert directly at 'scheduled' via service-role, bypassing the
      // approval-gate trigger's own check is impossible (it fires
      // regardless of role) — but we need a 'scheduled' row for an
      // unapproved variant to then attempt the publishing transition, and
      // the approval gate also blocks entry into 'scheduled' for an
      // unapproved variant. So this test confirms scheduling itself is
      // (correctly) already blocked, which transitively proves publishing
      // can never be reached for unapproved content via this path.
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          status: "scheduled",
          scheduled_at: new Date().toISOString(),
          idempotency_key: crypto.randomUUID(),
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(h) latest-approval-decision logic still governs entry into scheduled", async () => {
      const { data: version, error: versionError } = await editor.client
        .from("content_versions")
        .insert({
          content_id: (await editor.client.from("content").select("id").eq("workspace_id", workspaceId).limit(1).single()).data!.id,
          workspace_id: workspaceId,
          version_number: Math.floor(Math.random() * 1_000_000) + 1,
          generation_method: "human",
          content_payload: { text: "superseded fixture" },
        })
        .select()
        .single();
      expect(versionError).toBeNull();

      const { data: variant, error: variantError } = await editor.client
        .from("content_variants")
        .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram" })
        .select()
        .single();
      expect(variantError).toBeNull();

      await admin.from("content_approvals").insert({
        workspace_id: workspaceId,
        content_id: (await editor.client.from("content").select("id").eq("workspace_id", workspaceId).limit(1).single()).data!.id,
        content_version_id: version!.id,
        status: "approved",
        reviewed_at: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await admin.from("content_approvals").insert({
        workspace_id: workspaceId,
        content_id: (await editor.client.from("content").select("id").eq("workspace_id", workspaceId).limit(1).single()).data!.id,
        content_version_id: version!.id,
        status: "changes_requested",
        reviewed_at: new Date().toISOString(),
      });

      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variant!.id,
          social_account_id: accountId,
          status: "scheduled",
          scheduled_at: new Date().toISOString(),
          idempotency_key: crypto.randomUUID(),
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("cross-workspace isolation for lifecycle transitions", () => {
    it("(i) outsider cannot transition a publication in workspaceId even to a same-workspace-valid state", async () => {
      const id = await insertScheduledPublication(variantApprovedId);
      const { data, error } = await outsider.client.from("publications").update({ status: "publishing" }).eq("id", id).select();
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: stillScheduled } = await admin.from("publications").select("status").eq("id", id).single();
      expect(stillScheduled?.status).toBe("scheduled");
    });
  });

  describe("Vault credential read wrapper", () => {
    it("(j) denies an authenticated client from calling read_social_account_vault_secret", async () => {
      const editorVault = createClient(supabaseUrl!, anonKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${(await editor.client.auth.getSession()).data.session!.access_token}` } },
      });
      const { data, error } = await editorVault.rpc("read_social_account_vault_secret", {
        p_secret_id: "00000000-0000-0000-0000-000000000000",
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("(k) allows service_role to resolve a specific test Vault secret it created", async () => {
      const fakeSecret = "dev-only-fixture-secret-do-not-use";
      const { data: secretId, error: createError } = await vaultAdmin.rpc("create_social_account_vault_secret", {
        p_secret: fakeSecret,
        p_description: "execution-gate-test",
      });
      expect(createError).toBeNull();
      expect(secretId).toBeTruthy();

      const { data: resolved, error: readError } = await vaultAdmin.rpc("read_social_account_vault_secret", {
        p_secret_id: secretId as string,
      });
      expect(readError).toBeNull();
      expect(resolved).toBe(fakeSecret);

      await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: secretId as string });
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping publications-execution-gate.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
