import "server-only";

import { resolveNormalizer } from "@/lib/analytics/normalizer-registry";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { resolveProviderAdapter } from "@/lib/social/registry";
import type { SocialProviderAdapter } from "@/lib/social/provider";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { ContentPerformanceScore, PublicationMetricSnapshot } from "@/types/database";

/**
 * MVP-3.1 Analytics Foundation — minimal ingestion + publication-scoped
 * scoring only (Database Architecture §9, Engineering Blueprint §18).
 * Mock metric retrieval only (src/lib/social/provider.ts's
 * MockProviderAdapter.getMetrics()) — no real provider API integration, no
 * automatic scheduling (no Netlify function calls this module), no
 * metric-sync notifications, no content-scoped score calculation (deferred
 * — no canonical document specifies a cross-publication/variant
 * aggregation formula; the schema already supports it via
 * content_performance_scores.score_scope, this module just doesn't write
 * it yet). Not a generic analytics framework: exactly these three
 * functions, mirroring notifications.ts's narrowly-scoped module shape.
 *
 * Uses the normal RLS-scoped client (src/lib/supabase/server.ts) for every
 * publications/social_accounts/publication_metric_snapshots/
 * content_performance_scores read and write — the one narrow exception is
 * Vault credential resolution, which uses the service-role client exactly
 * as publication-execution.ts already does (same RPC,
 * read_social_account_vault_secret), never as a general-purpose substitute
 * for the RLS-scoped client.
 *
 * MVP-3.2 adds syncWorkspacePublicationMetrics(workspaceId), a
 * workspace-scoped orchestration layer over the two functions above — no
 * new table, no new RPC, no claim/locking mechanism (per the MVP-3.2
 * audit: unlike publication execution, processing the same publication's
 * metrics twice is never a correctness hazard — snapshots are append-only
 * by design, so concurrent/repeated syncs simply add more valid historical
 * rows, not a conflict to guard against). No scheduler calls this
 * function; nothing currently does — it exists to be called, the same
 * "built, not yet consumed" posture already established for
 * listNotificationsForUser and the two functions above before this slice.
 *
 * MVP-3.3 adds listPublicationMetricSnapshots(workspaceId, publicationId)
 * and listContentPerformanceScores(workspaceId, publicationId) — the read
 * layer this module previously lacked (every other write-capable domain in
 * this codebase — publications, notifications — already has a plain list
 * function; Analytics did not). Both are un-gated by assertEditor,
 * matching listPublicationsForWorkspace/listNotificationsForUser exactly:
 * RLS's existing workspace-member SELECT policy (already granted and
 * tested in analytics-tenant-isolation.test.ts) is the authorization
 * boundary for reads in this codebase, not an application-layer role
 * check. No pagination, no filters beyond the mandatory scope keys, no
 * aggregation — matching every existing list function's shape.
 *
 * MVP-5.10E implements the canonical Analytics Normalizer pipeline
 * (Decisions #29, #32, #33, #37, #38, #39, #40, #41, #42):
 * recordPublicationMetricSnapshot now calls the adapter for a raw,
 * unnormalized provider response, passes it through
 * resolveNormalizer(platform) (src/lib/analytics/normalizer-registry.ts)
 * to get a NormalizedObservation, and persists its metric values, per-
 * metric state, captured_at, and captured_at provenance alongside the
 * unchanged raw provider_metrics. It then advances
 * social_accounts.last_synced_at monotonically (Decision #40) — never on
 * a failed collection, never regressing an already-later timestamp.
 *
 * Both functions accept an optional `deps.adapter` — production never
 * passes it (the real registry resolves the adapter as before); only
 * tests/fixtures inject a SocialProviderAdapter (e.g.
 * FixtureProviderAdapter, src/lib/analytics/fixtures/) to exercise
 * production-shaped scenarios through this exact same code path —
 * mirroring the existing deps-injection seam already established in
 * src/server/services/ai.ts's generateText/generateImage.
 *
 * Freshness update is a second, separate statement after the snapshot
 * insert succeeds — this codebase's Supabase client architecture has no
 * cross-table transaction primitive, so the two writes are not atomic. A
 * snapshot that persists successfully but whose subsequent freshness
 * update fails surfaces as a thrown error from this function (the
 * snapshot itself remains valid and persisted — this is a documented,
 * accepted limitation of the current architecture, not silently swallowed
 * and not worked around with an ad hoc transaction abstraction).
 */

