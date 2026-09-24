import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { listBrandsForWorkspace } from "@/server/services/brands";
import {
  listOpportunities,
  listSignals,
  listSignalSources,
  listSignalTopics,
  listTopics,
} from "@/server/services/intelligence";
import { getCurrentUserRole, getWorkspaceBySlug } from "@/server/services/workspaces";
import type { OpportunityStatus } from "@/types/database";

import { createOpportunityAction, createSignalAction, createSignalSourceAction, createTopicAction } from "./actions";

/**
 * MVP-4.3 Intelligence Creation Consumer + MVP-4.4 Signal Intelligence
 * Consumer — a minimal management surface for Signal Sources, Signals,
 * Topics, and Opportunities (Database Architecture §4, DECISIONS #11).
 * Deliberately NOT a dashboard: no charts, no filters, no aggregation, no
 * score, no AI, no external source integration. Every record here is
 * manually created/observed — nothing on this page implies automatic
 * ingestion, live provider sync, social listening, or AI classification.
 *
 * Topic/Signal Source name resolution (for Opportunities and Signals,
 * respectively) reuses data already fetched for this page's own select
 * dropdowns (plain in-memory Maps) — no additional query is introduced.
 * MVP-4.4 added Signal Sources and Signals sections and extended data
 * loading, without modifying intelligence.ts.
 *
 * MVP-5.6 adds Topic -> Signal reverse visibility (PRD §8: "I can inspect
 * the source behind a topic") to the existing Topic cards below, reusing
 * the signals/signalTopics already loaded for the Signals section — no new
 * query, no new service function, and intelligence.ts is unmodified.
 */

const inputClass =
  "rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-secondary";
const labelClass = "font-label text-label-sm font-semibold text-on-surface";
const sectionEyebrowClass = "font-label text-label-sm uppercase tracking-wider text-secondary font-semibold";

const OPPORTUNITY_STATUS_BADGE_VARIANT: Record<OpportunityStatus, "neutral" | "active" | "alert"> = {
  open: "active",
  in_progress: "active",
  actioned: "neutral",
  expired: "alert",
  dismissed: "neutral",
};

