import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPromptVersion,
  generateImage,
  generateText,
  listAiJobsForWorkspace,
  resolveActivePromptVersion,
} from "@/server/services/ai";
import { createContentVersion } from "@/server/services/content";
import { AI_MOCK_FORCE_FAILURE_PROMPT, AiProviderError, MockAiProviderAdapter } from "@/lib/ai/provider";
import { OpenAiProviderAdapter } from "@/lib/ai/openai-adapter";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Service-level tests for the MVP-5.3 AI Foundation
 * (src/server/services/ai.ts), calling the real exported service functions
 * — authenticated via a real signed-in test user's bearer token
 * (setTestAccessToken) — against the local Supabase stack, exactly like
 * notifications-service.test.ts / content-service.test.ts.
 *
 * The real OpenAiProviderAdapter is never invoked against the network here
 * (DECISIONS #21-#28 / MVP-5.3 instructions: no test depends on a real
 * OpenAI call). generateText/generateImage accept a test-only
 * `deps.adapter` override (see ai.ts) so every test below injects
 * MockAiProviderAdapter instead of resolving the real registry entry.
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("AI Foundation service — prompts, job lifecycle, usage, traceability", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const mockAdapter = new MockAiProviderAdapter();

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;

  const createdPromptIds: string[] = [];
  const createdJobIds: string[] = [];
  const createdVersionIds: string[] = [];
  let contentId: string;

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "AI Service Tenant",
      p_slug: `ai-service-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const { data: brand } = await editor.client.from("brands").insert({ workspace_id: workspaceId, name: "Fixture Brand" }).select().single();
    const { data: content } = await editor.client
      .from("content")
      .insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "Fixture Content" })
      .select()
      .single();
    contentId = content!.id;
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (createdVersionIds.length > 0) await admin.from("content_versions").delete().in("id", createdVersionIds);
    if (createdJobIds.length > 0) await admin.from("ai_jobs").delete().in("id", createdJobIds);
    if (createdPromptIds.length > 0) await admin.from("prompt_versions").delete().in("id", createdPromptIds);
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId].filter(Boolean),
      userIds: [editor?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  async function trackAllPromptsForPurpose(purpose: string) {
    const { data } = await admin.from("prompt_versions").select("id").eq("workspace_id", workspaceId).eq("purpose", purpose);
    for (const row of data ?? []) createdPromptIds.push(row.id);
  }

  describe("prompt version lifecycle (DECISIONS #26)", () => {
    it("1. createPromptVersion creates version 1, active", async () => {
      const prompt = await createPromptVersion(workspaceId, {
        workspaceId,
        name: "Test Prompt",
        purpose: "test_purpose_lifecycle",
        template: "Say hello to {{name}}",
        configuration: { model: "gpt-4o-mini" },
      });
      await trackAllPromptsForPurpose("test_purpose_lifecycle");
      expect(prompt.version).toBe(1);
      expect(prompt.is_active).toBe(true);
    });

    it("2. a second createPromptVersion call creates version 2 and deactivates version 1 — immutable rows, new version = new row", async () => {
      const v2 = await createPromptVersion(workspaceId, {
        workspaceId,
        name: "Test Prompt v2",
        purpose: "test_purpose_lifecycle",
        template: "Say hi to {{name}}",
      });
      await trackAllPromptsForPurpose("test_purpose_lifecycle");
      expect(v2.version).toBe(2);
      expect(v2.is_active).toBe(true);

      const { data: rows } = await admin
        .from("prompt_versions")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("purpose", "test_purpose_lifecycle")
        .order("version", { ascending: true });
      expect(rows).toHaveLength(2);
      expect(rows![0].is_active).toBe(false);
      expect(rows![0].template).toBe("Say hello to {{name}}"); // unchanged — immutable
      expect(rows![1].is_active).toBe(true);
    });

    it("3. resolveActivePromptVersion returns the workspace-specific active version, not a global fallback", async () => {
      await createPromptVersion(workspaceId, {
        workspaceId: null,
        name: "Global fallback",
        purpose: "test_purpose_precedence",
        template: "Global: {{x}}",
      });
      await trackAllPromptsForPurpose("test_purpose_precedence");
      const { data: globalRows } = await admin.from("prompt_versions").select("id").is("workspace_id", null).eq("purpose", "test_purpose_precedence");
      for (const row of globalRows ?? []) createdPromptIds.push(row.id);

      const workspaceSpecific = await createPromptVersion(workspaceId, {
        workspaceId,
        name: "Workspace-specific",
        purpose: "test_purpose_precedence",
        template: "Workspace: {{x}}",
      });
      await trackAllPromptsForPurpose("test_purpose_precedence");

      const resolved = await resolveActivePromptVersion(workspaceId, "test_purpose_precedence");
      expect(resolved.id).toBe(workspaceSpecific.id);
      expect(resolved.template).toBe("Workspace: {{x}}");
    });

    it("4. resolveActivePromptVersion falls back to the global active prompt when no workspace-specific one exists", async () => {
      const global = await createPromptVersion(workspaceId, {
        workspaceId: null,
        name: "Global only",
        purpose: "test_purpose_global_only",
        template: "Global only: {{x}}",
      });
      createdPromptIds.push(global.id);

      const resolved = await resolveActivePromptVersion(workspaceId, "test_purpose_global_only");
      expect(resolved.id).toBe(global.id);
    });

    it("5. resolveActivePromptVersion fails explicitly when neither a workspace-specific nor a global active prompt exists", async () => {
      await expect(resolveActivePromptVersion(workspaceId, "test_purpose_never_created")).rejects.toThrow(/No active prompt found/);
    });
  });

  describe("generateText — sync fast-path job lifecycle (DECISIONS #21/#27)", () => {
    it("6. success: creates a completed ai_job, records usage, returns generated text", async () => {
      const result = await generateText(workspaceId, { rawPrompt: "Hello world", model: "gpt-4o-mini" }, { adapter: mockAdapter });
      createdJobIds.push(result.jobId);

      expect(result.text).toContain("Hello world");

      const { data: job } = await admin.from("ai_jobs").select("*").eq("id", result.jobId).single();
      expect(job?.status).toBe("completed");
      expect(job?.trigger_type).toBe("user");
      expect(job?.requested_by).toBe(editor.userId);
      expect(job?.started_at).not.toBeNull();
      expect(job?.completed_at).not.toBeNull();
      expect(job?.error_code).toBeNull();

      // input/output reference persistence (DECISIONS #25 hybrid semantics)
      expect(job?.input_reference).toMatchObject({ workspaceId, resolvedRequest: { prompt: "Hello world", model: "gpt-4o-mini" } });
      expect(job?.output_reference).toMatchObject({ text: result.text });

      const { data: usageRows } = await admin.from("ai_usage").select("*").eq("ai_job_id", result.jobId);
      expect(usageRows).toHaveLength(1);
      expect(usageRows![0].provider).toBe("openai");
      expect(usageRows![0].input_tokens).toBe(12);
      expect(usageRows![0].output_tokens).toBe(8);
    });

    it("7. failure: provider error marks the ai_job failed with error_code/error_message, and the call rejects", async () => {
      await expect(
        generateText(workspaceId, { rawPrompt: AI_MOCK_FORCE_FAILURE_PROMPT, model: "gpt-4o-mini" }, { adapter: mockAdapter }),
      ).rejects.toThrow();

      const jobs = await listAiJobsForWorkspace(workspaceId);
      const failedJob = jobs.find((j) => j.status === "failed" && j.error_code === "mock_forced_failure");
      expect(failedJob).toBeDefined();
      createdJobIds.push(failedJob!.id);
      expect(failedJob!.error_message).toContain("Mock AI provider forced failure");
      expect(failedJob!.completed_at).not.toBeNull();

      // A failed job still records no usage row (no successful provider response to attribute).
      const { data: usageRows } = await admin.from("ai_usage").select("id").eq("ai_job_id", failedJob!.id);
      expect(usageRows).toEqual([]);
    });

    it("8. uses the resolved prompt version's configured model when no explicit model is given", async () => {
      const prompt = await createPromptVersion(workspaceId, {
        workspaceId,
        name: "Configured model prompt",
        purpose: "test_purpose_model_default",
        template: "Fixed template, no variables",
        configuration: { model: "configured-model" },
      });
      createdPromptIds.push(prompt.id);

      const result = await generateText(workspaceId, { promptPurpose: "test_purpose_model_default" }, { adapter: mockAdapter });
      createdJobIds.push(result.jobId);

      const { data: job } = await admin.from("ai_jobs").select("model, prompt_version_id").eq("id", result.jobId).single();
      expect(job?.model).toBe("configured-model");
      expect(job?.prompt_version_id).toBe(prompt.id);
    });

    it("9. renders {{variable}} placeholders from the resolved prompt template", async () => {
      const prompt = await createPromptVersion(workspaceId, {
        workspaceId,
        name: "Variable prompt",
        purpose: "test_purpose_variables",
        template: "Hello {{name}}, welcome to {{place}}",
        configuration: { model: "gpt-4o-mini" },
      });
      createdPromptIds.push(prompt.id);

      const result = await generateText(
        workspaceId,
        { promptPurpose: "test_purpose_variables", promptVariables: { name: "Ada", place: "MOS" } },
        { adapter: mockAdapter },
      );
      createdJobIds.push(result.jobId);

      const { data: job } = await admin.from("ai_jobs").select("input_reference").eq("id", result.jobId).single();
      expect((job?.input_reference as { resolvedRequest: { prompt: string } }).resolvedRequest.prompt).toBe(
        "Hello Ada, welcome to MOS",
      );
    });

    it("10. throws when neither promptPurpose nor rawPrompt is provided", async () => {
      await expect(generateText(workspaceId, {}, { adapter: mockAdapter })).rejects.toThrow(/Either promptPurpose or rawPrompt/);
    });
  });

  describe("generateImage — sync fast-path (DECISIONS #21/#27)", () => {
    it("11. success: creates a completed ai_job and records image_count usage, without persisting raw image bytes in output_reference", async () => {
      const result = await generateImage(workspaceId, { rawPrompt: "A red circle", model: "dall-e-3" }, { adapter: mockAdapter });
      createdJobIds.push(result.jobId);

      expect(result.imageUrl).toBeTruthy();

      const { data: job } = await admin.from("ai_jobs").select("*").eq("id", result.jobId).single();
      expect(job?.status).toBe("completed");
      expect(job?.output_reference).toMatchObject({ imageCount: 1 });
      expect(JSON.stringify(job?.output_reference)).not.toContain("base64");

      const { data: usageRows } = await admin.from("ai_usage").select("*").eq("ai_job_id", result.jobId);
      expect(usageRows![0].image_count).toBe(1);
      expect(usageRows![0].input_tokens).toBeNull();
    });
  });

  describe("Content AI traceability (DECISIONS #28 — Content-only scope)", () => {
    it("12. createContentVersion sets ai_job_id when provided (AI-generated version)", async () => {
      const genResult = await generateText(workspaceId, { rawPrompt: "Traceable content", model: "gpt-4o-mini" }, { adapter: mockAdapter });
      createdJobIds.push(genResult.jobId);

      const version = await createContentVersion(workspaceId, contentId, {
        generationMethod: "ai",
        payloadText: genResult.text,
        aiJobId: genResult.jobId,
      });
      createdVersionIds.push(version.id);

      expect(version.ai_job_id).toBe(genResult.jobId);
    });

    it("13. human-authored content versions retain NULL ai_job_id (no aiJobId passed)", async () => {
      const version = await createContentVersion(workspaceId, contentId, {
        generationMethod: "human",
        payloadText: "Written by a person",
      });
      createdVersionIds.push(version.id);

      expect(version.ai_job_id).toBeNull();
    });

    it("14. the composite tenant-consistency FK rejects an ai_job_id from a different workspace", async () => {
      const outsiderWorkspace = await editor.client.rpc("create_workspace", {
        p_name: "Traceability Other",
        p_slug: `traceability-other-${Date.now()}`,
      });
      const otherWorkspaceId = outsiderWorkspace.data!.id;
      const otherJobId = await (async () => {
        const { data } = await admin
          .from("ai_jobs")
          .insert({ workspace_id: otherWorkspaceId, trigger_type: "system", job_type: "x", provider: "openai", model: "m", status: "completed" })
          .select()
          .single();
        return data!.id;
      })();

      await expect(
        createContentVersion(workspaceId, contentId, {
          generationMethod: "ai",
          payloadText: "Cross-tenant attempt",
          aiJobId: otherJobId,
        }),
      ).rejects.toThrow();

      // FK-safe order (see helpers.ts's cleanupTestData): audit_logs
      // (RESTRICT into workspaces) must be deleted before the workspace
      // itself, or the workspace delete silently no-ops and leaks both the
      // workspace and its owning user across test runs.
      await admin.from("ai_jobs").delete().eq("id", otherJobId);
      await admin.from("audit_logs").delete().eq("workspace_id", otherWorkspaceId);
      const { error: deleteWorkspaceError } = await admin.from("workspaces").delete().eq("id", otherWorkspaceId);
      if (deleteWorkspaceError) throw new Error(`Failed to clean up fixture workspace: ${deleteWorkspaceError.message}`);
    });
  });
});

/**
 * OpenAI adapter credential-handling tests — no real network call. Global
 * fetch is stubbed so this never depends on network access or a real API
 * key, per the MVP-5.3 instruction ("Do NOT make the test suite dependent
 * on a real OpenAI API call").
 */
describe("OpenAiProviderAdapter — credential handling (no network call)", () => {
  const DUMMY_KEY = "sk-test-dummy-key-should-never-leak";
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = DUMMY_KEY;
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalKey;
    vi.unstubAllGlobals();
  });

  it("15. throws a descriptive error, and never leaks the API key, when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const adapter = new OpenAiProviderAdapter();
    await expect(adapter.generateText({ prompt: "x", model: "gpt-4o-mini" })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("16. on a provider error response, the thrown error and providerResponse never contain the API key or Authorization header", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: { message: "Invalid request", code: "invalid_request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiProviderAdapter();
    let caught: AiProviderError | null = null;
    try {
      await adapter.generateText({ prompt: "x", model: "gpt-4o-mini" });
    } catch (err) {
      caught = err as AiProviderError;
    }

    expect(caught).toBeInstanceOf(AiProviderError);
    expect(caught!.code).toBe("invalid_request");
    const serialized = JSON.stringify({ message: caught!.message, providerResponse: caught!.providerResponse });
    expect(serialized).not.toContain(DUMMY_KEY);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("bearer");

    // Confirm the key WAS actually used in the outbound request (so this test is meaningful, not vacuous).
    const [, requestInit] = fetchMock.mock.calls[0];
    const headers = requestInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${DUMMY_KEY}`);
  });

  it("17. analyzeContent/analyzeSignal/generateVariants/generateInsight throw AiCapabilityNotSupportedError, not fake AI behavior", async () => {
    const adapter = new OpenAiProviderAdapter();
    await expect(adapter.analyzeContent({})).rejects.toThrow(/not supported in this phase/);
    await expect(adapter.analyzeSignal({})).rejects.toThrow(/not supported in this phase/);
    await expect(adapter.generateVariants({})).rejects.toThrow(/not supported in this phase/);
    await expect(adapter.generateInsight({})).rejects.toThrow(/not supported in this phase/);
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping ai-service.test.ts database-backed suite: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
