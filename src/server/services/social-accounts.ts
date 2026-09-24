import "server-only";

import {
  exchangeInstagramAuthorizationCode,
  exchangeInstagramLongLivedToken,
  fetchInstagramProfile,
  safeGrantedPermissionNames,
} from "@/lib/social/instagram-adapter";
import { REAL_CREDENTIAL_METADATA_KEY, REAL_CREDENTIAL_METADATA_VALUE } from "@/lib/social/registry";
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
  /**
   * Routing/classification metadata only (MVP-5.21's `credentialKind`
   * marker, e.g.) — never a place to put a credential. Optional and
   * omitted by every existing caller (manual/mock entry), which preserves
   * their current behavior exactly: when omitted, an update never touches
   * the existing `metadata` value, and an insert takes the column's own
   * `'{}'::jsonb` default.
   */
  metadata?: Record<string, unknown>;
};

/** Vault holds the only copy of a raw credential; returns the opaque secret id. */
async function storeCredentialInVault(credential: string, platform: SocialPlatform): Promise<string> {
  const vault = createServiceRoleClient();
  const { data: vaultSecretId, error: vaultError } = await vault.rpc("create_social_account_vault_secret", {
    p_secret: credential,
    p_description: `social_accounts:${platform}`,
  });

  if (vaultError || !vaultSecretId) {
    throw new Error(`Failed to store credential in Vault: ${vaultError?.message ?? "unknown error"}`);
  }
  return vaultSecretId as string;
}

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

  const vaultSecretId = await storeCredentialInVault(input.credential, input.platform);

  const rowFields = {
    account_name: input.accountName,
    account_handle: input.accountHandle || null,
    brand_id: input.brandId || null,
    status: "connected" as const,
    vault_secret_id: vaultSecretId as string,
    connected_at: new Date().toISOString(),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
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

export type ConnectRealInstagramAccountInput = {
  /** The authorization code Meta appended to the OAuth callback redirect. */
  code: string;
  /** Must exactly match the redirect_uri used to start the authorization (Meta validates this). */
  redirectUri: string;
};

export type ConnectRealInstagramAccountResult = {
  account: SocialAccount;
  /**
   * MVP-5.34I: scope names Instagram reported as granted in the short-lived
   * exchange (safeGrantedPermissionNames-filtered). Names only — never
   * persisted, and the only moment Meta documents them is this exchange.
   */
  grantedPermissions: string[];
};

/**
 * MVP-5.22, reworked MVP-5.35B.3 (Model B): completes a real "Instagram
 * API with Instagram Login" OAuth grant into a connected `social_accounts`
 * row. Strict order — identity first, persistence last:
 *
 *   1. identity (provider calls only, nothing persisted):
 *      code -> short-lived exchange (exact token-scoped user_id, MVP-5.35B.1)
 *      -> long-lived exchange -> GET /me (professional account <IG_ID>)
 *   2. target resolution (reads only, assertEditor): the row owning the
 *      <IG_ID>, or one legacy pre-Model-B row (compatibility-only), or new;
 *      ambiguity/collision fail closed
 *   3. persistence: Vault secret, then the row update/insert
 *
 * Identity semantics (Decision #43, Database Architecture §8):
 * external_account_id = the professional <IG_ID> (the account MARQOS acts
 * on; natural key; publishing target). The token-scoped id is provenance
 * only (metadata.instagramScopedUserId), as is the /me app-scoped id
 * (metadata.instagramAppScopedId). account_handle = the /me username.
 *
 * The long-lived access token reaches Vault only and is never placed in
 * `metadata` or returned from this function.
 */
export async function connectRealInstagramAccount(
  workspaceId: string,
  input: ConnectRealInstagramAccountInput,
): Promise<ConnectRealInstagramAccountResult> {
  const clientId = process.env.INSTAGRAM_CLIENT_ID;
  const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("INSTAGRAM_CLIENT_ID/INSTAGRAM_CLIENT_SECRET are not configured");
  }

  // --- 1. Establish identity (provider calls only; nothing persisted) ------
  const shortLived = await exchangeInstagramAuthorizationCode({
    clientId,
    clientSecret,
    redirectUri: input.redirectUri,
    code: input.code,
  });

  // MVP-5.34A/5.34I: scope names only, so a controlled attempt can show what
  // Meta actually granted. One pre-serialized string: a multi-argument
  // console call produced an empty Netlify log entry in MVP-5.34G.
  const grantedPermissions = safeGrantedPermissionNames(shortLived.permissions);
  console.info(`[instagram-oauth] short_lived_exchange succeeded ${JSON.stringify({ grantedPermissions })}`);

  if (!shortLived.userId) {
    throw new Error("Instagram did not return an account identity for this authorization");
  }
  // Exact, lossless (MVP-5.35B.1). Provenance only under Model B — never the natural key.
  const instagramScopedUserId = shortLived.userId;

  const longLived = await exchangeInstagramLongLivedToken({
    clientSecret,
    shortLivedAccessToken: shortLived.accessToken,
  });

  // Model B (MVP-5.35B.3): the account MARQOS acts on is the professional
  // account <IG_ID>. Fails closed (stage profile_lookup) if absent/inexact.
  const profile = await fetchInstagramProfile({ accessToken: longLived.accessToken });

  // --- 2. Resolve the target row (reads only) --------------------------------
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const targetRowId = await resolveInstagramConnectionTarget(supabase, workspaceId, {
    professionalAccountId: profile.professionalAccountId,
    instagramScopedUserId,
  });

  // --- 3. Persist: credential, then account ----------------------------------
  const vaultSecretId = await storeCredentialInVault(longLived.accessToken, "instagram");

  const identityMetadata: Record<string, unknown> = {
    [REAL_CREDENTIAL_METADATA_KEY]: REAL_CREDENTIAL_METADATA_VALUE,
    [INSTAGRAM_SCOPED_USER_ID_METADATA_KEY]: instagramScopedUserId,
    ...(profile.appScopedId ? { [INSTAGRAM_APP_SCOPED_ID_METADATA_KEY]: profile.appScopedId } : {}),
  };
  const displayName = profile.username ?? `Instagram ${profile.professionalAccountId}`;

  if (targetRowId) {
    const { data: current, error: currentError } = await supabase
      .from("social_accounts")
      .select("metadata")
      .eq("workspace_id", workspaceId)
      .eq("id", targetRowId)
      .single();
    if (currentError) {
      throw new Error(`Failed to load social account for reconnect: ${currentError.message}`);
    }

    const { data, error } = await supabase
      .from("social_accounts")
      .update({
        external_account_id: profile.professionalAccountId,
        account_name: displayName,
        account_handle: profile.username ?? null,
        status: "connected",
        vault_secret_id: vaultSecretId,
        connected_at: new Date().toISOString(),
        // Merge: never drop unrelated metadata keys already on the row.
        metadata: { ...((current.metadata as Record<string, unknown> | null) ?? {}), ...identityMetadata },
      })
      .eq("workspace_id", workspaceId)
      .eq("id", targetRowId)
      .select()
      .single();
    if (error) {
      throw new Error(`Failed to reconnect social account: ${error.message}`);
    }
    return { account: data, grantedPermissions };
  }

  const { data, error } = await supabase
    .from("social_accounts")
    .insert({
      workspace_id: workspaceId,
      platform: "instagram",
      external_account_id: profile.professionalAccountId,
      account_name: displayName,
      account_handle: profile.username ?? null,
      status: "connected",
      vault_secret_id: vaultSecretId,
      connected_at: new Date().toISOString(),
      metadata: identityMetadata,
    })
    .select()
    .single();
  if (error) {
    // A concurrent connect for the same professional account raced us: fail
    // closed rather than guess which row should own the credential.
    throw new Error(`Failed to connect social account: ${error.message}`);
  }
  return { account: data, grantedPermissions };
}

