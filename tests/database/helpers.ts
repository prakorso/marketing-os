import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const hasLocalSupabase = Boolean(supabaseUrl && anonKey && serviceRoleKey);

export function serviceRoleClient(): SupabaseClient<Database> {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase local stack env vars are not set (run `npm run db:start`).");
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Creates a confirmed test user and returns a client signed in as them. */
export async function createSignedInTestUser(admin: SupabaseClient<Database>) {
  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase local stack env vars are not set (run `npm run db:start`).");
  }

  const email = `test-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomUUID();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`Failed to create test user: ${createError?.message}`);
  }

  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new Error(`Failed to sign in test user: ${signInError.message}`);
  }

  return { client, userId: created.user.id, email };
}

/**
 * Deletes test-created workspaces and users in FK-safe order: audit_logs
 * (RESTRICT into workspaces) before workspaces (CASCADE into
 * workspace_members) before auth.users (CASCADE into profiles, but
 * RESTRICTed by workspaces.owner_id until the owned workspace is gone).
 */
export async function cleanupTestData(
  admin: SupabaseClient<Database>,
  { workspaceIds, userIds }: { workspaceIds: string[]; userIds: string[] },
) {
  if (workspaceIds.length > 0) {
    await admin.from("audit_logs").delete().in("workspace_id", workspaceIds);
    await admin.from("workspaces").delete().in("id", workspaceIds);
  }
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}