async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to record analytics in this workspace");
  }
}

/**
 * Resolves a publication (must be 'published' with an
 * external_publication_id — there is nothing to measure otherwise),
 * resolves its social account's Vault credential, calls the platform's
 * (mock, this phase) provider adapter for metrics, and inserts exactly one
 * new publication_metric_snapshots row. Snapshots are append-only by
 * design (no UPDATE policy exists) — calling this again for the same
 * publication records a new point in time, never overwrites the last one.
 */
export async function recordPublicationMetricSnapshot(
  workspaceId: string,
  publicationId: string,
  deps?: { adapter?: SocialProviderAdapter },
): Promise<PublicationMetricSnapshot> {
  await assertEditor(workspaceId);
  const supabase = await createClient();

  const { data: publication, error: publicationError } = await supabase
    .from("publications")
    .select("id, status, external_publication_id, social_account_id")
    .eq("workspace_id", workspaceId)
    .eq("id", publicationId)
    .maybeSingle();
  if (publicationError) {
    throw new Error(`Failed to load publication: ${publicationError.message}`);
  }
  if (!publication) {
    throw new Error("Publication not found in this workspace");
  }
  if (publication.status !== "published" || !publication.external_publication_id) {
    throw new Error(
      `Publication ${publicationId} has no metrics to record — it is not published (status: ${publication.status})`,
    );
  }

  const { data: socialAccount, error: accountError } = await supabase
    .from("social_accounts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", publication.social_account_id)
    .maybeSingle();
  if (accountError) {
    throw new Error(`Failed to load social account: ${accountError.message}`);
  }
  if (!socialAccount) {
    throw new Error("Social account for this publication no longer resolves in this workspace");
  }
  if (!socialAccount.vault_secret_id) {
    throw new Error("Social account has no stored credential to resolve (it may be disconnected)");
  }

  const vault = createServiceRoleClient();
  const { data: credential, error: credentialError } = await vault.rpc("read_social_account_vault_secret", {
    p_secret_id: socialAccount.vault_secret_id,
  });
  if (credentialError || !credential) {
    throw new Error(`Failed to resolve social account credential: ${credentialError?.message ?? "not found"}`);
  }

  const adapter = deps?.adapter ?? resolveProviderAdapter(socialAccount);
  const rawResponse = await adapter.getMetrics({
    credential,
    externalPublicationId: publication.external_publication_id,
    socialAccount,
  });

  // Decision #41: the dispatcher selects a normalizer by the RAW
  // RESPONSE's own provider discriminant, not by the caller's assumption
  // of which platform it asked — the adapter is the actual source of
  // truth for what it returned (today these are always equal by
  // construction, but dispatch must not silently depend on that).
  const normalize = resolveNormalizer(rawResponse.provider);
  const observation = normalize(rawResponse, { collectedAt: new Date().toISOString() });

  const { data: snapshot, error: insertError } = await supabase
    .from("publication_metric_snapshots")
    .insert({
      workspace_id: workspaceId,
      publication_id: publicationId,
      captured_at: observation.capturedAt,
      captured_at_provenance: observation.capturedAtProvenance,
      impressions: observation.metrics.impressions,
      reach: observation.metrics.reach,
      views: observation.metrics.views,
      likes: observation.metrics.likes,
      comments: observation.metrics.comments,
      shares: observation.metrics.shares,
      saves: observation.metrics.saves,
      clicks: observation.metrics.clicks,
      engagement_rate: observation.engagementRate,
      metric_states: observation.metricStates,
      provider_metrics: observation.rawResponse.payload,
    })
    .select()
    .single();
  if (insertError) {
    throw new Error(`Failed to record publication metric snapshot: ${insertError.message}`);
  }

  // Decision #40: monotonic, account-level freshness, advanced only after
  // the snapshot itself is durably persisted, and only forward in time.
  if (!socialAccount.last_synced_at || new Date(observation.capturedAt) > new Date(socialAccount.last_synced_at)) {
    const { error: freshnessError } = await supabase
      .from("social_accounts")
      .update({ last_synced_at: observation.capturedAt })
      .eq("id", socialAccount.id)
      .eq("workspace_id", workspaceId);
    if (freshnessError) {
      throw new Error(
        `Metric snapshot ${snapshot.id} was persisted, but updating social account freshness failed: ${freshnessError.message}`,
      );
    }
  }

  return snapshot;
}

