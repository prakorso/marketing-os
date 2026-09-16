import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup-env.ts"],
    include: ["tests/**/*.test.ts"],
    // MVP-2.4: claim_due_publications (the scheduler's atomic claim RPC)
    // is intentionally global/cross-workspace, unlike every other table
    // this test suite touches. Running test files in parallel (Vitest's
    // default) against the one shared local Supabase instance let one
    // file's claim call scoop up another file's due-publication fixture
    // mid-test, leaving it stuck in 'publishing' with no owner to finish
    // it — confirmed by reproducing the flake. Every other test file
    // remains safe under parallelism (fixtures are workspace/row-ID
    // scoped); only this one RPC breaks that assumption, so the whole
    // suite runs sequentially rather than special-casing just the
    // scheduler test files.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Integration-test-only stubs (tests/integration/publication-execution.test.ts)
      // so server-only-guarded service files can be imported and exercised
      // under Vitest, which has no Next.js request context. These aliases
      // are resolved only within the Vitest module graph — `next build`/
      // `next dev` use webpack/turbopack, not Vite's resolver, so this has
      // no effect on the real application; `server-only`'s actual
      // client/server bundling protection is untouched. See
      // tests/mocks/*.ts for what each stub does and why.
      "server-only": path.resolve(__dirname, "./tests/mocks/server-only.ts"),
      "next/headers": path.resolve(__dirname, "./tests/mocks/next-headers.ts"),
      "@supabase/ssr": path.resolve(__dirname, "./tests/mocks/supabase-ssr.ts"),
    },
  },
});
