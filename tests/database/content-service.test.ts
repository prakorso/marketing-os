import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContentBrief, updateContentBrief } from "@/server/services/content";
import { createOpportunity, createTopic } from "@/server/services/intelligence";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Service-level tests for MVP-4.2's opportunity_id integration
 * (createContentBrief / updateContentBrief in src/server/services/
 * content.ts), following the established analytics-service.test.ts /
 * intelligence-service.test.ts convention of calling the REAL exported
 * service functions, authenticated via a real signed-in test user's
 * bearer token (setTestAccessToken), against the local Supabase stack.
 *
 * This is the first service-level test file for the Content domain — the
 * pre-existing content-tenant-isolation.test.ts covers RLS via raw client
 * calls, not the service functions themselves. MVP-4.2 needed to verify
 * actual createContentBrief/updateContentBrief behavior (set, omit, clear
 * opportunity_id; cross-workspace rejection reached through the service,
 * not just at the raw DB layer already proven in
 * intelligence-tenant-isolation.test.ts), which is exactly what this file
 * covers, following the newer service-test pattern already established
 * for Analytics/Notifications/Intelligence.
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("Content service — createContentBrief / updateContentBrief opportunity_id (MVP-4.2)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let brandId: string;
  let opportunityId: string;
  let otherOpportunityId: string;

  const createdBriefIds: string[] = [];

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Content Service Tenant",
      p_slug: `content-service-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Content Service Other Tenant",
      p_slug: `content-service-other-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const { data: brand, error: brandError } = await editor.client
      .from("brands")
      .insert({ workspace_id: workspaceId, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) throw new Error(`Failed to create brand fixture: ${brandError?.message}`);
    brandId = brand.id;

    const topic = await createTopic(workspaceId, { name: "Fixture Topic" });
    const opportunity = await createOpportunity(workspaceId, { topicId: topic.id, title: "Fixture Opportunity" });
    opportunityId = opportunity.id;

    // Cross-workspace opportunity fixture — created directly via the
    // outsider's own client (fixture setup only, not the system under
    // test), since createOpportunity would require swapping the test
    // session's bearer token mid-suite.
    const { data: otherTopic } = await outsider.client
      .from("topics")
      .insert({ workspace_id: otherWorkspaceId, name: "Other Topic" })
      .select()
      .single();
    const { data: otherOpportunity } = await outsider.client
      .from("opportunities")
      .insert({ workspace_id: otherWorkspaceId, topic_id: otherTopic!.id, title: "Other Opportunity" })
      .select()
      .single();
    otherOpportunityId = otherOpportunity!.id;
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (createdBriefIds.length > 0) {
      await admin.from("content_briefs").delete().in("id", createdBriefIds);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  it("1. createContentBrief can set opportunity_id", async () => {
    const brief = await createContentBrief(workspaceId, { brandId, title: "Brief with opportunity", opportunityId });
    createdBriefIds.push(brief.id);
    expect(brief.opportunity_id).toBe(opportunityId);
  });

  it("2. createContentBrief works without opportunity_id — existing behavior unaffected", async () => {
    const brief = await createContentBrief(workspaceId, { brandId, title: "Brief without opportunity" });
    createdBriefIds.push(brief.id);
    expect(brief.opportunity_id).toBeNull();
  });

  it("3. updateContentBrief can set opportunity_id on a brief created without one", async () => {
    const brief = await createContentBrief(workspaceId, { brandId, title: "To be linked" });
    createdBriefIds.push(brief.id);
    expect(brief.opportunity_id).toBeNull();

    const updated = await updateContentBrief(workspaceId, brief.id, { opportunityId });
    expect(updated.opportunity_id).toBe(opportunityId);
  });

  it("4. updateContentBrief can clear an existing opportunity_id", async () => {
    const brief = await createContentBrief(workspaceId, { brandId, title: "To be unlinked", opportunityId });
    createdBriefIds.push(brief.id);
    expect(brief.opportunity_id).toBe(opportunityId);

    const updated = await updateContentBrief(workspaceId, brief.id, { opportunityId: "" });
    expect(updated.opportunity_id).toBeNull();
  });

  it("5. rejects a cross-workspace opportunity via the existing composite tenant-consistency FK", async () => {
    await expect(
      createContentBrief(workspaceId, { brandId, title: "Cross-tenant attempt", opportunityId: otherOpportunityId }),
    ).rejects.toThrow();
  });

  it("6. existing Content Brief behavior remains intact — other fields unaffected by the opportunity_id addition", async () => {
    const brief = await createContentBrief(workspaceId, {
      brandId,
      title: "Regression check",
      objective: "Objective text",
      angle: "Angle text",
      coreMessage: "Core message text",
      cta: "CTA text",
      format: "Format text",
    });
    createdBriefIds.push(brief.id);
    expect(brief.title).toBe("Regression check");
    expect(brief.objective).toBe("Objective text");
    expect(brief.angle).toBe("Angle text");
    expect(brief.core_message).toBe("Core message text");
    expect(brief.cta).toBe("CTA text");
    expect(brief.format).toBe("Format text");
    expect(brief.opportunity_id).toBeNull();

    // A partial update that never mentions opportunityId must leave it untouched.
    const updated = await updateContentBrief(workspaceId, brief.id, { title: "Regression check, updated" });
    expect(updated.title).toBe("Regression check, updated");
    expect(updated.opportunity_id).toBeNull();
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping content-service.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
