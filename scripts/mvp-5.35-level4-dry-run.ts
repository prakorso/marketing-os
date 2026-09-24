import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { createInstagramMediaContainer, getInstagramMediaContainerStatus } from "@/lib/social/instagram-adapter";
import type { ContainerPreparationProvider } from "@/lib/social/provider";
import { runInstagramImageDryRun, type DryRunOutcome } from "@/server/services/instagram-image-dry-run";
import { createAttemptStore } from "@/server/services/instagram-publish-prepare";
import { createPublishSignedUrl, loadVariantPublishAssets } from "@/server/services/publication-media";
import { markFailedAsSystem } from "@/server/services/publications";
import type { Asset, Database, SocialAccount } from "@/types/database";

import {
  inspectOperatorTarget,
  LEVEL4_FIXTURE,
  OperatorRefusal,
  parseTargetArgs,
  type GuardCheck,
  type GuardId,
  type OperatorArgs,
  type TargetInspection,
} from "./lib/operator-target";

/**
 * MVP-5.35C-E — ONE-OFF LOCAL operator script for the future Level 4 dry run.
 *
 * NOT part of the application: nothing under src/, the scheduler, Netlify
 * functions or any build entry point imports this file, and it is absent
 * from the deployed snapshot. It imports ONLY runInstagramImageDryRun (never
 * runExecution), so the staged-publishing gate is irrelevant and
 * media_publish is unreachable: the provider it builds has exactly two
 * methods (container create + status).
 *
 * A future Level 4 run WILL perform one real POST /media (an unpublished
 * container that expires after 24 h). Running it requires a separately
 * authorized milestone. Every guard below fails closed, exits non-zero and
 * happens BEFORE the credential is resolved or the provider is touched.
 *
 * Usage (future, authorized milestone only):
 *   --workspace <workspace-id-or-slug>
 *   --publication <publication-id>
 *   --confirm-level4-dry-run=CREATE_ONE_UNPUBLISHED_INSTAGRAM_CONTAINER
 * No other argument is accepted — in particular no credential/token argument.
 */

export const LEVEL4_CONFIRMATION = "CREATE_ONE_UNPUBLISHED_INSTAGRAM_CONTAINER";

/**
 * Locked Level 4 fixture contract (MVP-5.35C-D §9, locked equivalent: the
 * content table has no metadata column). A target publication is the
 * fixture only if BOTH hold. Guards live in scripts/lib/operator-target.ts
 * (shared with Level 5 and the preflight since MVP-5.35C-I).
 */
export const LEVEL4_FIXTURE_TAG = LEVEL4_FIXTURE.tag;
export const LEVEL4_IDEMPOTENCY_PREFIX = LEVEL4_FIXTURE.idempotencyPrefix;

export type { OperatorArgs };
export type Level4GuardId = GuardId;
export type Level4GuardCheck = GuardCheck;
export type Level4Inspection = TargetInspection;