/** Non-secret provenance keys on social_accounts.metadata (Model B, MVP-5.35B.3). */
export const INSTAGRAM_SCOPED_USER_ID_METADATA_KEY = "instagramScopedUserId";
export const INSTAGRAM_APP_SCOPED_ID_METADATA_KEY = "instagramAppScopedId";

/**
 * The exact string the pre-Model-B code persisted for a token-scoped id:
 * `String()` of the JS number produced by JSON parsing (MVP-5.35B.1 root
 * cause). COMPATIBILITY-ONLY — used solely to recognize legacy rows; never
 * persisted, never a publishing target, never used for new accounts. This
 * is the one deliberate exception to "provider ids are opaque strings".
 */
export function legacyInstagramIdRendering(exactId: string): string | null {
  return /^\d+$/.test(exactId) ? String(Number(exactId)) : null;
}

/**
 * Model B target resolution for a (re)connecting Instagram account:
 *   - a row already keyed by the professional <IG_ID> → normal reconnect;
 *   - else exactly one LEGACY row (pre-Model-B: same workspace, instagram,
 *     credentialKind=real, no instagramScopedUserId yet) whose
 *     external_account_id is the exact token-scoped id or its legacy
 *     rendering → migrate THAT row in place;
 *   - else → null (new account).
 * Fails closed on ambiguity (several legacy candidates) or collision (a
 * legacy candidate AND a different row that already owns the <IG_ID>).
 * Reads only — performs no write.
 */
async function resolveInstagramConnectionTarget(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  ids: { professionalAccountId: string; instagramScopedUserId: string },
): Promise<string | null> {
  const { data: owner, error: ownerError } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("platform", "instagram")
    .eq("external_account_id", ids.professionalAccountId)
    .maybeSingle();
  if (ownerError) {
    throw new Error(`Failed to look up existing social account: ${ownerError.message}`);
  }

  const legacyValues = Array.from(
    new Set([ids.instagramScopedUserId, legacyInstagramIdRendering(ids.instagramScopedUserId)].filter((v): v is string => !!v)),
  );
  const { data: legacy, error: legacyError } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("platform", "instagram")
    .eq(`metadata->>${REAL_CREDENTIAL_METADATA_KEY}`, REAL_CREDENTIAL_METADATA_VALUE)
    .is(`metadata->>${INSTAGRAM_SCOPED_USER_ID_METADATA_KEY}`, null)
    .in("external_account_id", legacyValues);
  if (legacyError) {
    throw new Error(`Failed to look up legacy social accounts: ${legacyError.message}`);
  }

  const legacyIds = (legacy ?? []).map((row) => row.id).filter((id) => id !== owner?.id);

  if (legacyIds.length > 1) {
    throw new Error(
      "Instagram identity reconciliation is ambiguous: several legacy accounts match this authorization. Operator review required.",
    );
  }
  if (legacyIds.length === 1) {
    if (owner) {
      throw new Error(
        "Instagram identity collision: another account in this workspace already uses this professional account id. Operator review required.",
      );
    }
    return legacyIds[0];
  }
  return owner?.id ?? null;
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
