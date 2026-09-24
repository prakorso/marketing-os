import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  CANONICAL_METRIC_LABELS,
  CANONICAL_METRICS,
  formatCapturedAt,
  formatEngagementRate,
  formatFreshnessLabel,
  formatMetricForDisplay,
  formatProvenanceLabel,
} from "@/lib/analytics/ui-format";
import { createClient } from "@/lib/supabase/server";
import {
  listContentPerformanceScores,
  listPublicationMetricSnapshots,
  listSnapshotSummariesForWorkspace,
} from "@/server/services/analytics";
import { listPublicationsForWorkspace } from "@/server/services/publications";
import { listSocialAccountsForWorkspace } from "@/server/services/social-accounts";
import { getWorkspaceBySlug } from "@/server/services/workspaces";
import type { SocialPlatform } from "@/types/database";

/**
 * MVP-5.11 — Analytics UI Foundation. Observational only: this page
 * exposes exactly the data the Analytics foundation (MVP-5.10E/E.1)
 * already persists, respecting every semantic distinction its canonical
 * decisions establish (Decisions #29, #30, #31, #33, #34, #35, #37, #38).
 * It does not compute, aggregate, rank, or interpret anything —
 * Analysis/Insight/Recommendation remain out of scope (Decision set
 * #21/#22, unaffected).
 *
 * Data access mirrors the Calendar page's established convention: existing
 * service-layer list functions for the tables that have one
 * (listSocialAccountsForWorkspace, listPublicationsForWorkspace,
 * listSnapshotSummariesForWorkspace, listPublicationMetricSnapshots,
 * listContentPerformanceScores), plus the same targeted, workspace-scoped
 * content_variants → content_versions → content resolution the Calendar
 * page already performs directly (this hand-authored Database type
 * declares no embedded-join Relationships, so this is the established
 * pattern, not a new one).
 *
 * Publication selection is a plain `?publication=<id>` search param,
 * server-rendered — no client component, no client-side Supabase call,
 * consistent with "prefer server-side data access."
 */

