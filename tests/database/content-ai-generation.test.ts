import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPromptVersion } from "@/server/services/ai";
import {
  createContent,
  createContentBrief,
  generateContentVersionFromBrief,
  listContentApprovals,
  listContentVersions,
} from "@/server/services/content";
import { AI_MOCK_FORCE_FAILURE_PROMPT, MockAiProviderAdapter } from "@/lib/ai/provider";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * MVP-5.4 — Content AI Text Generation Consumer
 * (generateContentVersionFromBrief, src/server/services/content.ts).
 *
 * Calls the real service function end-to-end, injecting MockAiProviderAdapter
 * (no real OpenAI call ever made — see ai-service.test.ts for the adapter's
 * own credential-handling tests). Follows the same
 * setTestAccessToken/createSignedInTestUser convention as every other
 * service test in this suite.
 *
 * Test ordering is intentional: "missing prompt" must run before any
 * prompt_versions row exists for the fixed "content_generate_text" purpose,
 * and "global fallback" must run before a workspace-specific prompt is
 * created for the same purpose — both are one-way transitions within this
 * file (see inline comments at each step).
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("Content AI Text Generation — generateContentVersionFromBrief", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const mockAdapter = new MockAiProviderAdapter();

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let contentId: string;
  let briefId: string;
  let otherContentId: string;

  const createdPromptIds: string[] = [];
  const createdJobIds: string[] = [];
  const createdVersionIds: string[] = [];

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Content AI Gen Tenant",
      p_slug: `content-ai-gen-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Content AI Gen Other Tenant",
      p_slug: `content-ai-gen-other-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const { data: brand } = await editor.client.from("brands").insert({ workspace_id: workspaceId, name: "Fixture Brand" }).select().single();
    const brief = await createContentBrief(workspaceId, {
      brandId: brand!.id,
      title: "Launch announcement",
      objective: "Drive signups",
      angle: "Founder story",
      coreMessage: "We built this for you",
      cta: "Sign up today",
      format: "Single image post",
    });
    briefId = brief.id;

    const content = await createContent(workspaceId, { brandId: brand!.id, briefId, title: "Fixture Content" });
    contentId = content.id;

    // A second content item in the SAME workspace, deliberately with NO
    // brief attached — used to test the "no brief" precondition failure.
    const contentNoBrief = await createContent(workspaceId, { brandId: brand!.id, title: "Fixture Content Without Brief" });
    otherContentId = contentNoBrief.id;
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (createdVersionIds.length > 0) await admin.from("content_versions").delete().in("id", createdVersionIds);
    if (createdJobIds.length > 0) await admin.from("ai_jobs").delete().in("id", createdJobIds);
    if (createdPromptIds.length > 0) await admin.from("prompt_versions").delete().in("id", createdPromptIds);
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  it("1. fails explicitly when no prompt exists for content_generate_text (no fallback content, no fake ai_job)", async () => {
    const before = await listContentVersions(workspaceId, contentId);

    await expect(generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter })).rejects.toThrow(
      /No active prompt found/,
    );

    const after = await listContentVersions(workspaceId, contentId);
    expect(after.length).toBe(before.length); // no version fabricated on failure
  });

  it("2. fails explicitly when the content has no attached Content Brief", async () => {
    await createPromptVersion(workspaceId, {
      workspaceId: null,
      name: "Global content prompt (pre-req for this test only, harmless if a later test also needs it)",
      purpose: "content_generate_text",
      template: "Write a post. Title: {{title}}",
      configuration: { model: "gpt-4o-mini" },
    }).then((p) => createdPromptIds.push(p.id));

    await expect(generateContentVersionFromBrief(workspaceId, otherContentId, { adapter: mockAdapter })).rejects.toThrow(
      /no attached Content Brief/,
    );
  });

  it("3. global prompt fallback: succeeds using the global active prompt when no workspace-specific one exists", async () => {
    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    const { data: job } = await admin.from("ai_jobs").select("*").eq("id", version.ai_job_id!).single();
    const { data: globalPrompt } = await admin
      .from("prompt_versions")
      .select("id")
      .is("workspace_id", null)
      .eq("purpose", "content_generate_text")
      .eq("is_active", true)
      .single();
    expect(job?.prompt_version_id).toBe(globalPrompt?.id);
  });

  it("4. prompt resolution precedence: a workspace-specific active prompt is used over the global one", async () => {
    const workspacePrompt = await createPromptVersion(workspaceId, {
      workspaceId,
      name: "Workspace-specific content prompt",
      purpose: "content_generate_text",
      template: "Workspace prompt. Title: {{title}}, Objective: {{objective}}",
      configuration: { model: "gpt-4o-mini" },
    });
    createdPromptIds.push(workspacePrompt.id);

    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    const { data: job } = await admin.from("ai_jobs").select("prompt_version_id, input_reference").eq("id", version.ai_job_id!).single();
    expect(job?.prompt_version_id).toBe(workspacePrompt.id);
    expect((job?.input_reference as { resolvedRequest: { prompt: string } }).resolvedRequest.prompt).toBe(
      "Workspace prompt. Title: Launch announcement, Objective: Drive signups",
    );
  });

  it("5. Content Brief -> ai_job.input_reference linkage: contentBriefId is recorded on the job", async () => {
    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    const { data: job } = await admin.from("ai_jobs").select("input_reference").eq("id", version.ai_job_id!).single();
    expect((job?.input_reference as { contentBriefId: string }).contentBriefId).toBe(briefId);
  });

  it("6. successful generation creates a NEW, correctly-attributed Content Version with ai_job_id set", async () => {
    const before = await listContentVersions(workspaceId, contentId);
    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    expect(version.content_id).toBe(contentId);
    expect(version.ai_job_id).not.toBeNull();
    expect(version.generation_method).toBe("ai");
    expect((version.content_payload as { text: string }).text).toContain("mock generated text for");

    const after = await listContentVersions(workspaceId, contentId);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].version_number).toBeGreaterThan(before[0]?.version_number ?? 0); // newest first
  });

  it("7. content_versions.ai_job_id traceability: the version's ai_job_id matches a real, completed ai_jobs row", async () => {
    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    const { data: job } = await admin.from("ai_jobs").select("*").eq("id", version.ai_job_id!).single();
    expect(job).not.toBeNull();
    expect(job?.status).toBe("completed");
    expect(job?.workspace_id).toBe(workspaceId);
    expect(job?.output_reference).toMatchObject({ text: (version.content_payload as { text: string }).text });
  });

  it("8. human-created content versions retain NULL ai_job_id (existing createContentVersion path unaffected)", async () => {
    const { createContentVersion } = await import("@/server/services/content");
    const version = await createContentVersion(workspaceId, contentId, {
      generationMethod: "human",
      payloadText: "Written by a person, not AI",
    });
    createdVersionIds.push(version.id);
    expect(version.ai_job_id).toBeNull();
  });

  it("9. existing Content Version immutability is unaffected — no UPDATE path exists for AI-generated versions either", async () => {
    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    const { data, error } = await editor.client
      .from("content_versions")
      .update({ content_payload: { text: "tampered" } } as never)
      .eq("id", version.id)
      .select();
    expect(data).toBeNull();
    expect(error).not.toBeNull(); // no UPDATE policy/grant exists for content_versions at all (Database Architecture §20)

    const { data: unchanged } = await admin.from("content_versions").select("content_payload").eq("id", version.id).single();
    expect((unchanged?.content_payload as { text: string }).text).not.toBe("tampered");
  });

  it("10. approval gate remains intact: an AI-generated version has zero approvals until a human explicitly records one", async () => {
    const before = await listContentApprovals(workspaceId, contentId);
    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    const after = await listContentApprovals(workspaceId, contentId);
    expect(after.length).toBe(before.length); // AI generation never creates an approval as a side effect
  });

  it("11. no publication is automatically created, approved, or scheduled as a side effect of AI generation", async () => {
    const version = await generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter });
    createdVersionIds.push(version.id);
    createdJobIds.push(version.ai_job_id!);

    const { data: publications } = await admin.from("publications").select("id").eq("workspace_id", workspaceId);
    expect(publications ?? []).toEqual([]); // no content_variants/publications exist for this fixture workspace at all
  });

  it("12. failed provider call: marks the ai_job failed and surfaces an explicit error with no credential leakage", async () => {
    // Force a failure by giving the workspace prompt a template that
    // renders to the mock adapter's forced-failure sentinel.
    const failingPrompt = await createPromptVersion(workspaceId, {
      workspaceId,
      name: "Forced failure prompt",
      purpose: "content_generate_text",
      template: AI_MOCK_FORCE_FAILURE_PROMPT,
      configuration: { model: "gpt-4o-mini" },
    });
    createdPromptIds.push(failingPrompt.id);

    await expect(generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter })).rejects.toThrow();

    const { data: jobs } = await admin
      .from("ai_jobs")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("status", "failed")
      .eq("error_code", "mock_forced_failure")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(jobs).toHaveLength(1);
    createdJobIds.push(jobs![0].id);

    const serialized = JSON.stringify(jobs![0]);
    expect(serialized.toLowerCase()).not.toContain("bearer");
    expect(serialized.toLowerCase()).not.toContain("openai_api_key");
    expect(serialized).not.toContain(process.env.OPENAI_API_KEY ?? "__unset__");

    // No content_version was fabricated for the failed attempt.
    const versionsAfter = await listContentVersions(workspaceId, contentId);
    expect(versionsAfter.some((v) => v.ai_job_id === jobs![0].id)).toBe(false);

    // Restore a working prompt for any test after this one in the file.
    await admin.from("prompt_versions").update({ is_active: false }).eq("id", failingPrompt.id);
    const { data: reactivate } = await admin
      .from("prompt_versions")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("purpose", "content_generate_text")
      .neq("id", failingPrompt.id)
      .order("version", { ascending: false })
      .limit(1)
      .single();
    if (reactivate) {
      await admin.from("prompt_versions").update({ is_active: true }).eq("id", reactivate.id);
    }
  });

  it("13. workspace isolation: a member of another workspace cannot generate content for, or see versions of, this workspace's content", async () => {
    setTestAccessToken(null);
    const {
      data: { session: outsiderSession },
    } = await outsider.client.auth.getSession();
    setTestAccessToken(outsiderSession!.access_token);

    await expect(generateContentVersionFromBrief(workspaceId, contentId, { adapter: mockAdapter })).rejects.toThrow();

    const { data: visibleVersions } = await outsider.client.from("content_versions").select("id").eq("workspace_id", workspaceId);
    expect(visibleVersions).toEqual([]);

    // restore editor session for any subsequent test
    const {
      data: { session: editorSession },
    } = await editor.client.auth.getSession();
    setTestAccessToken(editorSession!.access_token);
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping content-ai-generation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
