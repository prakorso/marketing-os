import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";

/**
 * RLS / tenant isolation tests for the MVP-5.3 AI Foundation migration
 * (ai_jobs, ai_usage, prompt_versions), per DECISIONS #24 (approved): all
 * three tables grant workspace members SELECT only — there is no
 * `authenticated` INSERT/UPDATE/DELETE policy on any of them; every write
 * happens via service_role. prompt_versions additionally allows SELECT of
 * global (workspace_id IS NULL) rows regardless of which workspace the
 * caller belongs to (Engineering Blueprint §12 resolution precedence).
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning.
 */
describe.skipIf(!hasLocalSupabase)("AI Foundation RLS — tenant isolation (ai_jobs, ai_usage, prompt_versions)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let memberA: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;

  let jobInWorkspace: string;
  let jobInOtherWorkspace: string;
  let usageInWorkspace: string;
  let workspacePromptId: string;
  let otherWorkspacePromptId: string;
  let globalPromptId: string;

  const createdJobIds: string[] = [];
  const createdUsageIds: string[] = [];
  const createdPromptIds: string[] = [];

  async function seedJob(workspace: string): Promise<string> {
    const { data, error } = await admin
      .from("ai_jobs")
      .insert({
        workspace_id: workspace,
        trigger_type: "system",
        job_type: "test_fixture",
        provider: "openai",
        model: "test-model",
        status: "completed",
        input_reference: { fixture: true },
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to seed ai_jobs fixture: ${error?.message}`);
    createdJobIds.push(data.id);
    return data.id;
  }

  async function seedUsage(workspace: string, jobId: string): Promise<string> {
    const { data, error } = await admin
      .from("ai_usage")
      .insert({ workspace_id: workspace, ai_job_id: jobId, provider: "openai", model: "test-model" })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to seed ai_usage fixture: ${error?.message}`);
    createdUsageIds.push(data.id);
    return data.id;
  }

  async function seedPrompt(workspace: string | null, purpose: string): Promise<string> {
    const { data, error } = await admin
      .from("prompt_versions")
      .insert({ workspace_id: workspace, name: "Fixture", purpose, version: 1, template: "Hello {{name}}", is_active: true })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to seed prompt_versions fixture: ${error?.message}`);
    createdPromptIds.push(data.id);
    return data.id;
  }

  beforeAll(async () => {
    memberA = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await memberA.client.rpc("create_workspace", {
      p_name: "AI Foundation Tenant",
      p_slug: `ai-foundation-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "AI Foundation Other Tenant",
      p_slug: `ai-foundation-other-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    jobInWorkspace = await seedJob(workspaceId);
    jobInOtherWorkspace = await seedJob(otherWorkspaceId);
    usageInWorkspace = await seedUsage(workspaceId, jobInWorkspace);
    workspacePromptId = await seedPrompt(workspaceId, "ai_foundation_test_purpose");
    otherWorkspacePromptId = await seedPrompt(otherWorkspaceId, "ai_foundation_test_purpose");
    globalPromptId = await seedPrompt(null, "ai_foundation_test_purpose_global");
  });

  afterAll(async () => {
    if (createdUsageIds.length > 0) await admin.from("ai_usage").delete().in("id", createdUsageIds);
    if (createdJobIds.length > 0) await admin.from("ai_jobs").delete().in("id", createdJobIds);
    if (createdPromptIds.length > 0) await admin.from("prompt_versions").delete().in("id", createdPromptIds);
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [memberA?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("ai_jobs read access", () => {
    it("1. allows a workspace member to read a job in their own workspace", async () => {
      const { data, error } = await memberA.client.from("ai_jobs").select("*").eq("id", jobInWorkspace).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(jobInWorkspace);
    });

    it("2. denies reading a job in a workspace the user does not belong to", async () => {
      const { data, error } = await memberA.client.from("ai_jobs").select("*").eq("id", jobInOtherWorkspace).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("3. tenant scoping is enforced on a list query, not only a direct-id lookup", async () => {
      const { data, error } = await memberA.client.from("ai_jobs").select("id");
      expect(error).toBeNull();
      const ids = (data ?? []).map((row) => row.id);
      expect(ids).toContain(jobInWorkspace);
      expect(ids).not.toContain(jobInOtherWorkspace);
    });
  });

  describe("ai_usage read access", () => {
    it("4. allows a workspace member to read usage rows in their own workspace", async () => {
      const { data, error } = await memberA.client.from("ai_usage").select("*").eq("id", usageInWorkspace).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(usageInWorkspace);
    });

    it("5. denies a non-member from reading usage rows in another workspace", async () => {
      const { data, error } = await outsider.client.from("ai_usage").select("*").eq("id", usageInWorkspace).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });
  });

  describe("prompt_versions read access — including global fallback visibility", () => {
    it("6. allows a workspace member to read their own workspace-specific prompt", async () => {
      const { data, error } = await memberA.client.from("prompt_versions").select("*").eq("id", workspacePromptId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(workspacePromptId);
    });

    it("7. denies reading another workspace's workspace-specific prompt", async () => {
      const { data, error } = await memberA.client.from("prompt_versions").select("*").eq("id", otherWorkspacePromptId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("8. a global (workspace_id IS NULL) prompt is visible to a member of ANY workspace", async () => {
      const asMemberA = await memberA.client.from("prompt_versions").select("*").eq("id", globalPromptId).maybeSingle();
      expect(asMemberA.error).toBeNull();
      expect(asMemberA.data?.id).toBe(globalPromptId);

      const asOutsider = await outsider.client.from("prompt_versions").select("*").eq("id", globalPromptId).maybeSingle();
      expect(asOutsider.error).toBeNull();
      expect(asOutsider.data?.id).toBe(globalPromptId);
    });
  });

  describe("no authenticated write policy (DECISIONS #24)", () => {
    it("9. ai_jobs: a direct authenticated insert is rejected", async () => {
      const { data, error } = await memberA.client
        .from("ai_jobs")
        .insert({ workspace_id: workspaceId, trigger_type: "user", job_type: "x", provider: "openai", model: "m" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("10. ai_jobs: a direct authenticated update is rejected — no UPDATE grant exists at all (not merely RLS-filtered)", async () => {
      const { data, error } = await memberA.client.from("ai_jobs").update({ status: "cancelled" }).eq("id", jobInWorkspace).select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      const { data: unchanged } = await admin.from("ai_jobs").select("status").eq("id", jobInWorkspace).single();
      expect(unchanged?.status).toBe("completed");
    });

    it("11. ai_usage: a direct authenticated insert is rejected", async () => {
      const { data, error } = await memberA.client
        .from("ai_usage")
        .insert({ workspace_id: workspaceId, ai_job_id: jobInWorkspace, provider: "openai", model: "m" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("12. prompt_versions: a direct authenticated insert is rejected", async () => {
      const { data, error } = await memberA.client
        .from("prompt_versions")
        .insert({ workspace_id: workspaceId, name: "x", purpose: "x", version: 99, template: "x" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("13. prompt_versions: a direct authenticated update (is_active) is rejected — no UPDATE grant exists at all", async () => {
      const { data, error } = await memberA.client
        .from("prompt_versions")
        .update({ is_active: false })
        .eq("id", workspacePromptId)
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      const { data: unchanged } = await admin.from("prompt_versions").select("is_active").eq("id", workspacePromptId).single();
      expect(unchanged?.is_active).toBe(true);
    });

    it("14. service_role CAN update prompt_versions.is_active (the documented immutability exception)", async () => {
      const { data, error } = await admin.from("prompt_versions").update({ is_active: false }).eq("id", workspacePromptId).select().single();
      expect(error).toBeNull();
      expect(data?.is_active).toBe(false);
      // restore for any later test in this file
      await admin.from("prompt_versions").update({ is_active: true }).eq("id", workspacePromptId);
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping ai-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
