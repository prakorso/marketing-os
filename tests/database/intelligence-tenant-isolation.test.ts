import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";

/**
 * RLS / tenant isolation tests for the MVP-4.1 Intelligence Foundation
 * migration (marqos_signal_sources, marqos_signals, topics, signal_topics,
 * opportunities), per Database Architecture §4, §16, §19-21 and
 * Engineering Blueprint §19/§23. Also covers the content_briefs.
 * opportunity_id composite-FK completion added by the same migration.
 * marqos_signal_sources/marqos_signals are prefixed, not named
 * signal_sources/signals, to coexist with a differently-shaped, unrelated
 * table pair of those names already present in the hosted Supabase project
 * (MVP-5.24/MVP-5.25).
 *
 * Fixture chain per workspace: signal_source -> signal -> topic ->
 * signal_topics (linking signal+topic) -> opportunity (linked to topic,
 * optionally to a brand). A parallel, smaller fixture set exists in a
 * second workspace purely to exercise cross-workspace composite-FK
 * rejection.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning.
 */
describe.skipIf(!hasLocalSupabase)("Intelligence RLS — tenant isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;

  let sourceId: string;
  let signalId: string;
  let topicId: string;
  let opportunityId: string;
  let brandId: string;

  let otherSourceId: string;
  let otherSignalId: string;
  let otherTopicId: string;
  let otherOpportunityId: string;

  const createdSignalTopicIds: Array<{ signal_id: string; topic_id: string }> = [];

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Intelligence Tenant A",
      p_slug: `intelligence-a-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { error: viewerError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (viewerError) throw new Error(`Failed to add viewer to workspace: ${viewerError.message}`);

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Intelligence Tenant B",
      p_slug: `intelligence-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const { data: brand, error: brandError } = await editor.client
      .from("brands")
      .insert({ workspace_id: workspaceId, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) throw new Error(`Failed to create brand fixture: ${brandError?.message}`);
    brandId = brand.id;

    const { data: source, error: sourceError } = await editor.client
      .from("marqos_signal_sources")
      .insert({ workspace_id: workspaceId, provider: "reddit", source_type: "forum", name: "Fixture Source" })
      .select()
      .single();
    if (sourceError || !source) throw new Error(`Failed to create signal_source fixture: ${sourceError?.message}`);
    sourceId = source.id;

    const { data: signal, error: signalError } = await editor.client
      .from("marqos_signals")
      .insert({ workspace_id: workspaceId, source_id: sourceId, title: "Fixture Signal" })
      .select()
      .single();
    if (signalError || !signal) throw new Error(`Failed to create signal fixture: ${signalError?.message}`);
    signalId = signal.id;

    const { data: topic, error: topicError } = await editor.client
      .from("topics")
      .insert({ workspace_id: workspaceId, name: "Fixture Topic" })
      .select()
      .single();
    if (topicError || !topic) throw new Error(`Failed to create topic fixture: ${topicError?.message}`);
    topicId = topic.id;

    const { data: opportunity, error: opportunityError } = await editor.client
      .from("opportunities")
      .insert({ workspace_id: workspaceId, topic_id: topicId, brand_id: brandId, title: "Fixture Opportunity" })
      .select()
      .single();
    if (opportunityError || !opportunity) throw new Error(`Failed to create opportunity fixture: ${opportunityError?.message}`);
    opportunityId = opportunity.id;

    // Parallel, minimal fixture set in the second workspace.
    const { data: otherSource } = await outsider.client
      .from("marqos_signal_sources")
      .insert({ workspace_id: otherWorkspaceId, provider: "reddit", source_type: "forum", name: "Other Source" })
      .select()
      .single();
    otherSourceId = otherSource!.id;

    const { data: otherSignal } = await outsider.client
      .from("marqos_signals")
      .insert({ workspace_id: otherWorkspaceId, source_id: otherSourceId, title: "Other Signal" })
      .select()
      .single();
    otherSignalId = otherSignal!.id;

    const { data: otherTopic } = await outsider.client
      .from("topics")
      .insert({ workspace_id: otherWorkspaceId, name: "Other Topic" })
      .select()
      .single();
    otherTopicId = otherTopic!.id;

    const { data: otherOpportunity } = await outsider.client
      .from("opportunities")
      .insert({ workspace_id: otherWorkspaceId, topic_id: otherTopicId, title: "Other Opportunity" })
      .select()
      .single();
    otherOpportunityId = otherOpportunity!.id;
  });

  afterAll(async () => {
    if (createdSignalTopicIds.length > 0) {
      for (const { signal_id, topic_id } of createdSignalTopicIds) {
        await admin.from("signal_topics").delete().eq("signal_id", signal_id).eq("topic_id", topic_id);
      }
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("signal_sources", () => {
    it("allows a workspace member (viewer included) to SELECT", async () => {
      const { data, error } = await viewer.client.from("marqos_signal_sources").select("*").eq("id", sourceId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(sourceId);
    });

    it("hides rows from a non-member", async () => {
      const { data, error } = await outsider.client.from("marqos_signal_sources").select("*").eq("id", sourceId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("allows an editor to INSERT", async () => {
      const { data, error } = await editor.client
        .from("marqos_signal_sources")
        .insert({ workspace_id: workspaceId, provider: "twitter", source_type: "social", name: "Second Source" })
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.id).toBeDefined();
    });

    it("denies a viewer from inserting", async () => {
      const { data, error } = await viewer.client
        .from("marqos_signal_sources")
        .insert({ workspace_id: workspaceId, provider: "twitter", source_type: "social", name: "Denied" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to UPDATE", async () => {
      const { data, error } = await editor.client
        .from("marqos_signal_sources")
        .update({ name: "Renamed Source" })
        .eq("id", sourceId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.name).toBe("Renamed Source");
    });

    it("denies a viewer from updating", async () => {
      const { data, error } = await viewer.client.from("marqos_signal_sources").update({ name: "Hijacked" }).eq("id", sourceId).select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("has no DELETE grant/policy: not even an editor can delete", async () => {
      const { error } = await editor.client.from("marqos_signal_sources").delete().eq("id", sourceId).select();
      expect(error).not.toBeNull();
      const { data: stillThere } = await admin.from("marqos_signal_sources").select("id").eq("id", sourceId).single();
      expect(stillThere?.id).toBe(sourceId);
    });

    it("never exposes credentials in configuration for a legitimately-configured source", async () => {
      const { data } = await editor.client.from("marqos_signal_sources").select("configuration").eq("id", sourceId).single();
      const serialized = JSON.stringify(data?.configuration ?? {});
      expect(serialized.toLowerCase()).not.toContain("token");
      expect(serialized.toLowerCase()).not.toContain("secret");
      expect(serialized.toLowerCase()).not.toContain("password");
    });
  });

  describe("signals", () => {
    it("allows a workspace member (viewer included) to SELECT", async () => {
      const { data, error } = await viewer.client.from("marqos_signals").select("*").eq("id", signalId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(signalId);
    });

    it("hides rows from a non-member", async () => {
      const { data, error } = await outsider.client.from("marqos_signals").select("*").eq("id", signalId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting", async () => {
      const { data, error } = await viewer.client
        .from("marqos_signals")
        .insert({ workspace_id: workspaceId, source_id: sourceId, title: "Denied" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to UPDATE", async () => {
      const { data, error } = await editor.client
        .from("marqos_signals")
        .update({ title: "Renamed Signal" })
        .eq("id", signalId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.title).toBe("Renamed Signal");
    });

    it("has no DELETE grant/policy: not even an editor can delete", async () => {
      const { error } = await editor.client.from("marqos_signals").delete().eq("id", signalId).select();
      expect(error).not.toBeNull();
    });
  });

  describe("topics", () => {
    it("allows a workspace member (viewer included) to SELECT", async () => {
      const { data, error } = await viewer.client.from("topics").select("*").eq("id", topicId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(topicId);
    });

    it("hides rows from a non-member", async () => {
      const { data, error } = await outsider.client.from("topics").select("*").eq("id", topicId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting", async () => {
      const { data, error } = await viewer.client.from("topics").insert({ workspace_id: workspaceId, name: "Denied" }).select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to UPDATE", async () => {
      const { data, error } = await editor.client
        .from("topics")
        .update({ status: "archived" })
        .eq("id", topicId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("archived");
      await editor.client.from("topics").update({ status: "active" }).eq("id", topicId);
    });

    it("has no DELETE grant/policy: not even an editor can delete", async () => {
      const { error } = await editor.client.from("topics").delete().eq("id", topicId).select();
      expect(error).not.toBeNull();
    });
  });

  describe("signal_topics", () => {
    it("allows an editor to INSERT an explicit relational link", async () => {
      const { data, error } = await editor.client
        .from("signal_topics")
        .insert({ workspace_id: workspaceId, signal_id: signalId, topic_id: topicId })
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.signal_id).toBe(signalId);
      expect(data?.topic_id).toBe(topicId);
      createdSignalTopicIds.push({ signal_id: signalId, topic_id: topicId });
    });

    it("allows a workspace member (viewer included) to SELECT", async () => {
      const { data, error } = await viewer.client
        .from("signal_topics")
        .select("*")
        .eq("signal_id", signalId)
        .eq("topic_id", topicId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.signal_id).toBe(signalId);
    });

    it("hides rows from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("signal_topics")
        .select("*")
        .eq("signal_id", signalId)
        .eq("topic_id", topicId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting", async () => {
      const { data: anotherTopic } = await editor.client
        .from("topics")
        .insert({ workspace_id: workspaceId, name: "Viewer-denied link topic" })
        .select()
        .single();
      const { data, error } = await viewer.client
        .from("signal_topics")
        .insert({ workspace_id: workspaceId, signal_id: signalId, topic_id: anotherTopic!.id })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("has no UPDATE grant/policy for any role", async () => {
      const { error } = await editor.client
        .from("signal_topics")
        .update({ relevance_score: 0.9 } as never)
        .eq("signal_id", signalId)
        .eq("topic_id", topicId)
        .select();
      expect(error).not.toBeNull();
    });

    it("has no DELETE grant/policy: not even an editor can delete", async () => {
      const { error } = await editor.client
        .from("signal_topics")
        .delete()
        .eq("signal_id", signalId)
        .eq("topic_id", topicId)
        .select();
      expect(error).not.toBeNull();
    });

    it("rejects a duplicate (signal_id, topic_id) pair", async () => {
      const { data, error } = await editor.client
        .from("signal_topics")
        .insert({ workspace_id: workspaceId, signal_id: signalId, topic_id: topicId })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace signal_id via the composite tenant FK", async () => {
      const { data, error } = await editor.client
        .from("signal_topics")
        .insert({ workspace_id: workspaceId, signal_id: otherSignalId, topic_id: topicId })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace topic_id via the composite tenant FK", async () => {
      const { data, error } = await editor.client
        .from("signal_topics")
        .insert({ workspace_id: workspaceId, signal_id: signalId, topic_id: otherTopicId })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("opportunities", () => {
    it("allows a workspace member (viewer included) to SELECT", async () => {
      const { data, error } = await viewer.client.from("opportunities").select("*").eq("id", opportunityId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(opportunityId);
    });

    it("hides rows from a non-member", async () => {
      const { data, error } = await outsider.client.from("opportunities").select("*").eq("id", opportunityId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting", async () => {
      const { data, error } = await viewer.client
        .from("opportunities")
        .insert({ workspace_id: workspaceId, topic_id: topicId, title: "Denied" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to UPDATE, but score stays untouched by default", async () => {
      const { data, error } = await editor.client
        .from("opportunities")
        .update({ status: "in_progress" })
        .eq("id", opportunityId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("in_progress");
      expect(data?.score).toBeNull();
      await editor.client.from("opportunities").update({ status: "open" }).eq("id", opportunityId);
    });

    it("has no DELETE grant/policy: not even an editor can delete", async () => {
      const { error } = await editor.client.from("opportunities").delete().eq("id", opportunityId).select();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace brand_id via the composite tenant FK", async () => {
      const { data: otherBrand } = await outsider.client
        .from("brands")
        .insert({ workspace_id: otherWorkspaceId, name: "Other Brand" })
        .select()
        .single();
      const { data, error } = await editor.client
        .from("opportunities")
        .insert({ workspace_id: workspaceId, topic_id: topicId, brand_id: otherBrand!.id, title: "Cross-tenant brand" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("content_briefs.opportunity_id (MVP-4.1 content integration)", () => {
    it("allows setting opportunity_id to an opportunity in the SAME workspace", async () => {
      const { data: brief, error: briefError } = await editor.client
        .from("content_briefs")
        .insert({ workspace_id: workspaceId, brand_id: brandId, title: "Fixture Brief", opportunity_id: opportunityId })
        .select()
        .single();
      expect(briefError).toBeNull();
      expect(brief?.opportunity_id).toBe(opportunityId);
    });

    it("rejects a cross-workspace opportunity_id via the composite tenant FK", async () => {
      const { data, error } = await editor.client
        .from("content_briefs")
        .insert({ workspace_id: workspaceId, brand_id: brandId, title: "Cross-tenant brief", opportunity_id: otherOpportunityId })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows a brief to exist without an opportunity (backward compatibility, PRD §5)", async () => {
      const { data, error } = await editor.client
        .from("content_briefs")
        .insert({ workspace_id: workspaceId, brand_id: brandId, title: "No opportunity" })
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.opportunity_id).toBeNull();
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping intelligence-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
