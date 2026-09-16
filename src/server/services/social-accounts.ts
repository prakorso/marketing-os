import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { SocialAccount, SocialPlatform } from "@/types/database";

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * MVP-2.1 scope: manual/dev-mode credential entry only — no OAuth
 * redirects, no provider SDKs, no publishing/scheduling. A raw credential
 * value is accepted directly from a Server Action and handed straight to
 * Supabase Vault; it is never persisted anywhere else (not in
 * `social_accounts`, not in `metadata`), and this module never returns a
 * decrypted secret to any caller (Engineering Blueprint §16, Database
 * Architecture §8).
 */
async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to manage social accounts in this workspace");
  }
}

export async function listSocialAccountsForWorkspace(workspaceId: string): Promise<SocialAccount[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("social_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("connected_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list social accounts: ${error.message}`);
  }
  return data ?? [];
}

export type ConnectSocialAccountInput = {
  platform: SocialPlatform;
  externalAccountId: string;
  accountName: string;
  accountHandle?: string;
  brandId?: string;
  /** Raw credential value (e.g. an access token). Goes to Vault only — never persisted elsewhere. */
  credential: string;
};

/**
 * Connects (or reconnects) a social account. Vault holds the only copy of
 * the raw credential; `social_accounts` stores just the returned secret
 * UUID. Reconnecting an existing account (same workspace_id/platform/
 * external_account_id — the natural key, Database Architecture §21)
 * replaces its Vault secret and updates the existing row in place rather
 * than creating a duplicate (approved MVP-2.1 decision).
 */
export async function connectSocialAccount(
  workspaceId: string,
  input: ConnectSocialAccountInput,
): Promise<SocialAccount> {
  await assertEditor(workspaceId);

  if (!input.credential) {
    throw new Error("A credential value is required to connect a social account");
  }

  const supabase = await createClient();

  const { data: existing, error: lookupError } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("platform", input.platform)
    .eq("external_account_id", input.externalAccountId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`Failed to look up existing social account: ${lookupError.message}`);
  }

  const vault = createServiceRoleClient();
  const { data: vaultSecretId, error: vaultError } = await vault.rpc("create_social_account_vault_secret", {
    p_secret: input.credential,
    p_description: `social_accounts:${input.platform}`,
  });

  if (vaultError || !vaultSecretId) {
    throw new Error(`Failed to store credential in Vault: ${vaultError?.message ?? "unknown error"}`);
  }

  const rowFields = {
    account_name: input.accountName,
    account_handle: input.accountHandle || null,
    brand_id: input.brandId || null,
    status: "connected" as const,
    vault_secret_id: vaultSecretId as string,
    connected_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabase
      .from("social_accounts")
      .update(rowFields)
      .eq("workspace_id", workspaceId)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to reconnect social account: ${error.message}`);
    }
    return data;
  }

  const { data, error } = await supabase
    .from("social_accounts")
    .insert({
      workspace_id: workspaceId,
      platform: input.platform,
      external_account_id: input.externalAccountId,
      ...rowFields,
    })
    .select()
    .single();

  if (error) {
    // A concurrent connect for the same natural key raced us between the
    // lookup and this insert — fall back to updating the row it created.
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      const { data: retried, error: retryError } = await supabase
        .from("social_accounts")
        .update(rowFields)
        .eq("workspace_id", workspaceId)
        .eq("platform", input.platform)
        .eq("external_account_id", input.externalAccountId)
        .select()
        .single();
      if (retryError) {
        throw new Error(`Failed to connect social account: ${retryError.message}`);
      }
      return retried;
    }
    throw new Error(`Failed to connect social account: ${error.message}`);
  }
  return data;
}

/**
 * Disconnects a social account: clears the Vault secret (service-role),
 * sets vault_secret_id = NULL and status = 'disconnected', and preserves
 * the row (Database Architecture §19 — never a row delete).
 */
export async function disconnectSocialAccount(workspaceId: string, accountId: string): Promise<SocialAccount> {
  await assertEditor(workspaceId);

  const supabase = await createClient();
  const { data: current, error: fetchError } = await supabase
    .from("social_accounts")
    .select("vault_secret_id")
    .eq("workspace_id", workspaceId)
    .eq("id", accountId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to load social account: ${fetchError.message}`);
  }
  if (!current) {
    throw new Error("Social account not found");
  }

  if (current.vault_secret_id) {
    const vault = createServiceRoleClient();
    const { error: vaultError } = await vault.rpc("delete_social_account_vault_secret", {
      p_secret_id: current.vault_secret_id,
    });

    if (vaultError) {
      throw new Error(`Failed to clear stored credential: ${vaultError.message}`);
    }
  }

  const { data, error } = await supabase
    .from("social_accounts")
    .update({ status: "disconnected", vault_secret_id: null })
    .eq("workspace_id", workspaceId)
    .eq("id", accountId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to disconnect social account: ${error.message}`);
  }
  return data;
}
