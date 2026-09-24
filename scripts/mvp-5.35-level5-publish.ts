import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  createInstagramMediaContainer,
  getInstagramMediaContainerStatus,
  publishInstagramMediaContainer,
} from "@/lib/social/instagram-adapter";
import type { StagedMediaPublisher } from "@/lib/social/provider";
import {
  createAttemptStore,
  runStagedImagePublish,
  type AttemptStore,
  type StagedPublishOutcome,
} from "@/server/services/instagram-image-publishing";
import { createPublishSignedUrl, loadVariantPublishAssets } from "@/server/services/publication-media";
import { markFailedAsSystem, markPublishedAsSystem } from "@/server/services/publications";
import { DEFAULT_EXECUTION_BUDGET, type ExecutionBudgetConfig } from "@/server/services/publish-execution-budget";
import type { Asset, Database, SocialAccount } from "@/types/database";

import { inspectOperatorTarget, LEVEL5_FIXTURE, OperatorRefusal, parseTargetArgs, type OperatorArgs } from "./lib/operator-target";
import { installProviderCallGuard, type GuardCounters, type ProviderCallGuard } from "./lib/provider-call-guard";

/**
 * MVP-5.35C-I — ONE-OFF LOCAL operator for the future Level 5 publish: ONE
 * real media_publish for ONE controlled fixture publication. It WILL create
 * a public Instagram post when run against staging — which requires its own
 * explicit owner authorization. NOT part of the application: nothing under
 * src/, the scheduler or Netlify imports it; the global staged-publishing
 * gate is irrelevant (runExecution is never used) and stays OFF.
 *
 *   --workspace <id-or-slug> --publication <uuid>
 *   --confirm-level5-publish=PUBLISH_ONE_PUBLIC_INSTAGRAM_POST
 *
 * Order: strict args → guards A–H (read-only; Level 5 fixture contract) →
 * guard target authorization → ONE credential resolution → the REAL engine
 * (runStagedImagePublish). main() installs the provider-call guard before
 * any client exists; the attempt store ARMS it only after the
 * publish_requested checkpoint resolved. Recovery (pending_reconcile with a
 * mediaId, outcome_unknown) is a separate explicit action — never automatic.
 *
 * G4 (MVP-5.35C-J.1, owner-authorized): ONLY after the engine returned
 * "published" AND a read-back shows the publication durably published with
 * the G3 media id, at most ONE read-only
 *   GET /<G3 media id>?fields=id,permalink,timestamp,media_type
 * is made with the already-resolved credential. It is verification only:
 * its result is reported separately and never changes, retries or decides
 * the publish (exit 0 = published + verified, 4 = published, not verified).
 */

export const LEVEL5_CONFIRMATION = "PUBLISH_ONE_PUBLIC_INSTAGRAM_POST";
export const LEVEL5_CONFIRM_FLAG = "--confirm-level5-publish";
export const LEVEL5_FIXTURE_TAG = LEVEL5_FIXTURE.tag;
export const LEVEL5_IDEMPOTENCY_PREFIX = LEVEL5_FIXTURE.idempotencyPrefix;

/** G2 ceiling derived from the accepted execution budget (poll budget / interval, +1). */
export function level5StatusReadCeiling(budget: Pick<ExecutionBudgetConfig, "pollBudgetMs" | "pollIntervalMs"> = DEFAULT_EXECUTION_BUDGET): number {
  return Math.ceil(budget.pollBudgetMs / budget.pollIntervalMs) + 1;
}

export function parseLevel5Args(argv: readonly string[]): OperatorArgs {
  return parseTargetArgs(argv, { flag: LEVEL5_CONFIRM_FLAG, value: LEVEL5_CONFIRMATION });
}

