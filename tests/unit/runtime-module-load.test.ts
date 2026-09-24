import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

/**
 * MVP-5.36 (B1) — the scheduled function must load under the Netlify
 * function bundler's DEFAULT resolution conditions (no "react-server"), in
 * which `server-only` resolves to a module that throws on import. The
 * function is bundled with esbuild (default conditions, like zip-it-and-
 * ship-it) and imported by a plain `node` child process — outside Vitest,
 * whose alias stubs `server-only`.
 */

const root = path.resolve(__dirname, "../..");
const outDir = mkdtempSync(path.join(tmpdir(), "marqos-runtime-load-"));

async function bundle(entry: string, name: string) {
  const outfile = path.join(outDir, `${name}.mjs`);
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    metafile: true,
    logLevel: "silent",
    absWorkingDir: root,
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return { outfile, inputs: Object.keys(result.metafile!.inputs) };
}

function loadInNode(outfile: string): string {
  const probe = path.join(outDir, `probe-${path.basename(outfile)}`);
  writeFileSync(
    probe,
    `const m = await import(${JSON.stringify(pathToFileURL(outfile).href)});\n` +
      `console.log(JSON.stringify({ handler: typeof m.default, schedule: m.config?.schedule ?? null }));\n`,
  );
  // Clean env: nothing required at module load.
  return execFileSync(process.execPath, [probe], { env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" as const }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("scheduled function module load (A)", () => {
  it("bundles without server-only in its graph and imports under default conditions", async () => {
    const { outfile, inputs } = await bundle("netlify/functions/execute-due-publications.ts", "execute-due-publications");
    expect(inputs.some((input) => input.includes("node_modules/server-only"))).toBe(false);
    expect(inputs.some((input) => input.includes("publication-scheduler") || input.includes("publication-execution"))).toBe(false);
    const out = JSON.parse(loadInNode(outfile).trim());
    expect(out).toEqual({ handler: "function", schedule: "*/5 * * * *" });
  }, 60_000);

  it("control: a server-only-guarded module still throws under the same conditions (the guard is intact)", async () => {
    const { outfile, inputs } = await bundle("src/server/services/publication-media.ts", "guarded");
    expect(inputs.some((input) => input.includes("node_modules/server-only"))).toBe(true);
    expect(() => loadInNode(outfile)).toThrow();
  }, 60_000);
});

describe("runtime exposure guard", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });
  }

  it("nothing under src/app or src/components imports the runtime", () => {
    const offenders = [...files(path.join(root, "src/app")), ...files(path.join(root, "src/components"))].filter((file) =>
      /from\s+["']@\/server\/runtime|server\/runtime\//.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the runtime is reachable only from the scheduled function", () => {
    const importers = [...files(path.join(root, "src")), ...files(path.join(root, "netlify"))].filter(
      (file) => !file.includes(`${path.sep}server${path.sep}runtime${path.sep}`) && /@\/server\/runtime\//.test(readFileSync(file, "utf8")),
    );
    expect(importers.map((file) => path.relative(root, file))).toEqual(["netlify/functions/execute-due-publications.ts"]);
  });
});
