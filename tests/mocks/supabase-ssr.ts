// Test-only stub for `@supabase/ssr`, aliased in vitest.config.ts
// (integration tests only). Real createServerClient parses a session out
// of request cookies in Supabase's own encoded format — replicating that
// faithfully in a test would be fragile and version-coupled, and isn't
// what src/server/services/publication-execution.ts's tests are meant to
// verify. Instead, this mock builds a plain supabase-js client carrying
// the test-selected user's access token as a bearer header — PostgREST/
// GoTrue authorize the request exactly as they would for a real signed-in
// user, so RLS and workspace-role checks run for real, unmocked.
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

import { getTestAccessToken } from "./session-context";

export function createServerClient<T = unknown>(url: string, anonKey: string): SupabaseClient<T> {
  const accessToken = getTestAccessToken();
  return createSupabaseClient<T>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}