const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
};

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ publication?: string }>;
}) {
  const { slug } = await params;
  const { publication: publicationParam } = await searchParams;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const [accounts, publications, snapshotSummaries] = await Promise.all([
    listSocialAccountsForWorkspace(workspace.id),
    listPublicationsForWorkspace(workspace.id),
    listSnapshotSummariesForWorkspace(workspace.id),
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const summaryByPublication = new Map(snapshotSummaries.map((summary) => [summary.publicationId, summary]));

  // Analytics inspection is scoped to published publications only — a
  // draft/approved/scheduled publication cannot have a metric snapshot
  // (recordPublicationMetricSnapshot itself refuses to record one), so
  // showing them here would imply analytics exists where it structurally
  // cannot yet.
  const publishedPublications = publications.filter(
    (publication) => publication.status === "published" && publication.external_publication_id,
  );

  const supabase = await createClient();
  const variantIds = [...new Set(publishedPublications.map((publication) => publication.content_variant_id))];
  const { data: variants, error: variantsError } = await supabase
    .from("content_variants")
    .select("id, content_version_id")
    .eq("workspace_id", workspace.id)
    .in("id", variantIds.length > 0 ? variantIds : ["00000000-0000-0000-0000-000000000000"]);
  if (variantsError) {
    throw new Error(`Failed to load content variants for analytics: ${variantsError.message}`);
  }
  const variantById = new Map((variants ?? []).map((variant) => [variant.id, variant]));

  const versionIds = [...new Set((variants ?? []).map((variant) => variant.content_version_id))];
  const { data: versions, error: versionsError } = await supabase
    .from("content_versions")
    .select("id, content_id")
    .eq("workspace_id", workspace.id)
    .in("id", versionIds.length > 0 ? versionIds : ["00000000-0000-0000-0000-000000000000"]);
  if (versionsError) {
    throw new Error(`Failed to load content versions for analytics: ${versionsError.message}`);
  }
  const versionById = new Map((versions ?? []).map((version) => [version.id, version]));

  const contentIds = [...new Set((versions ?? []).map((version) => version.content_id))];
  const { data: contentRows, error: contentError } = await supabase
    .from("content")
    .select("id, title")
    .eq("workspace_id", workspace.id)
    .in("id", contentIds.length > 0 ? contentIds : ["00000000-0000-0000-0000-000000000000"]);
  if (contentError) {
    throw new Error(`Failed to load content for analytics: ${contentError.message}`);
  }
  const contentById = new Map((contentRows ?? []).map((row) => [row.id, row]));

  const publicationRows = publishedPublications.map((publication) => {
    const variant = variantById.get(publication.content_variant_id);
    const version = variant ? versionById.get(variant.content_version_id) : undefined;
    const content = version ? contentById.get(version.content_id) : undefined;
    const account = accountById.get(publication.social_account_id);
    const summary = summaryByPublication.get(publication.id);
    return {
      publication,
      contentTitle: content?.title ?? "Untitled content",
      account,
      snapshotCount: summary?.snapshotCount ?? 0,
    };
  });

  const selected =
    publicationRows.find((row) => row.publication.id === publicationParam) ??
    publicationRows.find((row) => row.snapshotCount > 0) ??
    null;

  const [snapshots, scores] = selected
    ? await Promise.all([
        listPublicationMetricSnapshots(workspace.id, selected.publication.id),
        listContentPerformanceScores(workspace.id, selected.publication.id),
      ])
    : [[], []];

  const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const latestScore = scores.length > 0 ? scores[scores.length - 1] : null;
  const chronological = [...snapshots].reverse();

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Social Analytics"
        title="Analytics"
        description="Recorded metric observations for published content, exactly as reported by each connected provider."
      />

      {accounts.length === 0 ? (
        <EmptyState
          title="No connected social accounts"
          description="Connect a social account in Settings to begin recording publication metrics."
        />
      ) : publicationRows.length === 0 ? (
        <EmptyState
          title="No published publications yet"
          description="Analytics becomes available once a publication in this workspace has been published."
        />
      ) : (
        <div className="grid grid-cols-1 gap-space-lg lg:grid-cols-[320px_1fr]">
          <Card className="flex flex-col gap-space-sm p-space-md">
            <span className="font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
              Publications
            </span>
            <div className="flex flex-col gap-space-xs">
              {publicationRows.map((row) => {
                const isActive = selected?.publication.id === row.publication.id;
                return (
                  <Link
                    key={row.publication.id}
                    href={`/w/${slug}/analytics?publication=${row.publication.id}`}
                    className={`flex flex-col gap-0.5 rounded-control border px-space-sm py-space-xs transition ${
                      isActive
                        ? "border-primary bg-surface-container-low"
                        : "border-transparent hover:border-outline-variant hover:bg-surface-container-lowest"
                    }`}
                  >
                    <span className="truncate font-body text-body-sm font-medium text-on-surface">
                      {row.contentTitle}
                    </span>
                    <span className="font-label text-label-sm text-on-surface-variant">
                      {row.account ? PLATFORM_LABEL[row.account.platform] : "Unknown account"} ·{" "}
                      {row.snapshotCount > 0
                        ? `${row.snapshotCount} snapshot${row.snapshotCount === 1 ? "" : "s"}`
                        : "No snapshots yet"}
                    </span>
                  </Link>
                );
              })}
            </div>
          </Card>

          <div className="flex flex-col gap-space-lg">
            {!selected ? (
              <EmptyState
                title="No metric snapshots yet"
                description="None of this workspace's published publications have a recorded metric observation yet."
              />
            ) : (
              <>
                <Card className="flex flex-col gap-space-sm">
                  <span className="font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                    Account context
                  </span>
                  <div className="flex flex-wrap items-center gap-space-sm">
                    <span className="font-body text-body-md font-semibold text-on-surface">
                      {selected.account ? PLATFORM_LABEL[selected.account.platform] : "Unknown platform"}
                    </span>
                    {selected.account ? (
                      <Badge variant={selected.account.status === "connected" ? "active" : "neutral"}>
                        {selected.account.status}
                      </Badge>
                    ) : null}
                  </div>
                  {selected.account ? (
                    <span className="font-label text-label-sm text-on-surface-variant">
                      {selected.account.account_name}
                      {selected.account.account_handle ? ` · @${selected.account.account_handle}` : ""}
                    </span>
                  ) : null}
                  {/* last_synced_at is account-level (Decision #35) — never presented as if it describes this one publication's observation time. */}
                  <span className="font-label text-label-sm text-on-surface-variant">
                    {formatFreshnessLabel(selected.account?.last_synced_at ?? null)}
                  </span>
                </Card>

                {snapshots.length === 0 ? (
                  <EmptyState
                    title="No metric snapshots yet"
                    description="This publication has not had a metric observation recorded yet."
                  />
                ) : (
                  <>
                    <Card className="overflow-x-auto p-0">
                      <table className="w-full min-w-[820px] border-collapse text-left">
                        <thead>
                          <tr className="border-b border-outline-variant">
                            <th className="px-space-md py-space-sm font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                              Observed
                            </th>
                            {CANONICAL_METRICS.map((metric) => (
                              <th
                                key={metric}
                                className="px-space-md py-space-sm text-right font-label text-label-sm uppercase tracking-wider text-on-surface-variant"
                              >
                                {CANONICAL_METRIC_LABELS[metric]}
                              </th>
                            ))}
                            <th className="px-space-md py-space-sm text-right font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                              Engagement rate
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {chronological.map((snapshot) => (
                            <tr key={snapshot.id} className="border-b border-outline-variant last:border-b-0">
                              <td className="px-space-md py-space-sm align-top">
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-label text-label-sm text-on-surface">
                                    {formatCapturedAt(snapshot.captured_at)}
                                  </span>
                                  <span className="font-label text-label-sm text-on-surface-variant">
                                    {formatProvenanceLabel(snapshot.captured_at_provenance)}
                                  </span>
                                </div>
                              </td>
                              {CANONICAL_METRICS.map((metric) => {
                                const display = formatMetricForDisplay(
                                  snapshot[metric],
                                  snapshot.metric_states[metric].state,
                                );
                                return (
                                  <td
                                    key={metric}
                                    className={`px-space-md py-space-sm text-right font-label text-label-md ${
                                      display.isValue ? "text-on-surface" : "italic text-on-surface-variant"
                                    }`}
                                  >
                                    {display.text}
                                  </td>
                                );
                              })}
                              <td className="px-space-md py-space-sm text-right font-label text-label-md text-on-surface">
                                {formatEngagementRate(snapshot.engagement_rate)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Card>
                    <p className="font-body text-body-sm text-on-surface-variant">
                      As reported by provider. Normalized fields are a Marqos storage/interface standard, not a
                      guarantee that measurement methodology is identical across platforms — figures from different
                      providers should not be assumed comparable.
                    </p>

                    {latestScore ? (
                      <Card className="flex flex-col gap-space-xs">
                        <div className="flex items-center gap-space-sm">
                          <span className="font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                            Score
                          </span>
                          <Badge variant="neutral">Provisional</Badge>
                        </div>
                        <span className="font-label text-headline-md text-on-surface">
                          {formatEngagementRate(latestScore.score)}
                        </span>
                        <p className="font-body text-body-sm text-on-surface-variant">
                          Currently a direct passthrough of the latest snapshot&apos;s provider-reported engagement
                          rate — not a Marqos-derived performance calculation, ranking, or recommendation.
                        </p>
                      </Card>
                    ) : null}

                    {latestSnapshot ? (
                      <details className="rounded-card border border-outline-variant bg-surface-container-lowest p-space-md">
                        <summary className="cursor-pointer font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                          Raw provider data (most recent observation)
                        </summary>
                        <p className="mt-space-xs font-body text-body-sm text-on-surface-variant">
                          Provider-reported/raw evidence, kept separate from the normalized values above — not a
                          Marqos-derived metric.
                        </p>
                        <pre className="mt-space-sm overflow-x-auto whitespace-pre-wrap break-all font-label text-label-sm text-on-surface-variant">
                          {JSON.stringify(latestSnapshot.provider_metrics, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
