import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/types/database";

/**
 * Server-side Supabase client for use in Server Components, Route Handlers,
 * and Server Actions. Reads/writes the auth session via cookies and still
 * authenticates as the signed-in user (anon key + user JWT) — RLS applies.
 *
 * This file is guarded by `server-only` so any accidental client-side
 * import fails at build time rather than shipping secrets to the browser.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component during render, where cookies
            // cannot be set. Safe to ignore as long as middleware.ts is
            // refreshing the session on every request.
          }
        },
      },
    },
  );
}
