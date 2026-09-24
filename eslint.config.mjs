import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Netlify CLI's local build/deploy artifact directory (created by
    // `netlify deploy`/`netlify build`) — vendored third-party build
    // output (edge-function runtime shims, Deno std library), never
    // first-party source. Not previously listed because no local Netlify
    // deploy had been run from this repo until MVP-5.15's staging
    // deployment.
    ".netlify/**",
  ]),
]);

export default eslintConfig;
