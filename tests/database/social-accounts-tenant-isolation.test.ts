import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTestData,
  createSignedInTestUser,
  hasLocalSupabase,
  serviceRoleClient,
  supabaseUrl,
} from "./helpers";

/**
 * RLS / tenant isolation tests for the MVP-2.1 Social Accounts Foundation
 * migration (social_accounts), per Database Architecture §8, §16, §20-21
 * and Engineering Blueprint §16.
 *
 * Covers: workspace-scoped read for any member, editor-only write
 * (owner/admin/marketer — no admin-only carve-out), cross-workspace
 * denial, the composite tenant-consistency FK on brand_id, the
 * connect/disconnect/reconnect credential lifecycle (Vault secret
 * created on connect, cleared on disconnect, replaced on reconnect —
 * approved MVP-2.1 decisions), the natural-key duplicate constraint
 * (workspace_id, platform, external_account_id), and — most
 * importantly — that Supabase Vault itself is unreachable from any
 * RLS-scoped (authenticated) client, so a raw credential can never reach
 * the browser regardless of what social_accounts exposes.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning, so `npm test` stays
 * green in environments without Docker.
 */
describe.skipIf(!hasLocalSupabase)("Social Accounts RLS — tenant isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  // A second, untyped service-role client — mirrors
  // src/lib/supabase/service-role.ts, which is deliberately not typed
  // against the app's public-schema Database type. Used only to call the
  // two vault wrapper RPCs (create_social_account_vault_secret /
  // delete_social_account_vault_secret), the only PostgREST-reachable path
  // into Vault — PostgREST does not expose the `vault` schema itself to
  // any role, service_role included (supabase/config.toml `[api] schemas`).
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let brandId: string;

  async function createVaultSecret(secret: string): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: secret,
      p_description: "test",
    });
    if (error || !data) {
      throw new Error(`Failed to create test vault secret: ${error?.message}`);
    }
    return data as string;
  }

  async function deleteVaultSecret(id: string): Promise<void> {
    const { error } = await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
    if (error) {
      throw new Error(`Failed to delete test vault secret: ${error.message}`);
    }
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Social Accounts Tenant A",
      p_slug: `social-accounts-a-${Date.now()}`,
    });
    if (error || !workspace) {
      throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    }
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Social Accounts Tenant B",
      p_slug: `social-accounts-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) {
      throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    }
    otherWorkspaceId = otherWorkspace.id;

    const { error: memberError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (memberError) {
      throw new Error(`Failed to add viewer to workspace: ${memberError.message}`);
    }

    const { data: brand, error: brandError } = await editor.client
      .from("brands")
      .insert({ workspace_id: workspaceId, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) {
      throw new Error(`Failed to create brand fixture: ${brandError?.message}`);
    }
    brandId = brand.id;
  });

  afterAll(async () => {
    // Best-effort: clear any vault secrets left referenced by rows in the
    // fixture workspaces before the workspaces themselves are torn down.
    const { data: rows } = await admin
      .from("social_accounts")
      .select("vault_secret_id")
      .in("workspace_id", [workspaceId, otherWorkspaceId].filter(Boolean));
    for (const row of rows ?? []) {
      if (row.vault_secret_id) {
        await deleteVaultSecret(row.vault_secret_id);
      }
    }

    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("read access", () => {
    let accountId: string;

    it("allows an editor to insert a social account (connect)", async () => {
      const secretId = await createVaultSecret("test-token-1");
      const { data, error } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "instagram",
          external_account_id: "ig-read-1",
          account_name: "Read Fixture",
          vault_secret_id: secretId,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.platform).toBe("instagram");
      accountId = data!.id;
    });

    it("allows a member (viewer) to read social account metadata in their workspace", async () => {
      const { data, error } = await viewer.client
        .from("social_accounts")
        .select("*")
        .eq("id", accountId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.id).toBe(accountId);
      // Metadata is readable, including the vault_secret_id reference —
      // it is an inert UUID without service-role Vault access (see the
      // "Vault access" describe block below).
      expect(data?.vault_secret_id).not.toBeNull();
    });

    it("hides the social account from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("social_accounts")
        .select("*")
        .eq("id", accountId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });
  });

  describe("write authorization", () => {
    it("denies a viewer from inserting a social account", async () => {
      const { data, error } = await viewer.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "tt-viewer-attempt",
          account_name: "Viewer Attempted",
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("denies a non-member from inserting into someone else's workspace", async () => {
      const { data, error } = await outsider.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "tt-outsider-attempt",
          account_name: "Outsider Attempted",
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to update a social account", async () => {
      const secretId = await createVaultSecret("test-token-update");
      const { data: created, error: createError } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "youtube",
          external_account_id: "yt-update-1",
          account_name: "Before Update",
          vault_secret_id: secretId,
        })
        .select()
        .single();
      expect(createError).toBeNull();

      const { data, error } = await editor.client
        .from("social_accounts")
        .update({ account_name: "After Update" })
        .eq("id", created!.id)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.account_name).toBe("After Update");

      await deleteVaultSecret(secretId);
    });

    it("denies a viewer from updating a social account", async () => {
      const secretId = await createVaultSecret("test-token-viewer-update-target");
      const { data: target, error: createError } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "youtube",
          external_account_id: "yt-viewer-update-target",
          account_name: "Viewer Update Target",
          vault_secret_id: secretId,
        })
        .select()
        .single();
      expect(createError).toBeNull();

      const { data, error } = await viewer.client
        .from("social_accounts")
        .update({ account_name: "Hijacked" })
        .eq("id", target!.id)
        .select();

      // Row exists (readable by the viewer per the read-access block above)
      // but is invisible to write-side RLS for a viewer, so the filtered
      // UPDATE affects 0 rows rather than erroring outright.
      expect(error).toBeNull();
      expect(data).toEqual([]);

      const { data: unchanged } = await admin.from("social_accounts").select("account_name").eq("id", target!.id).single();
      expect(unchanged?.account_name).toBe("Viewer Update Target");

      await deleteVaultSecret(secretId);
    });

    it("has no DELETE grant/policy: even an editor cannot hard-delete a social account", async () => {
      const secretId = await createVaultSecret("test-token-delete-attempt");
      const { data: created } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "threads",
          external_account_id: "th-delete-attempt",
          account_name: "Delete Attempt",
          vault_secret_id: secretId,
        })
        .select()
        .single();

      const { error } = await editor.client.from("social_accounts").delete().eq("id", created!.id).select();
      expect(error).not.toBeNull();

      const { data: stillThere } = await admin.from("social_accounts").select("id").eq("id", created!.id).single();
      expect(stillThere?.id).toBe(created!.id);

      await deleteVaultSecret(secretId);
    });
  });

  describe("composite tenant FK on brand_id", () => {
    it("rejects a cross-workspace (brand_id, workspace_id) pairing, even for an editor of the pairing's workspace", async () => {
      const { data, error } = await outsider.client
        .from("social_accounts")
        .insert({
          workspace_id: otherWorkspaceId,
          brand_id: brandId, // belongs to workspaceId, not otherWorkspaceId
          platform: "instagram",
          external_account_id: "ig-cross-tenant",
          account_name: "Cross Tenant",
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("duplicate natural key", () => {
    it("rejects a second row with the same (workspace_id, platform, external_account_id)", async () => {
      const secretId = await createVaultSecret("test-token-dup-1");
      const { error: firstError } = await editor.client.from("social_accounts").insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "ig-dup-check",
        account_name: "First",
        vault_secret_id: secretId,
      });
      expect(firstError).toBeNull();

      const { data, error } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "instagram",
          external_account_id: "ig-dup-check",
          account_name: "Duplicate Attempt",
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();

      await deleteVaultSecret(secretId);
    });

    it("allows the same external_account_id under a different platform (no false-positive collision)", async () => {
      const secretId = await createVaultSecret("test-token-provider-isolation");
      const { data, error } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "tiktok",
          external_account_id: "ig-dup-check", // same string, different platform
          account_name: "Different Platform Same ID",
          vault_secret_id: secretId,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.platform).toBe("tiktok");

      await deleteVaultSecret(secretId);
    });
  });

  describe("connect → disconnect → reconnect lifecycle", () => {
    it("connected → disconnected clears the Vault secret and nulls vault_secret_id", async () => {
      const secretId = await createVaultSecret("test-token-lifecycle");
      const { data: connected, error: connectError } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "youtube",
          external_account_id: "yt-lifecycle-1",
          account_name: "Lifecycle Fixture",
          vault_secret_id: secretId,
        })
        .select()
        .single();
      expect(connectError).toBeNull();

      // Mirrors src/server/services/social-accounts.ts#disconnectSocialAccount:
      // service-role deletes the Vault secret (via the wrapper RPC — the
      // only PostgREST-reachable path into Vault; deleteVaultSecret throws
      // on error, so reaching the next line already proves this succeeded),
      // then the RLS-scoped editor client nulls the reference and flips
      // status.
      await deleteVaultSecret(secretId);

      const { data: disconnected, error: updateError } = await editor.client
        .from("social_accounts")
        .update({ status: "disconnected", vault_secret_id: null })
        .eq("id", connected!.id)
        .select()
        .single();

      expect(updateError).toBeNull();
      expect(disconnected?.status).toBe("disconnected");
      expect(disconnected?.vault_secret_id).toBeNull();
    });

    it("disconnected → reconnect reuses the existing row via the natural key, not a new row", async () => {
      const firstSecretId = await createVaultSecret("test-token-reconnect-1");
      const { data: connected } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "threads",
          external_account_id: "th-reconnect-1",
          account_name: "Reconnect Fixture",
          vault_secret_id: firstSecretId,
        })
        .select()
        .single();

      await deleteVaultSecret(firstSecretId);
      await editor.client
        .from("social_accounts")
        .update({ status: "disconnected", vault_secret_id: null })
        .eq("id", connected!.id);

      // Reconnect: new Vault secret, same row (looked up by natural key —
      // mirrors connectSocialAccount's existing-row branch).
      const secondSecretId = await createVaultSecret("test-token-reconnect-2");
      const { data: reconnected, error } = await editor.client
        .from("social_accounts")
        .update({ status: "connected", vault_secret_id: secondSecretId, connected_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("platform", "threads")
        .eq("external_account_id", "th-reconnect-1")
        .select()
        .single();

      expect(error).toBeNull();
      expect(reconnected?.id).toBe(connected!.id);
      expect(reconnected?.status).toBe("connected");
      expect(reconnected?.vault_secret_id).toBe(secondSecretId);

      const { count } = await admin
        .from("social_accounts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("platform", "threads")
        .eq("external_account_id", "th-reconnect-1");
      expect(count).toBe(1);

      await deleteVaultSecret(secondSecretId);
    });
  });

  describe("Vault access from RLS-scoped clients", () => {
    it("denies an authenticated client (editor) from reading vault.decrypted_secrets directly", async () => {
      const { data, error } = await editor.client.schema("vault" as never).from("decrypted_secrets" as never).select("*");

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("denies an authenticated client (editor) from reading vault.secrets directly", async () => {
      const { data, error } = await editor.client.schema("vault" as never).from("secrets" as never).select("*");

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping social-accounts-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