/**
 * Publication-scoped only (MVP-3.1 approved scope — content-scoped scoring
 * is deferred, not implemented here). Reads the publication's MOST RECENT
 * metric snapshot and carries its engagement_rate through unchanged as the
 * score: no aggregation across snapshots, no invented weighting formula.
 * score_type is always "engagement_rate"; calculation_version is always
 * "v1". Re-running this after a new snapshot exists produces a new score
 * row (never an update to a prior one) — historical scores remain
 * interpretable, per Database Architecture §9.
 */
export async function calculatePublicationPerformanceScore(
  workspaceId: string,
  publicationId: string,
): Promise<ContentPerformanceScore> {
  await assertEditor(workspaceId);
  const supabase = await createClient();

  const { data: latestSnapshot, error: snapshotError } = await supabase
    .from("publication_metric_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("publication_id", publicationId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapshotError) {
    throw new Error(`Failed to load metric snapshot: ${snapshotError.message}`);
  }
  if (!latestSnapshot) {
    throw new Error(`No metric snapshot exists for publication ${publicationId} — record one before scoring`);
  }
  if (latestSnapshot.engagement_rate === null) {
    throw new Error(`Latest metric snapshot for publication ${publicationId} has no engagement_rate to score`);
  }

  const { data: score, error: insertError } = await supabase
    .from("content_performance_scores")
    .insert({
      workspace_id: workspaceId,
      score_scope: "publication",
      publication_id: publicationId,
      score_type: "engagement_rate",
      score: latestSnapshot.engagement_rate,
      calculation_version: "v1",
      inputs: { publication_metric_snapshot_id: latestSnapshot.id },
    })
    .select()
    .single();
  if (insertError) {
    throw new Error(`Failed to record content performance score: ${insertError.message}`);
  }
  return score;
}

export type SyncWorkspacePublicationMetricsFailure = {
  publicationId: string;
  /** Sanitized message only — never a raw error object, credential, or provider_response. */
  error: string;
};

export type SyncWorkspacePublicationMetricsSummary = {
  processed: number;
  succeeded: number;
  failed: number;
  publicationIds: string[];
  snapshotIds: string[];
  scoreIds: string[];
  failures: SyncWorkspacePublicationMetricsFailure[];
};

/**
 * MVP-3.2: workspace-scoped batch orchestration over
 * recordPublicationMetricSnapshot + calculatePublicationPerformanceScore.
 * Neither underlying function's signature or behavior is changed by this
 * addition.
 *
 * Selects every publication in this workspace with status='published' and
 * a non-null external_publication_id (the same precondition
 * recordPublicationMetricSnapshot already enforces per-publication — this
 * query only narrows which publications are worth attempting, it does not
 * duplicate or weaken that check). For each, calls
 * recordPublicationMetricSnapshot() and, only if that succeeds,
 * calculatePublicationPerformanceScore() immediately after — chaining them
 * is not an invented rule: calculatePublicationPerformanceScore always
 * reads the MOST RECENT snapshot, so scoring right after recording is the
 * only way to guarantee the score reflects the snapshot just taken.
 *
 * One publication's failure (a disconnected account, a forced provider
 * failure, a missing credential, etc.) is caught and recorded in
 * `failures`, never aborting the rest of the batch — mirroring
 * publication-scheduler.ts's per-row isolation. If a snapshot is recorded
 * but the subsequent score calculation then fails, the snapshot's id is
 * still reported in `snapshotIds` (it genuinely exists) while the
 * publication is still counted as `failed` overall and its score error is
 * recorded — the summary always reflects what was actually persisted, not
 * an all-or-nothing fiction.
 *
 * Calling this repeatedly for the same workspace is expected to keep
 * adding new snapshot/score rows for publications it processes again —
 * this is correct, intentional historical accumulation (Database
 * Architecture §9/§19), not a bug to be deduplicated against.
 *
 * The returned summary contains only counts, publication/snapshot/score
 * IDs, and sanitized failure message strings — never a credential, Vault
 * secret, token, or raw provider_response.
 */
