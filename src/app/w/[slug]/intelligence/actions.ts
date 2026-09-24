"use server";

import { redirect } from "next/navigation";

import {
  createOpportunity,
  createSignal,
  createSignalSource,
  createSignalTopic,
  createTopic,
} from "@/server/services/intelligence";
import { getWorkspaceBySlug } from "@/server/services/workspaces";

/**
 * Every action re-resolves workspace_id from the slug via getWorkspaceBySlug
 * (RLS-scoped to the current user's membership) rather than trusting a
 * workspace_id posted from the client (Engineering Blueprint §8) — same
 * pattern as content/actions.ts and settings/actions.ts.
 *
 * All actions are thin wrappers around the existing, unmodified
 * intelligence.ts functions — editor authorization is enforced by those
 * functions themselves (assertEditor), not duplicated here. No
 * revalidatePath call is used anywhere in this codebase's action files;
 * redirecting back to a fully server-rendered route (no fetch-cache
 * involved anywhere in this app) is the established, sufficient
 * convention for showing fresh data after a mutation.
 *
 * MVP-4.4: createSignalAction optionally links the newly-created signal to
 * an existing topic by calling createSignalTopic directly (the plain
 * service function, not createSignalTopicAction) immediately after
 * createSignal succeeds — both calls share the same resolved workspace,
 * preserving tenant scoping. createSignalTopicAction is exposed separately
 * as its own thin wrapper (not invoked by the Signal form in this slice,
 * which only ever links at creation time) for the one relationship this
 * domain defines. No relevance_score is accepted anywhere — canonical
 * documents define no scale or semantics for it (Database Architecture
 * §4), so it is never exposed.
 */
async function resolveWorkspaceOrThrow(slug: string) {
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new Error("Workspace not found or not accessible");
  }
  return workspace;
}

export async function createTopicAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    throw new Error("Topic name is required");
  }
  const description = String(formData.get("description") ?? "").trim();

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createTopic(workspace.id, {
    name,
    description: description || undefined,
  });

  redirect(`/w/${slug}/intelligence`);
}

export async function createOpportunityAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const topicId = String(formData.get("topic_id") ?? "").trim();
  if (!title) {
    throw new Error("Opportunity title is required");
  }
  if (!topicId) {
    throw new Error("An existing Topic is required");
  }
  const description = String(formData.get("description") ?? "").trim();
  const rationale = String(formData.get("rationale") ?? "").trim();
  const brandId = String(formData.get("brand_id") ?? "").trim();

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createOpportunity(workspace.id, {
    topicId,
    title,
    description: description || undefined,
    rationale: rationale || undefined,
    brandId: brandId || undefined,
  });

  redirect(`/w/${slug}/intelligence`);
}

export async function createSignalSourceAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim();
  const sourceType = String(formData.get("source_type") ?? "").trim();
  if (!name || !provider || !sourceType) {
    throw new Error("Name, provider, and source type are required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  // No status is passed — createSignalSource's own default (Database
  // Architecture §4: 'active') applies. No configuration is passed —
  // nothing legitimate exists to put there yet (see module header).
  await createSignalSource(workspace.id, { name, provider, sourceType });

  redirect(`/w/${slug}/intelligence`);
}

export async function createSignalAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const sourceId = String(formData.get("source_id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (!sourceId) {
    throw new Error("A Signal Source is required");
  }
  if (!title) {
    throw new Error("Signal title is required");
  }
  const sourceUrl = String(formData.get("source_url") ?? "").trim();
  const contentText = String(formData.get("content_text") ?? "").trim();
  const authorName = String(formData.get("author_name") ?? "").trim();
  const topicId = String(formData.get("topic_id") ?? "").trim();

  const workspace = await resolveWorkspaceOrThrow(slug);
  const signal = await createSignal(workspace.id, {
    sourceId,
    title,
    sourceUrl: sourceUrl || undefined,
    contentText: contentText || undefined,
    authorName: authorName || undefined,
    // external_id, captured_at, engagement_data, raw_data, and
    // published_at are intentionally never submitted from this form — see
    // module header and the approved MVP-4.4 scope.
  });

  if (topicId) {
    await createSignalTopic(workspace.id, { signalId: signal.id, topicId });
  }

  redirect(`/w/${slug}/intelligence`);
}

export async function createSignalTopicAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const signalId = String(formData.get("signal_id") ?? "").trim();
  const topicId = String(formData.get("topic_id") ?? "").trim();
  if (!signalId || !topicId) {
    throw new Error("Both a Signal and a Topic are required");
  }

  const workspace = await resolveWorkspaceOrThrow(slug);
  await createSignalTopic(workspace.id, { signalId, topicId });

  redirect(`/w/${slug}/intelligence`);
}
