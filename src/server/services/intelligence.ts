import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { Opportunity, Signal, SignalSource, SignalTopic, Topic } from "@/types/database";

/**
 * MVP-4.1 Intelligence Foundation — plain workspace-scoped list/create
 * functions for marqos_signal_sources, marqos_signals, topics,
 * signal_topics, and opportunities (Database Architecture §4, Engineering
 * Blueprint §19, DECISIONS #11).
 *
 * marqos_signal_sources/marqos_signals are intentionally prefixed, not
 * named signal_sources/signals (MVP-5.24/MVP-5.25): the hosted Supabase
 * project also contains a differently-shaped, pre-existing table pair of
 * those names belonging to a separate application sharing the project.
 * topics/signal_topics/opportunities do not collide and keep their
 * original names.
 *
 * HARD BOUNDARY (approved MVP-4.1 decision, not an oversight): no AI
 * classifier, mock classifier, "suggest topic" stub, or AI provider call
 * exists anywhere in this module. createSignalTopic() is the only way
 * signal_topics rows are created — an explicit/manual relational link, not
 * an inference. The AI-driven half of Blueprint §19's "topic grouping uses
 * AI/provider text classification... combined with relational grouping"
 * is deferred to a later, separately audited slice, once the AI domain
 * (ai_jobs, prompt_versions) exists.
 *
 * List functions are un-gated by assertEditor: RLS's existing
 * workspace-member SELECT policy is the authorization boundary for reads,
 * matching every other list function in this codebase
 * (listPublicationsForWorkspace, listNotificationsForUser,
 * listPublicationMetricSnapshots, listContentPerformanceScores). Create
 * functions call assertEditor, matching this codebase's standard
 * editor-write pattern (owner/admin/marketer).
 *
 * No pagination, no filters beyond workspace scope, no aggregation. No
 * function in this module ever writes `opportunities.score` — Database
 * Architecture §4 specifies the column, but no scoring formula exists
 * anywhere in canonical text, and createOpportunity()'s input type
 * deliberately does not accept one.
 */

async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to manage intelligence data in this workspace");
  }
}

// =============================================================================
// marqos_signal_sources
// =============================================================================

export async function listSignalSources(workspaceId: string): Promise<SignalSource[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marqos_signal_sources")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list signal sources: ${error.message}`);
  }
  return data ?? [];
}

export type CreateSignalSourceInput = {
  provider: string;
  sourceType: string;
  name: string;
  status?: SignalSource["status"];
  /** Non-secret configuration only — never a credential (Database Architecture §4). */
  configuration?: Record<string, unknown>;
};

export async function createSignalSource(workspaceId: string, input: CreateSignalSourceInput): Promise<SignalSource> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marqos_signal_sources")
    .insert({
      workspace_id: workspaceId,
      provider: input.provider,
      source_type: input.sourceType,
      name: input.name,
      status: input.status,
      configuration: input.configuration,
    })
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to create signal source: ${error.message}`);
  }
  return data;
}

// =============================================================================
// marqos_signals
// =============================================================================

export async function listSignals(workspaceId: string): Promise<Signal[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marqos_signals")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("captured_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list signals: ${error.message}`);
  }
  return data ?? [];
}

export type CreateSignalInput = {
  sourceId: string;
  externalId?: string;
  sourceUrl?: string;
  title?: string;
  contentText?: string;
  authorName?: string;
  publishedAt?: string;
  capturedAt?: string;
  engagementData?: Record<string, unknown>;
  rawData?: Record<string, unknown>;
};

export async function createSignal(workspaceId: string, input: CreateSignalInput): Promise<Signal> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("marqos_signals")
    .insert({
      workspace_id: workspaceId,
      source_id: input.sourceId,
      external_id: input.externalId,
      source_url: input.sourceUrl,
      title: input.title,
      content_text: input.contentText,
      author_name: input.authorName,
      published_at: input.publishedAt,
      captured_at: input.capturedAt,
      engagement_data: input.engagementData,
      raw_data: input.rawData,
    })
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to create signal: ${error.message}`);
  }
  return data;
}

// =============================================================================
// topics
// =============================================================================

export async function listTopics(workspaceId: string): Promise<Topic[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("topics")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list topics: ${error.message}`);
  }
  return data ?? [];
}

export type CreateTopicInput = {
  name: string;
  description?: string;
  status?: Topic["status"];
};

export async function createTopic(workspaceId: string, input: CreateTopicInput): Promise<Topic> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("topics")
    .insert({
      workspace_id: workspaceId,
      name: input.name,
      description: input.description,
      status: input.status,
    })
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to create topic: ${error.message}`);
  }
  return data;
}

// =============================================================================
// signal_topics — explicit/manual relational grouping only (HARD BOUNDARY, see module header)
// =============================================================================

export async function listSignalTopics(workspaceId: string): Promise<SignalTopic[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("signal_topics")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list signal-topic relationships: ${error.message}`);
  }
  return data ?? [];
}

export type CreateSignalTopicInput = {
  signalId: string;
  topicId: string;
  relevanceScore?: number;
};

export async function createSignalTopic(workspaceId: string, input: CreateSignalTopicInput): Promise<SignalTopic> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("signal_topics")
    .insert({
      workspace_id: workspaceId,
      signal_id: input.signalId,
      topic_id: input.topicId,
      relevance_score: input.relevanceScore,
    })
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to create signal-topic relationship: ${error.message}`);
  }
  return data;
}

// =============================================================================
// opportunities
// =============================================================================

export async function listOpportunities(workspaceId: string): Promise<Opportunity[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list opportunities: ${error.message}`);
  }
  return data ?? [];
}

export type CreateOpportunityInput = {
  topicId: string;
  title: string;
  brandId?: string;
  description?: string;
  rationale?: string;
  status?: Opportunity["status"];
  detectedAt?: string;
  expiresAt?: string;
  // Deliberately no `score` field — see module header comment.
};

export async function createOpportunity(workspaceId: string, input: CreateOpportunityInput): Promise<Opportunity> {
  await assertEditor(workspaceId);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("opportunities")
    .insert({
      workspace_id: workspaceId,
      topic_id: input.topicId,
      title: input.title,
      brand_id: input.brandId,
      description: input.description,
      rationale: input.rationale,
      status: input.status,
      detected_at: input.detectedAt,
      expires_at: input.expiresAt,
    })
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to create opportunity: ${error.message}`);
  }
  return data;
}
