// Test-only stub for `next/headers`, aliased in vitest.config.ts
// (integration tests only). src/lib/supabase/server.ts calls `await
// cookies()` before constructing its client, but the mocked
// createServerClient in supabase-ssr.ts never invokes the returned
// getAll/set closures — real cookie handling is Next.js/Supabase-SSR's own
// well-tested concern, not what these tests are exercising.
export async function cookies() {
  return {
    getAll: () => [] as { name: string; value: string }[],
    set: () => {},
  };
}