export type OperatorDeps = {
  /** Service-role client (staging in a future run; local Supabase in tests). */
  db: SupabaseClient<Database>;
  /** Called at most once, only after every guard has passed. The value is never printed, persisted or returned. */
  resolveCredential: (account: SocialAccount) => Promise<string>;
  provider: ContainerPreparationProvider;
  signMediaUrl: (asset: Asset) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type OperatorEvidence = {
  tool: "mvp-5.35-level4-dry-run";
  result: "refused" | DryRunOutcome["kind"];
  code: string | null;
  workspaceId: string | null;
  publicationId: string | null;
  attemptId: string | null;
  containerId: string | null;
  attemptStage: string | null;
  publicationStatus: string | null;
  errorCode: string | null;
  elapsedMs: number;
  providerCalls: { create: number; status: number };
  providerStatusTransitions: string[];
};

export type OperatorResult = { exitCode: number; evidence: OperatorEvidence };

/** Strict parser: exact flags only; anything else (e.g. a token) is refused. */
export function parseOperatorArgs(argv: readonly string[]): OperatorArgs {
  return parseTargetArgs(argv, { flag: "--confirm-level4-dry-run", value: LEVEL4_CONFIRMATION });
}

/** Guards A–H for the Level 4 fixture (read-only; see operator-target.ts). */
export function inspectLevel4Target(db: SupabaseClient<Database>, args: OperatorArgs): Promise<Level4Inspection> {
  return inspectOperatorTarget(db, args, LEVEL4_FIXTURE);
}

export async function runLevel4DryRunOperator(argv: readonly string[], deps: OperatorDeps): Promise<OperatorResult> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const providerCalls = { create: 0, status: 0 };
  const transitions: string[] = [];
  const secrets: string[] = [];
  const evidence = (fields: Partial<OperatorEvidence>): OperatorEvidence => ({
    tool: "mvp-5.35-level4-dry-run",
    result: "refused",
    code: null,
    workspaceId: null,
    publicationId: null,
    attemptId: null,
    containerId: null,
    attemptStage: null,
    publicationStatus: null,
    errorCode: null,
    elapsedMs: Math.round(now() - startedAt),
    providerCalls: { ...providerCalls },
    providerStatusTransitions: [...transitions],
    ...fields,
  });
  const finish = (exitCode: number, result: OperatorEvidence): OperatorResult => {
    // Defense in depth: the credential and the signed URL must never leave this process.
    const serialized = JSON.stringify(result);
    if (secrets.some((secret) => secret !== "" && serialized.includes(secret))) {
      throw new Error("Refusing to emit evidence containing a secret");
    }
    return { exitCode, evidence: result };
  };

  let args: OperatorArgs;
  try {
    args = parseOperatorArgs(argv);
  } catch (err) {
    if (err instanceof OperatorRefusal) return finish(2, evidence({ code: err.code }));
    throw err;
  }
  const inspection = await inspectLevel4Target(deps.db, args);
  if (!inspection.target) return finish(2, evidence({ code: inspection.firstFailure ?? "guard_failed" }));
  const { workspaceId, publication, variant, socialAccount } = inspection.target;
  const ids = { workspaceId, publicationId: publication.id };

  // Credential: only now, after every guard. In memory only.
  let credential: string;
  try {
    credential = await deps.resolveCredential(socialAccount);
  } catch {
    return finish(2, evidence({ ...ids, code: "credential_unavailable" }));
  }
  if (!credential) return finish(2, evidence({ ...ids, code: "credential_unavailable" }));
  secrets.push(credential);

  // Provider: create + status only; publishMediaContainer is never read.
  const provider: ContainerPreparationProvider = Object.freeze({
    createMediaContainer: (input) => {
      providerCalls.create += 1;
      return deps.provider.createMediaContainer(input);
    },
    getMediaContainerStatus: async (input) => {
      providerCalls.status += 1;
      const status = await deps.provider.getMediaContainerStatus(input);
      const label = status.ok ? status.status : `read_failed:${status.code}`;
      if (transitions[transitions.length - 1] !== label) transitions.push(label);
      return status;
    },
  } satisfies ContainerPreparationProvider);

  const outcome = await runInstagramImageDryRun(
    { workspaceId, publication, variant, socialAccount, credential },
    {
      provider,
      attempts: createAttemptStore(deps.db),
      loadAssets: (ws, variantId) => loadVariantPublishAssets(deps.db, ws, variantId),
      signMediaUrl: async (asset) => {
        const url = await deps.signMediaUrl(asset);
        secrets.push(url);
        return url;
      },
      markFailed: (input) => markFailedAsSystem(deps.db, workspaceId, publication.id, input),
      now: deps.now,
      sleep: deps.sleep,
      log: deps.log,
    },
  );
  credential = "";

  const attemptId = "attemptId" in outcome ? outcome.attemptId : null;
  const { data: attempt } = attemptId
    ? await deps.db.from("publication_attempts").select("stage, container_ids, error_code").eq("id", attemptId).maybeSingle()
    : { data: null };
  const { data: finalPublication } = await deps.db.from("publications").select("status, error_code").eq("id", publication.id).maybeSingle();

  return finish(
    outcome.kind === "dry_run_container_ready" ? 0 : 1,
    evidence({
      ...ids,
      result: outcome.kind,
      code: "code" in outcome ? outcome.code : "reason" in outcome ? outcome.reason : null,
      attemptId,
      containerId: attempt?.container_ids[0] ?? null,
      attemptStage: attempt?.stage ?? null,
      publicationStatus: finalPublication?.status ?? null,
      errorCode: attempt?.error_code ?? finalPublication?.error_code ?? null,
    }),
  );
}

/** Real wiring — used only when executed directly by the operator in an authorized milestone. */
async function main(): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[level4-dry-run] refused: service-role environment is not configured");
    return 2;
  }
  const db = createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { exitCode, evidence } = await runLevel4DryRunOperator(process.argv.slice(2), {
    db,
    resolveCredential: async (account) => {
      if (!account.vault_secret_id) throw new Error("no credential");
      const { data, error } = await db.rpc("read_social_account_vault_secret" as never, { p_secret_id: account.vault_secret_id } as never);
      if (error || typeof data !== "string") throw new Error("credential unavailable");
      return data;
    },
    provider: { createMediaContainer: createInstagramMediaContainer, getMediaContainerStatus: getInstagramMediaContainerStatus },
    signMediaUrl: createPublishSignedUrl,
    log: (line) => console.error(line),
  });
  console.log(JSON.stringify(evidence, null, 2));
  console.error(`[level4-dry-run] ${evidence.result}${evidence.code ? ` (${evidence.code})` : ""} — exit ${exitCode}`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("[level4-dry-run] aborted: unexpected error (details suppressed)");
      process.exit(1);
    },
  );
}
