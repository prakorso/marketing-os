import type { SupabaseClient } from "@supabase/supabase-js";

import { createAttemptStore } from "@/server/services/instagram-publish-prepare";
import { isModelBPublishReady, loadVariantPublishAssets, validateImagePublishEligibility } from "@/server/services/publication-media";
import type { Asset, Database, SocialAccount } from "@/types/database";

/**
 * MVP-5.35C-E/I — shared, READ-ONLY target guards for the one-off operator
 * CLIs (Level 4 dry run, Level 5 publish) and the preflight. OPERATOR-ONLY:
 * never imported by src/, the scheduler or Netlify.
 */

export class OperatorRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type OperatorArgs = { workspace: string; publication: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict parser: exactly --workspace, --publication and the given
 * confirmation flag (which must carry the exact value). Anything else —
 * e.g. a token — is refused.
 */
export function parseTargetArgs(argv: readonly string[], confirm: { flag: string; value: string }): OperatorArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf("=");
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    if (flag !== "--workspace" && flag !== "--publication" && flag !== confirm.flag) {
      throw new OperatorRefusal("unknown_argument");
    }
    if (values.has(flag)) throw new OperatorRefusal("duplicate_argument");
    let value: string | undefined;
    if (eq !== -1) {
      value = raw.slice(eq + 1);
    } else if (flag !== confirm.flag && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[(i += 1)];
    }
    values.set(flag, value ?? "");
  }

  const workspace = values.get("--workspace");
  const publication = values.get("--publication");
  const confirmation = values.get(confirm.flag);
  if (!workspace) throw new OperatorRefusal("missing_workspace_arg");
  if (!publication) throw new OperatorRefusal("missing_publication_arg");
  if (confirmation === undefined || confirmation === "") throw new OperatorRefusal("missing_confirmation");
  if (confirmation !== confirm.value) throw new OperatorRefusal("wrong_confirmation");
  if (!UUID.test(publication)) throw new OperatorRefusal("invalid_publication_id");
  return { workspace, publication };
}

/** A locked fixture contract: BOTH the variant tag and the idempotency prefix must match. */
export type FixtureSpec = { name: "level4" | "level5"; tag: string; idempotencyPrefix: string };

export const LEVEL4_FIXTURE: FixtureSpec = { name: "level4", tag: "mvp-5.35-level4-fixture", idempotencyPrefix: "mvp-5.35-l4-" };
export const LEVEL5_FIXTURE: FixtureSpec = { name: "level5", tag: "mvp-5.35-level5-fixture", idempotencyPrefix: "mvp-5.35-l5-" };
const KNOWN_FIXTURES = [LEVEL4_FIXTURE, LEVEL5_FIXTURE];

export type DetectedFixture = FixtureSpec["name"] | "none";

export function detectFixture(idempotencyKey: string, variantMetadata: Record<string, unknown> | null): DetectedFixture {
  const match = KNOWN_FIXTURES.find((spec) => idempotencyKey.startsWith(spec.idempotencyPrefix) && variantMetadata?.fixture === spec.tag);
  return match?.name ?? "none";
}

export type OperatorTarget = {
  workspaceId: string;
  publication: Database["public"]["Tables"]["publications"]["Row"];
  variant: Database["public"]["Tables"]["content_variants"]["Row"];
  socialAccount: SocialAccount;
  asset: Asset;
};

export type GuardId = "A_workspace" | "B_publication" | "CD_fixture" | "E_account" | "F_state" | "G_media" | "H_attempts";
export type GuardCheck = { guard: GuardId; ok: boolean; code: string | null };
export type TargetInspection = {
  checks: GuardCheck[];
  /** Code of the first failing guard in A→H order; null when every guard passes. */
  firstFailure: string | null;
  /** Status of the target publication when it was found in the workspace (B passed). */
  publicationStatus: string | null;
  /** Which known fixture the publication carries (independent of the spec being checked). */
  detectedFixture: DetectedFixture | null;
  /** Non-null only when every guard passes. */
  target: OperatorTarget | null;
};

