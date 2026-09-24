import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

import { inspectOperatorTarget, LEVEL4_FIXTURE, LEVEL5_FIXTURE, type FixtureSpec, type TargetInspection } from "./lib/operator-target";

/**
 * MVP-5.35C-F/I — READ-ONLY Level 4 / Level 5 fixture preflight.
 *
 * Evaluates the operator scripts' guards A–H (inspectOperatorTarget, the
 * exact code the operators run) for the selected fixture contract and STOPS. There is no credential resolver and no
 * provider in this entry point, so it cannot read Vault or call Meta. It
 * issues SELECTs only. No confirmation flag is accepted because nothing is
 * executed.
 *
 *   --workspace <workspace-id-or-slug> --publication <publication-id>
 *   [--fixture level4|level5]   (default level4; the report also names the
 *                                fixture the publication actually carries)
 *
 * Verdicts: READY (every guard passes), FIXTURE_READY_EXCEPT_STATE_MOVE
 * (only guard F fails, with the publication still 'scheduled'), NOT_READY.
 */

export type PreflightVerdict = "READY" | "FIXTURE_READY_EXCEPT_STATE_MOVE" | "NOT_READY";

export function preflightVerdict(inspection: TargetInspection): PreflightVerdict {
  const failed = inspection.checks.filter((check) => !check.ok);
  if (failed.length === 0) return "READY";
  if (
    failed.length === 1 &&
    failed[0].guard === "F_state" &&
    inspection.publicationStatus === "scheduled" &&
    inspection.checks.length === 7
  ) {
    return "FIXTURE_READY_EXCEPT_STATE_MOVE";
  }
  return "NOT_READY";
}

export type PreflightArgs = { workspace: string; publication: string; fixture: FixtureSpec };

export function parsePreflightArgs(argv: readonly string[]): PreflightArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const eq = argv[i].indexOf("=");
    const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
    const inline = eq === -1 ? undefined : argv[i].slice(eq + 1);
    if (flag !== "--workspace" && flag !== "--publication" && flag !== "--fixture") throw new Error("unknown_argument");
    if (values.has(flag)) throw new Error("duplicate_argument");
    values.set(flag, inline ?? argv[(i += 1)] ?? "");
  }
  const workspace = values.get("--workspace");
  const publication = values.get("--publication");
  const fixtureName = values.get("--fixture") ?? "level4";
  if (!workspace) throw new Error("missing_workspace_arg");
  if (!publication) throw new Error("missing_publication_arg");
  const fixture = fixtureName === "level4" ? LEVEL4_FIXTURE : fixtureName === "level5" ? LEVEL5_FIXTURE : null;
  if (!fixture) throw new Error("unknown_fixture");
  return { workspace, publication, fixture };
}

async function main(): Promise<number> {
  let args: PreflightArgs;
  try {
    args = parsePreflightArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[level4-preflight] refused: ${(err as Error).message}`);
    return 2;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[level4-preflight] refused: service-role environment is not configured");
    return 2;
  }
  const db = createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const inspection = await inspectOperatorTarget(db, { workspace: args.workspace, publication: args.publication }, args.fixture);
  const verdict = preflightVerdict(inspection);
  console.log(
    JSON.stringify(
      {
        tool: "mvp-5.35-level4-preflight",
        verdict,
        workspace: args.workspace,
        publicationId: args.publication,
        fixtureChecked: args.fixture.name,
        detectedFixture: inspection.detectedFixture,
        publicationStatus: inspection.publicationStatus,
        checks: inspection.checks,
      },
      null,
      2,
    ),
  );
  return verdict === "NOT_READY" ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("[level4-preflight] aborted: unexpected error (details suppressed)");
      process.exit(1);
    },
  );
}