export async function syncWorkspacePublicationMetrics(
  workspaceId: string,
  deps?: { adapter?: SocialProviderAdapter },
): Promise<SyncWorkspacePublicationMetricsSummary> {
  await assertEditor(workspaceId);
  const supabase = await createClient();

  const { data: publications, error: publicationsError } = await supabase
    .from("publications")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .not("external_publication_id", "is", null);
  if (publicationsError) {
    throw new Error(`Failed to list published publications: ${publicationsError.message}`);
  }

  const publicationIds: string[] = [];
  const snapshotIds: string[] = [];
  const scoreIds: string[] = [];
  const failures: SyncWorkspacePublicationMetricsFailure[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const publication of publications ?? []) {
    publicationIds.push(publication.id);
    try {
      const snapshot = await recordPublicationMetricSnapshot(workspaceId, publication.id, deps);
      snapshotIds.push(snapshot.id);

      const score = await calculatePublicationPerformanceScore(workspaceId, publication.id);
      scoreIds.push(score.id);

      succeeded += 1;
    } catch (err) {
      failed += 1;
      failures.push({
        publicationId: publication.id,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return {
    processed: publicationIds.length,
    succeeded,
    failed,
    publicationIds,
    snapshotIds,
    scoreIds,
    failures,
  };
}

/**
 * Returns all metric snapshots for one publication, in this workspace,
 * ordered chronologically (captured_at ascending) — the natural reading
 * order for a metrics history. Empty array, not an error, when none exist
 * yet. Un-gated by assertEditor: RLS (publication_metric_snapshots_select_
 * members) is the authorization boundary for reads, matching
 * listPublicationsForWorkspace/listNotificationsForUser.
 */
export async function listPublicationMetricSnapshots(
  workspaceId: string,
  publicationId: string,
): Promise<PublicationMetricSnapshot[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("publication_metric_snapshots")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("publication_id", publicationId)
    .order("captured_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list publication metric snapshots: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Returns all publication-scoped performance scores for one publication,
 * in this workspace, ordered chronologically (calculated_at ascending).
 * Explicitly filtered to score_scope = 'publication' — content-scoped
 * scores (not yet written by any function in this module, but the schema
 * permits them) are never returned by this function. Empty array, not an
 * error, when none exist yet. Un-gated by assertEditor, same reasoning as
 * listPublicationMetricSnapshots above.
 */
export async function listContentPerformanceScores(
  workspaceId: string,
  publicationId: string,
): Promise<ContentPerformanceScore[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_performance_scores")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("publication_id", publicationId)
    .eq("score_scope", "publication")
    .order("calculated_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to list content performance scores: ${error.message}`);
  }
  return data ?? [];
}

export type PublicationSnapshotSummary = {
  publicationId: string;
  snapshotCount: number;
  latestCapturedAt: string;
};

/**
 * MVP-5.11 (Analytics UI Foundation): the smallest scoped read this page
 * needs beyond what already existed — whether a workspace's publications
 * have any recorded snapshots at all, and their most recent captured_at,
 * without an N+1 query per publication in the UI. One query, grouped in
 * application code (this hand-authored Database type declares no embedded
 * joins/aggregates, matching every other list function in this codebase).
 * Un-gated by assertEditor, same reasoning as the list functions above:
 * RLS's workspace-member SELECT policy is the read boundary.
 */
export async function listSnapshotSummariesForWorkspace(workspaceId: string): Promise<PublicationSnapshotSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("publication_metric_snapshots")
    .select("publication_id, captured_at")
    .eq("workspace_id", workspaceId)
    .order("captured_at", { ascending: true });
  if (error) {
    throw new Error(`Failed to list snapshot summaries: ${error.message}`);
  }

  const byPublication = new Map<string, { snapshotCount: number; latestCapturedAt: string }>();
  for (const row of data ?? []) {
    const existing = byPublication.get(row.publication_id);
    byPublication.set(row.publication_id, {
      snapshotCount: (existing?.snapshotCount ?? 0) + 1,
      // Rows are ascending by captured_at, so the last write for a given
      // publication_id is always the latest.
      latestCapturedAt: row.captured_at,
    });
  }

  return Array.from(byPublication.entries()).map(([publicationId, summary]) => ({
    publicationId,
    ...summary,
  }));
}
