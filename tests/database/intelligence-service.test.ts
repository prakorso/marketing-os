import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createOpportunity,
  createSignal,
  createSignalSource,
  createSignalTopic,
  createTopic,
  listOpportunities,
  listSignalSources,
  listSignalTopics,
  listSignals,
  listTopics,
} from "@/server/services/intelligence";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Service-level tests for MVP-4.1's intelligence.ts list/create functions,
 * following the existing analytics-service.test.ts / notifications-
 * service.test.ts convention of calling the REAL exported service
 * functions, authenticated via a real signed-in test user's bearer token
 * (setTestAccessToken), against the local Supabase stack.
 *
 * Covers: empty-list behavior (checked first, before any row exists),
 * basic create/list behavior for all five domains, editor-only
 * authorization on every create function, viewer read access on every
 * list function, and that createOpportunity never writes a score (no
 * scoring formula exists anywhere in canonical text — MVP-4.1 approved
 * decision).
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("Intelligence service — list/create functions", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;

  let sourceId: string;
  let signalId: string;
  let topicId: string;

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Intelligence Service Tenant",
      p_slug: `intelligence-service-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { error: viewerError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (viewerError) throw new Error(`Failed to add viewer to workspace: ${viewerError.message}`);

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);
  });

  afterAll(async () => {
    setTestAccessToken(null);
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  it("returns an empty array for each domain before anything is created", async () => {
    expect(await listSignalSources(workspaceId)).toEqual([]);
    expect(await listSignals(workspaceId)).toEqual([]);
    expect(await listTopics(workspaceId)).toEqual([]);
    expect(await listSignalTopics(workspaceId)).toEqual([]);
    expect(await listOpportunities(workspaceId)).toEqual([]);
  });

  it("creates and lists a signal source", async () => {
    const source = await createSignalSource(workspaceId, { provider: "reddit", sourceType: "forum", name: "Fixture Source" });
    expect(source.workspace_id).toBe(workspaceId);
    expect(source.status).toBe("active");
    sourceId = source.id;

    const rows = await listSignalSources(workspaceId);
    expect(rows.map((r) => r.id)).toContain(source.id);
  });

  it("creates and lists a signal", async () => {
    const signal = await createSignal(workspaceId, { sourceId, title: "Fixture Signal" });
    expect(signal.workspace_id).toBe(workspaceId);
    expect(signal.source_id).toBe(sourceId);
    signalId = signal.id;

    const rows = await listSignals(workspaceId);
    expect(rows.map((r) => r.id)).toContain(signal.id);
  });

  it("creates and lists a topic", async () => {
    const topic = await createTopic(workspaceId, { name: "Fixture Topic" });
    expect(topic.workspace_id).toBe(workspaceId);
    expect(topic.status).toBe("active");
    topicId = topic.id;

    const rows = await listTopics(workspaceId);
    expect(rows.map((r) => r.id)).toContain(topic.id);
  });

  it("creates and lists a signal-topic relationship (explicit/manual link only)", async () => {
    const link = await createSignalTopic(workspaceId, { signalId, topicId });
    expect(link.signal_id).toBe(signalId);
    expect(link.topic_id).toBe(topicId);

    const rows = await listSignalTopics(workspaceId);
    expect(rows.some((r) => r.signal_id === signalId && r.topic_id === topicId)).toBe(true);
  });

  it("creates and lists an opportunity, and never writes a score", async () => {
    const opportunity = await createOpportunity(workspaceId, { topicId, title: "Fixture Opportunity" });
    expect(opportunity.workspace_id).toBe(workspaceId);
    expect(opportunity.topic_id).toBe(topicId);
    expect(opportunity.status).toBe("open");
    expect(opportunity.score).toBeNull();

    const rows = await listOpportunities(workspaceId);
    expect(rows.map((r) => r.id)).toContain(opportunity.id);
  });

  it("create functions are editor-only — a viewer is denied", async () => {
    const {
      data: { session: viewerSession },
    } = await viewer.client.auth.getSession();
    setTestAccessToken(viewerSession!.access_token);
    try {
      await expect(createSignalSource(workspaceId, { provider: "x", sourceType: "y", name: "z" })).rejects.toThrow(/permission/);
      await expect(createSignal(workspaceId, { sourceId })).rejects.toThrow(/permission/);
      await expect(createTopic(workspaceId, { name: "denied" })).rejects.toThrow(/permission/);
      await expect(createSignalTopic(workspaceId, { signalId, topicId })).rejects.toThrow(/permission/);
      await expect(createOpportunity(workspaceId, { topicId, title: "denied" })).rejects.toThrow(/permission/);
    } finally {
      const {
        data: { session: editorSession },
      } = await editor.client.auth.getSession();
      setTestAccessToken(editorSession!.access_token);
    }
  });

  it("list functions are readable by a viewer", async () => {
    const {
      data: { session: viewerSession },
    } = await viewer.client.auth.getSession();
    setTestAccessToken(viewerSession!.access_token);
    try {
      expect((await listSignalSources(workspaceId)).length).toBeGreaterThan(0);
      expect((await listSignals(workspaceId)).length).toBeGreaterThan(0);
      expect((await listTopics(workspaceId)).length).toBeGreaterThan(0);
      expect((await listSignalTopics(workspaceId)).length).toBeGreaterThan(0);
      expect((await listOpportunities(workspaceId)).length).toBeGreaterThan(0);
    } finally {
      const {
        data: { session: editorSession },
      } = await editor.client.auth.getSession();
      setTestAccessToken(editorSession!.access_token);
    }
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping intelligence-service.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