/**
 * Guards A–H. READ-ONLY: never resolves a credential and never touches a
 * provider. A–D gate the lookups; E–H are all evaluated so a preflight
 * reports each of them.
 */
export async function inspectOperatorTarget(db: SupabaseClient<Database>, args: OperatorArgs, spec: FixtureSpec): Promise<TargetInspection> {
  const checks: GuardCheck[] = [];
  const record = (guard: GuardId, code: string | null) => {
    checks.push({ guard, ok: code === null, code });
    return code === null;
  };
  let publicationStatus: string | null = null;
  let detectedFixture: DetectedFixture | null = null;
  const result = (target: OperatorTarget | null): TargetInspection => ({
    checks,
    publicationStatus,
    detectedFixture,
    firstFailure: checks.find((check) => !check.ok)?.code ?? null,
    target: checks.every((check) => check.ok) ? target : null,
  });

  // A. exact workspace (by id or slug; exactly one row)
  const byId = UUID.test(args.workspace);
  const { data: workspaces, error: wsError } = await db
    .from("workspaces")
    .select("id")
    .eq(byId ? "id" : "slug", args.workspace)
    .limit(2);
  if (!record("A_workspace", wsError ? "workspace_lookup_failed" : workspaces?.length !== 1 ? "workspace_not_found" : null)) return result(null);
  const workspaceId = workspaces![0].id;

  // B. publication exists, in that workspace
  const { data: publication, error: pubError } = await db.from("publications").select("*").eq("id", args.publication).maybeSingle();
  const pubCode = pubError
    ? "publication_lookup_failed"
    : !publication
      ? "publication_not_found"
      : publication.workspace_id !== workspaceId
        ? "publication_workspace_mismatch"
        : null;
  if (!record("B_publication", pubCode) || !publication) return result(null);
  publicationStatus = publication.status;

  // C/D. the dedicated fixture, exact tag + idempotency prefix
  const { data: variant, error: variantError } = await db
    .from("content_variants")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", publication.content_variant_id)
    .maybeSingle();
  if (variant) detectedFixture = detectFixture(publication.idempotency_key, variant.metadata);
  const fixtureCode =
    variantError || !variant
      ? "variant_not_found"
      : !publication.idempotency_key.startsWith(spec.idempotencyPrefix) || variant.metadata?.fixture !== spec.tag
        ? `not_${spec.name}_fixture`
        : null;
  if (!record("CD_fixture", fixtureCode) || !variant) return result(null);

  // E. Instagram Model-B-ready account, in the same workspace
  const { data: socialAccount, error: accountError } = await db
    .from("social_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", publication.social_account_id)
    .maybeSingle();
  record(
    "E_account",
    accountError || !socialAccount
      ? "account_not_found"
      : socialAccount.platform !== "instagram"
        ? "account_not_instagram"
        : !isModelBPublishReady(socialAccount)
          ? "account_not_model_b_ready"
          : null,
  );

  // F. exact pre-execution state
  record("F_state", publication.status !== "publishing" ? "publication_not_publishing" : null);

  // G. exactly one eligible JPEG (same validation the engine applies)
  let asset: Asset | null = null;
  if (!socialAccount) {
    record("G_media", "media_not_evaluated_without_account");
  } else {
    try {
      const assets = await loadVariantPublishAssets(db, workspaceId, variant.id);
      const eligibility = validateImagePublishEligibility({ workspaceId, variant, socialAccount, assets });
      if (eligibility.ok) asset = eligibility.asset;
      record("G_media", eligibility.ok ? null : `media_${eligibility.code}`);
    } catch {
      record("G_media", "media_lookup_failed");
    }
  }

  // H. one-shot: ANY prior attempt (open, failed, or completed) refuses
  try {
    const prior = await createAttemptStore(db).listForPublication(workspaceId, publication.id);
    record("H_attempts", prior.length > 0 ? "prior_attempt_exists" : null);
  } catch {
    record("H_attempts", "attempt_history_unavailable");
  }

  return result(socialAccount && asset ? { workspaceId, publication, variant, socialAccount, asset } : null);
}
