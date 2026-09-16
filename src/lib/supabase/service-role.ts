import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS entirely. Use this ONLY for
 * Supabase Vault operations, called through the two narrow SECURITY
 * DEFINER wrapper functions defined in the social_accounts migration
 * (`create_social_account_vault_secret` / `delete_social_account_vault_secret`),
 * granted to `service_role` only. PostgREST does not expose the `vault`
 * schema itself (supabase/config.toml `[api] schemas` — only `public` and
 * `graphql_public` are exposed), so these wrappers are the only reachable
 * path from application code into Vault (Engineering Blueprint §16,
 * Database Architecture §8).
 *
 * Never use this client as a general-purpose database client. Every
 * workspace-scoped business table read/write (including `social_accounts`
 * itself) must go through src/lib/supabase/server.ts's RLS-scoped client,
 * so tenant isolation and role authorization stay enforced by policy, not
 * by this module's caller remembering to filter correctly.
 *
 * Untyped against the app's `Database` type on purpose: its only callers
 * are the two vault wrapper RPCs, which are deliberately not part of that
 * type (the app's public-schema business tables must never be queried
 * through this client).
 *
 * Guarded by `server-only` so an accidental client-side import fails at
 * build time rather than shipping the service-role key to the browser.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase service-role environment variables are not configured");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
