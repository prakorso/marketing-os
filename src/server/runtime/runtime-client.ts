import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

/**
 * MVP-5.36 — service-role client for the Level-6 scheduled runtime ONLY.
 *
 * This module has no `server-only` import because the scheduled function is
 * bundled with default resolution conditions (MVP-5.36A §4). Its exposure is
 * instead guarded by a test: nothing under src/app or src/components may
 * import src/server/runtime/**. The key is read from the function's
 * environment at call time and never logged or returned.
 *
 * Returns null when the environment is incomplete; the runtime treats that
 * as an unreadable control (OFF).
 */
export function createRuntimeServiceClient(env: Record<string, string | undefined> = process.env): SupabaseClient<Database> | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
