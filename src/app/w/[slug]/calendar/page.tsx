import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layout/PageHeader";
import { CalendarView } from "@/components/calendar/CalendarView";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import { listSocialAccountsForWorkspace } from "@/server/services/social-accounts";
import {
  CALENDAR_PUBLICATION_STATUSES,
  listPublicationsForCalendar,
  type CalendarPublicationStatus,
} from "@/server/services/publications";
import type { CalendarEvent } from "@/components/calendar/types";

// Real-world UTC offsets range from UTC-12:00 to UTC+14:00. Padding the
// server's UTC query range by this much on each side guarantees every
// viewer-local day of the requested calendar month is covered by the
// fetched data, regardless of the viewer's actual timezone — which the
// server has no reliable way to know. The client (CalendarView) then does
// the precise, browser-local placement of each event into its correct day
// cell, and discards anything that (after local conversion) falls outside
// the target month. This is the "slightly different server/client split"
// the MVP-2.5 date/time policy anticipates — no timezone library, no new
// API route, data fetching stays entirely server-side.
const PAD_HOURS_BEFORE = 14;
const PAD_HOURS_AFTER = 12;

function resolveTargetMonth(yearParam?: string, monthParam?: string): { year: number; month: number } {
  const now = new Date();
  const year = Number(yearParam);
  // URL month is 1-indexed (human-friendly); internally we use JS's
  // 0-indexed convention throughout to avoid off-by-one bugs.
  const month = Number(monthParam) - 1;

  if (Number.isInteger(year) && year > 0 && Number.isInteger(month) && month >= 0 && month <= 11) {
    return { year, month };
  }
  // No/invalid params: fall back to the current UTC month. If this
  // doesn't match the viewer's actual local "current month" (possible
  // near a UTC day/month boundary), CalendarView corrects the URL on
  // mount once the browser's real local date is available — see its
  // header comment.
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
}

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ year?: string; month?: string; status?: string }>;
}) {
  const { slug } = await params;
  const { year: yearParam, month: monthParam, status: statusParam } = await searchParams;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const { year, month } = resolveTargetMonth(yearParam, monthParam);

  const statusFilter = CALENDAR_PUBLICATION_STATUSES.includes(statusParam as CalendarPublicationStatus)
    ? [statusParam as CalendarPublicationStatus]
    : undefined;

  const start = new Date(Date.UTC(year, month, 1) - PAD_HOURS_BEFORE * 60 * 60 * 1000).toISOString();
  const end = new Date(Date.UTC(year, month + 1, 1) + PAD_HOURS_AFTER * 60 * 60 * 1000).toISOString();

  const [publications, accounts, role] = await Promise.all([
    listPublicationsForCalendar(workspace.id, { start, end, statuses: statusFilter }),
    listSocialAccountsForWorkspace(workspace.id),
    getCurrentUserRole(workspace.id),
  ]);
  const canEdit = role === "owner" || role === "admin" || role === "marketer";
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  // Resolve publication -> content_variant -> content_version -> content
  // via separate, targeted queries and JS merges, per the established
  // codebase convention (content.ts's listContentForWorkspace/
  // listLinkedAssets), rather than an embedded PostgREST join — this
  // hand-authored Database type declares Relationships: [] for every
  // table, so embedded joins aren't available regardless.
  const supabase = await createClient();
  const variantIds = [...new Set(publications.map((publication) => publication.content_variant_id))];

  const { data: variants, error: variantsError } = await supabase
    .from("content_variants")
    .select("id, content_version_id, platform, caption")
    .eq("workspace_id", workspace.id)
    .in("id", variantIds.length > 0 ? variantIds : ["00000000-0000-0000-0000-000000000000"]);
  if (variantsError) {
    throw new Error(`Failed to load content variants for calendar: ${variantsError.message}`);
  }
  const variantById = new Map((variants ?? []).map((variant) => [variant.id, variant]));

  const versionIds = [...new Set((variants ?? []).map((variant) => variant.content_version_id))];
  const { data: versions, error: versionsError } = await supabase
    .from("content_versions")
    .select("id, content_id")
    .eq("workspace_id", workspace.id)
    .in("id", versionIds.length > 0 ? versionIds : ["00000000-0000-0000-0000-000000000000"]);
  if (versionsError) {
    throw new Error(`Failed to load content versions for calendar: ${versionsError.message}`);
  }
  const versionById = new Map((versions ?? []).map((version) => [version.id, version]));

  const contentIds = [...new Set((versions ?? []).map((version) => version.content_id))];
  const { data: contentRows, error: contentError } = await supabase
    .from("content")
    .select("id, title")
    .eq("workspace_id", workspace.id)
    .in("id", contentIds.length > 0 ? contentIds : ["00000000-0000-0000-0000-000000000000"]);
  if (contentError) {
    throw new Error(`Failed to load content for calendar: ${contentError.message}`);
  }
  const contentById = new Map((contentRows ?? []).map((row) => [row.id, row]));

  const events: CalendarEvent[] = publications.flatMap((publication) => {
    const variant = variantById.get(publication.content_variant_id);
    const version = variant ? versionById.get(variant.content_version_id) : undefined;
    const content = version ? contentById.get(version.content_id) : undefined;
    const account = accountById.get(publication.social_account_id);

    // A publication whose variant/version/content chain no longer
    // resolves within this workspace (should not happen given the
    // composite tenant FKs, but the fields are nullable joins from the
    // page's perspective) is skipped rather than rendered with fabricated
    // placeholder content.
    if (!content) return [];

    return [
      {
        publicationId: publication.id,
        contentId: content.id,
        contentTitle: content.title,
        variantPlatform: variant?.platform ?? null,
        variantCaption: variant?.caption ?? null,
        accountPlatform: account?.platform ?? null,
        accountName: account?.account_name ?? null,
        accountHandle: account?.account_handle ?? null,
        status: publication.status,
        scheduledAt: publication.scheduled_at as string,
        externalUrl: publication.external_url,
      },
    ];
  });

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Content Calendar"
        title="Calendar"
        description="A live view of scheduled and completed publications for this workspace."
      />
      <CalendarView
        workspaceSlug={slug}
        year={year}
        month={month}
        statusFilter={statusFilter?.[0]}
        events={events}
        canEdit={canEdit}
      />
    </div>
  );
}