export type Level5Deps = {
  /** Service-role client — created AFTER the guard was installed (supabase-js captures fetch at creation). */
  db: SupabaseClient<Database>;
  /** Called at most once, only after every guard passed. Never printed, persisted or returned. */
  resolveCredential: (account: SocialAccount) => Promise<string>;
  provider: StagedMediaPublisher;
  signMediaUrl: (asset: Asset) => Promise<string>;
  /** The installed provider-call guard (main() always provides it). */
  guard: ProviderCallGuard | null;
  /** Base attempt store (tests inject persistence failures); arming wraps it. */
  attempts?: AttemptStore;
  budget?: Partial<ExecutionBudgetConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export const G4_FIELDS = "id,permalink,timestamp,media_type";

export type Level5Verification = {
  attempted: boolean;
  verified: boolean;
  /** verified | not_applicable | provider_verification_failed | g4_invalid_response | g4_media_id_mismatch | g4_missing_permalink | g4_unsafe_permalink | g4_unsupported_media_type */
  code: string;
  mediaId: string | null;
  permalink: string | null;
  timestamp: string | null;
  mediaType: string | null;
};

const NOT_APPLICABLE: Level5Verification = { attempted: false, verified: false, code: "not_applicable", mediaId: null, permalink: null, timestamp: null, mediaType: null };

/** Evidence/navigation only: an https instagram.com URL without query string or fragment. */
export function isSafePermalink(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "www.instagram.com" || url.hostname === "instagram.com") && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * The single G4 read. Never throws; never retries. The credential travels
 * like the adapter's other GETs (query string — never logged by the guard).
 */
export async function verifyPublishedMedia(input: { credential: string; mediaId: string; timeoutMs?: number }): Promise<Level5Verification> {
  const base = { ...NOT_APPLICABLE, attempted: true, mediaId: input.mediaId };
  const url = new URL(`https://graph.instagram.com/${encodeURIComponent(input.mediaId)}`);
  url.searchParams.set("fields", G4_FIELDS);
  url.searchParams.set("access_token", input.credential);
  let res: Response;
  try {
    res = await fetch(url.toString(), { method: "GET", signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_EXECUTION_BUDGET.providerRequestTimeoutMs) });
  } catch {
    return { ...base, code: "provider_verification_failed" };
  }
  if (!res.ok) return { ...base, code: "provider_verification_failed" };
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (!parsed || typeof parsed !== "object") return { ...base, code: "g4_invalid_response" };
    body = parsed as Record<string, unknown>;
  } catch {
    return { ...base, code: "g4_invalid_response" };
  }
  if (typeof body.id !== "string" || !/^[0-9]+$/.test(body.id)) return { ...base, code: "g4_invalid_response" };
  if (body.id !== input.mediaId) return { ...base, code: "g4_media_id_mismatch" };
  if (body.permalink === undefined || body.permalink === null) return { ...base, code: "g4_missing_permalink" };
  if (!isSafePermalink(body.permalink)) return { ...base, code: "g4_unsafe_permalink" };
  if (body.media_type !== "IMAGE") return { ...base, code: "g4_unsupported_media_type" };
  return {
    ...base,
    verified: true,
    code: "verified",
    permalink: body.permalink,
    timestamp: typeof body.timestamp === "string" ? body.timestamp : null,
    mediaType: body.media_type,
  };
}

export type Level5Evidence = {
  tool: "mvp-5.35-level5-publish";
  result: "refused" | "secret_leak_detected" | StagedPublishOutcome["kind"];
  code: string | null;
  workspaceId: string | null;
  publicationId: string | null;
  igAccountId: string | null;
  attemptId: string | null;
  containerId: string | null;
  mediaId: string | null;
  attemptStage: string | null;
  publicationStatus: string | null;
  errorCode: string | null;
  elapsedMs: number;
  providerCalls: { create: number; status: number; publish: number; verify: number };
  /** G4 — separate from the publish result; never changes it. */
  verification: Level5Verification;
  providerStatusTransitions: string[];
  guard: { armed: boolean; counters: GuardCounters } | null;
};

export type Level5Result = { exitCode: number; evidence: Level5Evidence };