export default async function IntelligencePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    notFound();
  }

  const [topics, opportunities, brands, signalSources, signals, signalTopics, role] = await Promise.all([
    listTopics(workspace.id),
    listOpportunities(workspace.id),
    listBrandsForWorkspace(workspace.id),
    listSignalSources(workspace.id),
    listSignals(workspace.id),
    listSignalTopics(workspace.id),
    getCurrentUserRole(workspace.id),
  ]);
  const canEdit = role === "owner" || role === "admin" || role === "marketer";

  const topicNameById = new Map(topics.map((topic) => [topic.id, topic.name]));
  const signalSourceNameById = new Map(signalSources.map((source) => [source.id, source.name]));
  const topicNamesBySignalId = new Map<string, string[]>();
  for (const link of signalTopics) {
    const names = topicNamesBySignalId.get(link.signal_id) ?? [];
    const topicName = topicNameById.get(link.topic_id);
    if (topicName) names.push(topicName);
    topicNamesBySignalId.set(link.signal_id, names);
  }

  // MVP-5.6: Topic -> Signal reverse visibility (PRD §8: "I can inspect the
  // source behind a topic"). Reuses signals/signalTopics already loaded
  // above for the Signals section — no new query, no new service function.
  const signalTitleById = new Map(signals.map((signal) => [signal.id, signal.title ?? "Untitled signal"]));
  const signalTitlesByTopicId = new Map<string, string[]>();
  for (const link of signalTopics) {
    const titles = signalTitlesByTopicId.get(link.topic_id) ?? [];
    const signalTitle = signalTitleById.get(link.signal_id);
    if (signalTitle) titles.push(signalTitle);
    signalTitlesByTopicId.set(link.topic_id, titles);
  }

  return (
    <div className="flex flex-col gap-space-lg">
      <PageHeader
        eyebrow="MOS // Intelligence"
        title="Intelligence"
        description="Manually recorded Signal Sources, Signals, Topics, and Opportunities. No AI, no external source integration, no live provider sync, no scoring — this is a plain management surface for observations you enter yourself."
      />

      <div className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Topics</span>

        {topics.length === 0 ? (
          <EmptyState
            title="No Topics yet"
            description="Topics are created manually — add one below to begin grouping Opportunities under it."
          />
        ) : (
          <div className="flex flex-col gap-space-sm">
            {topics.map((topic) => {
              const linkedSignalTitles = signalTitlesByTopicId.get(topic.id) ?? [];
              return (
                <Card key={topic.id} className="flex flex-col gap-space-xs">
                  <span className="font-body text-body-md font-semibold text-on-surface">{topic.name}</span>
                  {topic.description ? (
                    <span className="font-label text-label-sm text-on-surface-variant">{topic.description}</span>
                  ) : null}
                  <div className="mt-space-xs flex flex-col gap-space-xs border-t border-outline-variant pt-space-xs">
                    <span className="font-label text-label-sm uppercase tracking-wider text-on-surface-variant">
                      Signals
                    </span>
                    {linkedSignalTitles.length > 0 ? (
                      <ul className="flex flex-col gap-space-xs">
                        {linkedSignalTitles.map((title, index) => (
                          <li key={index} className="font-body text-body-sm text-on-surface-variant">
                            {title}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="font-body text-body-sm text-on-surface-variant">No signals linked</span>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {canEdit ? (
          <Card className="max-w-lg">
            <span className={sectionEyebrowClass}>Create Topic</span>
            <form action={createTopicAction} className="mt-space-md flex flex-col gap-space-md">
              <input type="hidden" name="slug" value={slug} />
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="topic-name" className={labelClass}>
                  Name
                </label>
                <input id="topic-name" name="name" required className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="topic-description" className={labelClass}>
                  Description (optional)
                </label>
                <input id="topic-description" name="description" className={inputClass} />
              </div>
              <Button type="submit" className="self-start">
                Create Topic
              </Button>
            </form>
          </Card>
        ) : null}
      </div>

      <div className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Opportunities</span>

        {opportunities.length === 0 ? (
          <EmptyState
            title="No Opportunities yet"
            description={
              topics.length === 0
                ? "Create a Topic first, then Opportunities can be created under it."
                : "Add an Opportunity below and link it to an existing Topic."
            }
          />
        ) : (
          <div className="flex flex-col gap-space-sm">
            {opportunities.map((opportunity) => (
              <Card key={opportunity.id} className="flex flex-col gap-space-xs">
                <div className="flex items-center gap-space-sm">
                  <span className="font-body text-body-md font-semibold text-on-surface">{opportunity.title}</span>
                  <Badge variant={OPPORTUNITY_STATUS_BADGE_VARIANT[opportunity.status]}>{opportunity.status}</Badge>
                </div>
                <span className="font-label text-label-sm text-on-surface-variant">
                  Topic: {topicNameById.get(opportunity.topic_id) ?? "—"}
                </span>
                {opportunity.description ? (
                  <span className="font-body text-body-sm text-on-surface-variant">{opportunity.description}</span>
                ) : null}
              </Card>
            ))}
          </div>
        )}

        {canEdit && topics.length > 0 ? (
          <Card className="max-w-lg">
            <span className={sectionEyebrowClass}>Create Opportunity</span>
            <form action={createOpportunityAction} className="mt-space-md flex flex-col gap-space-md">
              <input type="hidden" name="slug" value={slug} />
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="opportunity-title" className={labelClass}>
                  Title
                </label>
                <input id="opportunity-title" name="title" required className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="opportunity-topic" className={labelClass}>
                  Topic
                </label>
                <select id="opportunity-topic" name="topic_id" required className={inputClass}>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.name}
                    </option>
                  ))}
                </select>
              </div>
              {brands.length > 0 ? (
                <div className="flex flex-col gap-space-xs">
                  <label htmlFor="opportunity-brand" className={labelClass}>
                    Brand (optional)
                  </label>
                  <select id="opportunity-brand" name="brand_id" defaultValue="" className={inputClass}>
                    <option value="">None</option>
                    {brands.map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="opportunity-description" className={labelClass}>
                  Description (optional)
                </label>
                <input id="opportunity-description" name="description" className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="opportunity-rationale" className={labelClass}>
                  Rationale (optional)
                </label>
                <input id="opportunity-rationale" name="rationale" className={inputClass} />
              </div>
              <Button type="submit" className="self-start">
                Create Opportunity
              </Button>
            </form>
          </Card>
        ) : null}
      </div>

      <div className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Signal Sources</span>
        <p className="font-body text-body-sm text-on-surface-variant">
          Where you manually record something was observed. This is not a live connection — no source here is
          automatically polled or synchronized.
        </p>

        {signalSources.length === 0 ? (
          <EmptyState
            title="No Signal Sources yet"
            description="Signal Sources are created manually — add one below before recording Signals."
          />
        ) : (
          <div className="flex flex-col gap-space-sm">
            {signalSources.map((source) => (
              <Card key={source.id} className="flex flex-col gap-space-xs">
                <div className="flex items-center gap-space-sm">
                  <span className="font-body text-body-md font-semibold text-on-surface">{source.name}</span>
                  <Badge variant="neutral">{source.status}</Badge>
                </div>
                <span className="font-label text-label-sm text-on-surface-variant">
                  {source.provider} · {source.source_type}
                </span>
              </Card>
            ))}
          </div>
        )}

        {canEdit ? (
          <Card className="max-w-lg">
            <span className={sectionEyebrowClass}>Create Signal Source</span>
            <form action={createSignalSourceAction} className="mt-space-md flex flex-col gap-space-md">
              <input type="hidden" name="slug" value={slug} />
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="source-name" className={labelClass}>
                  Name
                </label>
                <input id="source-name" name="name" required className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="source-provider" className={labelClass}>
                  Provider
                </label>
                <input
                  id="source-provider"
                  name="provider"
                  required
                  placeholder="e.g. Reddit, industry newsletter, manual"
                  className={inputClass}
                />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="source-type" className={labelClass}>
                  Source type
                </label>
                <input
                  id="source-type"
                  name="source_type"
                  required
                  placeholder="e.g. forum, article, conversation"
                  className={inputClass}
                />
              </div>
              <Button type="submit" className="self-start">
                Create Signal Source
              </Button>
            </form>
          </Card>
        ) : null}
      </div>

      <div className="flex flex-col gap-space-md">
        <span className={sectionEyebrowClass}>Signals</span>
        <p className="font-body text-body-sm text-on-surface-variant">
          Observed information you record yourself (DECISIONS #11). No automatic ingestion, social listening, or
          AI extraction happens here.
        </p>

        {signals.length === 0 ? (
          <EmptyState
            title="No Signals yet"
            description={
              signalSources.length === 0
                ? "Create a Signal Source first, then Signals can be recorded under it."
                : "Add a Signal below, referencing an existing Signal Source."
            }
          />
        ) : (
          <div className="flex flex-col gap-space-sm">
            {signals.map((signal) => {
              const linkedTopics = topicNamesBySignalId.get(signal.id) ?? [];
              return (
                <Card key={signal.id} className="flex flex-col gap-space-xs">
                  <span className="font-body text-body-md font-semibold text-on-surface">
                    {signal.title ?? "Untitled signal"}
                  </span>
                  <span className="font-label text-label-sm text-on-surface-variant">
                    Source: {signalSourceNameById.get(signal.source_id) ?? "—"}
                  </span>
                  {signal.content_text ? (
                    <span className="font-body text-body-sm text-on-surface-variant">{signal.content_text}</span>
                  ) : null}
                  {signal.author_name ? (
                    <span className="font-label text-label-sm text-on-surface-variant">By {signal.author_name}</span>
                  ) : null}
                  {signal.source_url ? (
                    <a
                      href={signal.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-label text-label-sm text-secondary underline underline-offset-2"
                    >
                      {signal.source_url}
                    </a>
                  ) : null}
                  <span className="font-label text-label-sm text-on-surface-variant">
                    {linkedTopics.length > 0 ? `Linked to: ${linkedTopics.join(", ")}` : "Not linked to a Topic"}
                  </span>
                </Card>
              );
            })}
          </div>
        )}

        {canEdit && signalSources.length > 0 ? (
          <Card className="max-w-lg">
            <span className={sectionEyebrowClass}>Create Signal</span>
            <form action={createSignalAction} className="mt-space-md flex flex-col gap-space-md">
              <input type="hidden" name="slug" value={slug} />
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="signal-source" className={labelClass}>
                  Signal Source
                </label>
                <select id="signal-source" name="source_id" required className={inputClass}>
                  {signalSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="signal-title" className={labelClass}>
                  Title
                </label>
                <input id="signal-title" name="title" required className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="signal-source-url" className={labelClass}>
                  Source URL (optional)
                </label>
                <input id="signal-source-url" name="source_url" className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="signal-content-text" className={labelClass}>
                  Content (optional)
                </label>
                <input id="signal-content-text" name="content_text" className={inputClass} />
              </div>
              <div className="flex flex-col gap-space-xs">
                <label htmlFor="signal-author-name" className={labelClass}>
                  Author (optional)
                </label>
                <input id="signal-author-name" name="author_name" className={inputClass} />
              </div>
              {topics.length > 0 ? (
                <div className="flex flex-col gap-space-xs">
                  <label htmlFor="signal-topic" className={labelClass}>
                    Topic (optional)
                  </label>
                  <select id="signal-topic" name="topic_id" defaultValue="" className={inputClass}>
                    <option value="">None</option>
                    {topics.map((topic) => (
                      <option key={topic.id} value={topic.id}>
                        {topic.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <Button type="submit" className="self-start">
                Create Signal
              </Button>
            </form>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