export async function runLevel5PublishOperator(argv: readonly string[], deps: Level5Deps): Promise<Level5Result> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const providerCalls = { create: 0, status: 0, publish: 0, verify: 0 };
  const transitions: string[] = [];
  const secrets: { type: string; value: string }[] = [];
  const evidence = (fields: Partial<Level5Evidence>): Level5Evidence => ({
    tool: "mvp-5.35-level5-publish",
    result: "refused",
    code: null,
    workspaceId: null,
    publicationId: null,
    igAccountId: null,
    attemptId: null,
    containerId: null,
    mediaId: null,
    attemptStage: null,
    publicationStatus: null,
    errorCode: null,
    elapsedMs: Math.round(now() - startedAt),
    providerCalls: { ...providerCalls },
    verification: NOT_APPLICABLE,
    providerStatusTransitions: [...transitions],
    guard: deps.guard ? { armed: deps.guard.armed, counters: deps.guard.counters() } : null,
    ...fields,
  });
  const finish = (exitCode: number, result: Level5Evidence): Level5Result => {
    // Self-check: registered secrets must appear neither in this evidence nor in the guard log.
    const serialized = JSON.stringify(result);
    const leaks = new Set(deps.guard?.findSecretLeaks([serialized]) ?? []);
    for (const secret of secrets) if (serialized.includes(secret.value)) leaks.add(secret.type);
    if (leaks.size > 0) {
      const type = [...leaks].sort()[0];
      return { exitCode: 3, evidence: evidence({ result: "secret_leak_detected", code: `SECRET_LEAK_DETECTED:${type}` }) };
    }
    return { exitCode, evidence: result };
  };
  const registerSecret = (type: string, value: string) => {
    if (!value) return;
    secrets.push({ type, value });
    deps.guard?.registerSecret(type, value);
  };

  let args: OperatorArgs;
  try {
    args = parseLevel5Args(argv);
  } catch (err) {
    if (err instanceof OperatorRefusal) return finish(2, evidence({ code: err.code }));
    throw err;
  }
  const inspection = await inspectOperatorTarget(deps.db, args, LEVEL5_FIXTURE);
  if (!inspection.target) return finish(2, evidence({ code: inspection.firstFailure ?? "guard_failed" }));
  const { workspaceId, publication, variant, socialAccount, asset } = inspection.target;
  const ids = { workspaceId, publicationId: publication.id, igAccountId: socialAccount.external_account_id };

  // Only now may the guard allow Vault / signing / Graph — for exactly this target.
  deps.guard?.authorizeTarget({ igAccountId: socialAccount.external_account_id, signObjectPath: `${asset.storage_bucket}/${asset.storage_path}` });

  let credential: string;
  try {
    credential = await deps.resolveCredential(socialAccount);
  } catch {
    return finish(2, evidence({ ...ids, code: "credential_unavailable" }));
  }
  if (!credential) return finish(2, evidence({ ...ids, code: "credential_unavailable" }));
  registerSecret("instagram_token", credential);

  const provider: StagedMediaPublisher = Object.freeze({
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
    publishMediaContainer: (input) => {
      providerCalls.publish += 1;
      return deps.provider.publishMediaContainer(input);
    },
    listRecentMedia: async () => ({
      ok: false as const,
      code: "not_available_in_operator",
      message: "Recent media reads are not part of the Level 5 run",
      httpStatus: null,
      providerCode: null,
      providerSubcode: null,
      fbtraceId: null,
    }),
  } satisfies StagedMediaPublisher);

  // ARMING: only after the publish_requested checkpoint has durably resolved.
  const base = deps.attempts ?? createAttemptStore(deps.db);
  const attempts: AttemptStore = {
    listForPublication: base.listForPublication,
    start: base.start,
    async update(ws, attemptId, patch) {
      const row = await base.update(ws, attemptId, patch);
      if (patch.stage === "publish_requested") deps.guard?.arm();
      return row;
    },
  };

  const outcome = await runStagedImagePublish(
    { workspaceId, publication, variant, socialAccount, credential },
    {
      provider,
      attempts,
      loadAssets: (ws, variantId) => loadVariantPublishAssets(deps.db, ws, variantId),
      signMediaUrl: async (target) => {
        const url = await deps.signMediaUrl(target);
        registerSecret("signed_url", url);
        return url;
      },
      markPublished: (input) => markPublishedAsSystem(deps.db, workspaceId, publication.id, input),
      markFailed: (input) => markFailedAsSystem(deps.db, workspaceId, publication.id, input),
      budget: deps.budget,
      now: deps.now,
      sleep: deps.sleep,
      log: deps.log,
    },
  );
  const attemptId = "attemptId" in outcome ? outcome.attemptId : null;
  const { data: attempt } = attemptId
    ? await deps.db.from("publication_attempts").select("stage, container_ids, external_media_id, error_code").eq("id", attemptId).maybeSingle()
    : { data: null };
  const { data: finalPublication } = await deps.db.from("publications").select("status, error_code").eq("id", publication.id).maybeSingle();
  const mediaId =
    outcome.kind === "published"
      ? outcome.mediaId
      : outcome.kind === "pending_reconcile"
        ? (outcome.mediaId ?? attempt?.external_media_id ?? null)
        : (attempt?.external_media_id ?? null);

  // G4: only after durable published success (engine outcome AND read-back), exactly the G3 media id.
  let verification = NOT_APPLICABLE;
  const { data: durable } = await deps.db.from("publications").select("status, external_publication_id").eq("id", publication.id).maybeSingle();
  if (
    outcome.kind === "published" &&
    attempt?.stage === "published" &&
    attempt.external_media_id === outcome.mediaId &&
    durable?.status === "published" &&
    durable.external_publication_id === outcome.mediaId
  ) {
    deps.guard?.armVerification();
    providerCalls.verify += 1;
    verification = await verifyPublishedMedia({ credential, mediaId: outcome.mediaId });
  }
  credential = "";

  return finish(
    outcome.kind === "published" ? (verification.verified ? 0 : 4) : outcome.kind === "refused" ? 2 : 1,
    evidence({
      verification,
      ...ids,
      result: outcome.kind,
      code: "code" in outcome ? outcome.code : "reason" in outcome ? outcome.reason : null,
      attemptId,
      containerId: attempt?.container_ids[0] ?? deps.guard?.captured().containerId ?? null,
      mediaId,
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
    console.error("[level5-publish] refused: service-role environment is not configured");
    return 2;
  }
  const evidenceDir = process.env.MARQOS_OPERATOR_EVIDENCE_DIR ?? path.resolve(".marqos/coordination/operator-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `level5-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`);

  // Installed BEFORE any Supabase client exists.
  // allowMediaRead: the owner-authorized G4 (only the G3-captured media id, safe fields, once).
  const guard = installProviderCallGuard({ supabaseUrl: url, evidencePath, statusReadCeiling: level5StatusReadCeiling(), allowMediaRead: true });
  guard.registerSecret("service_role_key", key);
  try {
    const db = createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { exitCode, evidence } = await runLevel5PublishOperator(process.argv.slice(2), {
      db,
      guard,
      resolveCredential: async (account) => {
        if (!account.vault_secret_id) throw new Error("no credential");
        const { data, error } = await db.rpc("read_social_account_vault_secret" as never, { p_secret_id: account.vault_secret_id } as never);
        if (error || typeof data !== "string") throw new Error("credential unavailable");
        return data;
      },
      provider: {
        createMediaContainer: createInstagramMediaContainer,
        getMediaContainerStatus: getInstagramMediaContainerStatus,
        publishMediaContainer: publishInstagramMediaContainer,
        listRecentMedia: async () => ({
          ok: false,
          code: "not_available_in_operator",
          message: "Recent media reads are not part of the Level 5 run",
          httpStatus: null,
          providerCode: null,
          providerSubcode: null,
          fbtraceId: null,
        }),
      },
      signMediaUrl: createPublishSignedUrl,
      log: (line) => console.error(line),
    });
    if (evidence.result === "secret_leak_detected") {
      console.error(`[level5-publish] ${evidence.code}`);
      return exitCode;
    }
    console.log(JSON.stringify(evidence, null, 2));
    console.error(`[level5-publish] ${evidence.result}${evidence.code ? ` (${evidence.code})` : ""} — exit ${exitCode} — guard evidence ${path.basename(evidencePath)}`);
    return exitCode;
  } finally {
    guard.uninstall();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("[level5-publish] aborted: unexpected error (details suppressed)");
      process.exit(1);
    },
  );
}
