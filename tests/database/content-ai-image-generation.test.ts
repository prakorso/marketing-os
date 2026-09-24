import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPromptVersion } from "@/server/services/ai";
import {
  createContent,
  createContentBrief,
  generateImageAssetFromBrief,
  listContentApprovals,
} from "@/server/services/content";
import { uploadAsset } from "@/server/services/assets";
import {
  AI_MOCK_FORCE_FAILURE_PROMPT,
  AiCapabilityNotSupportedError,
  AiProviderError,
  type AiProviderAdapter,
  type AiProviderImageInput,
  type AiProviderImageResult,
  type AiProviderTextInput,
  type AiProviderTextResult,
  MockAiProviderAdapter,
} from "@/lib/ai/provider";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * MVP-5.5 — Content AI Image Generation Consumer
 * (generateImageAssetFromBrief, src/server/services/content.ts).
 *
 * Mirrors content-ai-generation.test.ts's (MVP-5.4) conventions exactly.
 * No real OpenAI/network call is ever made: a small local test adapter
 * (below) stands in for the provider, returning a real (tiny) valid PNG as
 * base64 for the success path, and a fake URL — with `global.fetch`
 * selectively stubbed for just that one test, real fetch passed through
 * for everything else so Supabase's own internal HTTP calls are
 * unaffected — for the URL-retrieval path.
 */

// A real, valid 1x1 transparent PNG — used so byte-persistence assertions
// are meaningful (non-empty, decodable) without needing an image library.
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const NO_IMAGE_DATA_SENTINEL = "no-image-data-sentinel";
const FAKE_PROVIDER_IMAGE_URL = "https://example.invalid/mvp-5-5-generated-image.png";

class TestImageAdapter implements AiProviderAdapter {
  async generateText(input: AiProviderTextInput): Promise<AiProviderTextResult> {
    return new MockAiProviderAdapter().generateText(input);
  }

  async generateImage(input: AiProviderImageInput): Promise<AiProviderImageResult> {
    if (input.prompt === AI_MOCK_FORCE_FAILURE_PROMPT) {
      throw new AiProviderError("Mock AI provider forced failure", "mock_forced_failure", { mock: true });
    }
    if (input.prompt === NO_IMAGE_DATA_SENTINEL) {
      return { imageBase64: null, imageUrl: null, imageCount: 0, raw: { mock: true } };
    }
    if (input.prompt === FAKE_PROVIDER_IMAGE_URL) {
      return { imageBase64: null, imageUrl: FAKE_PROVIDER_IMAGE_URL, imageCount: 1, raw: { mock: true } };
    }
    return { imageBase64: TINY_PNG_BASE64, imageUrl: null, imageCount: 1, raw: { mock: true, model: input.model } };
  }

  async analyzeContent(_input: unknown): Promise<never> {
    throw new AiCapabilityNotSupportedError("analyze_content");
  }
  async analyzeSignal(_input: unknown): Promise<never> {
    throw new AiCapabilityNotSupportedError("analyze_signal");
  }
  async generateVariants(_input: unknown): Promise<never> {
    throw new AiCapabilityNotSupportedError("generate_variants");
  }
  async generateInsight(_input: unknown): Promise<never> {
    throw new AiCapabilityNotSupportedError("generate_insight");
  }
}

describe.skipIf(!hasLocalSupabase)("Content AI Image Generation — generateImageAssetFromBrief", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const adapter = new TestImageAdapter();

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let contentId: string;
  let brandId: string;

  const createdPromptIds: string[] = [];
  const createdJobIds: string[] = [];
  const createdAssetIds: string[] = [];

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Content AI Image Tenant",
      p_slug: `content-ai-image-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { error: viewerError } = await admin.from("workspace_members").insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (viewerError) throw new Error(`Failed to add viewer to workspace: ${viewerError.message}`);

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Content AI Image Other Tenant",
      p_slug: `content-ai-image-other-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    if (!session) throw new Error("Test editor has no session after sign-in");
    setTestAccessToken(session.access_token);

    const { data: brand } = await editor.client.from("brands").insert({ workspace_id: workspaceId, name: "Fixture Brand" }).select().single();
    brandId = brand!.id;

    const brief = await createContentBrief(workspaceId, {
      brandId,
      title: "Launch announcement",
      objective: "Drive signups",
      angle: "Founder story",
      coreMessage: "We built this for you",
      creativeDirection: "Minimalist product shot on a white background",
    });

    const content = await createContent(workspaceId, { brandId, briefId: brief.id, title: "Fixture Content" });
    contentId = content.id;
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (createdAssetIds.length > 0) {
      // Fetch storage paths before deleting rows so orphaned storage
      // objects (if any) are removed too, mirroring how other cleanups in
      // this suite remove both the object and the row.
      const { data: assetRows } = await admin.from("marqos_assets").select("id, storage_path").in("id", createdAssetIds);
      if (assetRows && assetRows.length > 0) {
        await admin.storage.from("assets").remove(assetRows.map((a) => a.storage_path));
      }
      await admin.from("marqos_content_assets").delete().in("asset_id", createdAssetIds);
      await admin.from("marqos_assets").delete().in("id", createdAssetIds);
    }
    if (createdJobIds.length > 0) await admin.from("ai_jobs").delete().in("id", createdJobIds);
    if (createdPromptIds.length > 0) await admin.from("prompt_versions").delete().in("id", createdPromptIds);
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  it("I. fails explicitly when no prompt exists for content_generate_image (no fallback image, no ai_job)", async () => {
    await expect(generateImageAssetFromBrief(workspaceId, contentId, { adapter })).rejects.toThrow(/No active prompt found/);

    const { data: jobs } = await admin.from("ai_jobs").select("id").eq("workspace_id", workspaceId).eq("job_type", "content_generate_image");
    expect(jobs).toEqual([]);
  });

  it("A/B/C/D. successful generation creates an ai_job, an Asset with ai_job_id set, and a content_assets link", async () => {
    const globalPrompt = await createPromptVersion(workspaceId, {
      workspaceId: null,
      name: "QA Global Image Prompt",
      purpose: "content_generate_image",
      template: "Image of: {{title}}. {{creative_direction}}",
      configuration: { model: "gpt-image-1" },
    });
    createdPromptIds.push(globalPrompt.id);

    const { jobId, asset } = await generateImageAssetFromBrief(workspaceId, contentId, { adapter });
    createdJobIds.push(jobId);
    createdAssetIds.push(asset.id);

    // A: ai_job exists and completed
    const { data: job } = await admin.from("ai_jobs").select("*").eq("id", jobId).single();
    expect(job?.status).toBe("completed");
    expect(job?.job_type).toBe("content_generate_image");
    expect(job?.workspace_id).toBe(workspaceId);
    expect(job?.prompt_version_id).toBe(globalPrompt.id);
    // D9 hybrid semantics: entity reference + frozen resolved request
    expect(job?.input_reference).toMatchObject({
      workspaceId,
      resolvedRequest: { prompt: "Image of: Launch announcement. Minimalist product shot on a white background" },
    });
    // Output reference carries the hook's merged asset reference, never raw bytes
    expect(job?.output_reference).toMatchObject({ assetId: asset.id });
    expect(JSON.stringify(job?.output_reference)).not.toContain(TINY_PNG_BASE64);

    // B/C: Asset created with ai_job_id populated, correct workspace, correct asset_type
    expect(asset.workspace_id).toBe(workspaceId);
    expect(asset.ai_job_id).toBe(jobId);
    expect(asset.asset_type).toBe("image");
    expect(asset.brand_id).toBe(brandId);

    const { data: storedObject } = await admin.storage.from("assets").download(asset.storage_path);
    expect(storedObject).not.toBeNull();
    expect((await storedObject!.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // D: linked through content_assets, correct workspace
    const { data: link } = await admin.from("marqos_content_assets").select("*").eq("content_id", contentId).eq("asset_id", asset.id).single();
    expect(link?.workspace_id).toBe(workspaceId);
    expect(link?.role).toBe("ai_generated");
  });

  it("retrieves and persists a provider-hosted image URL server-side (never exposing it as the Asset's own URL)", async () => {
    // Dedicated workspace-specific prompt whose rendered text (no
    // variables) exactly matches the adapter's URL-branch sentinel — takes
    // precedence over the global prompt used by other tests in this file.
    const urlPrompt = await createPromptVersion(workspaceId, {
      workspaceId,
      name: "URL image prompt",
      purpose: "content_generate_image",
      template: FAKE_PROVIDER_IMAGE_URL,
      configuration: { model: "gpt-image-1" },
    });
    createdPromptIds.push(urlPrompt.id);

    const realFetch = global.fetch.bind(global);
    const spy = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url === FAKE_PROVIDER_IMAGE_URL) {
        const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
        return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
      }
      return realFetch(input as never, init);
    });

    try {
      const { jobId, asset } = await generateImageAssetFromBrief(workspaceId, contentId, { adapter });
      createdJobIds.push(jobId);
      createdAssetIds.push(asset.id);

      expect(asset.ai_job_id).toBe(jobId);
      // The final Asset's storage_path is this app's own private bucket
      // path, never the provider's URL.
      expect(asset.storage_path).not.toContain("example.invalid");
      expect(asset.storage_path.startsWith(`${workspaceId}/`)).toBe(true);

      const { data: job } = await admin.from("ai_jobs").select("output_reference").eq("id", jobId).single();
      expect((job?.output_reference as { imageUrl?: string }).imageUrl).toBe(FAKE_PROVIDER_IMAGE_URL);
    } finally {
      spy.mockRestore();
      await admin.from("prompt_versions").update({ is_active: false }).eq("id", urlPrompt.id);
    }
  });

  it("E. a human-uploaded Asset (via the unchanged uploadAsset path) retains ai_job_id = NULL", async () => {
    const bytes = Buffer.from(TINY_PNG_BASE64, "base64");
    const file = new File([bytes], "human-upload.png", { type: "image/png" });
    const asset = await uploadAsset(workspaceId, file, brandId);
    createdAssetIds.push(asset.id);

    expect(asset.ai_job_id).toBeNull();
  });

  it("F. provider failure creates a failed ai_job and does not create a successful Asset or content link", async () => {
    const failingPrompt = await createPromptVersion(workspaceId, {
      workspaceId,
      name: "Forced failure image prompt",
      purpose: "content_generate_image",
      template: AI_MOCK_FORCE_FAILURE_PROMPT,
      configuration: { model: "gpt-image-1" },
    });
    createdPromptIds.push(failingPrompt.id);

    const assetsBefore = await admin.from("marqos_assets").select("id").eq("workspace_id", workspaceId);

    await expect(generateImageAssetFromBrief(workspaceId, contentId, { adapter })).rejects.toThrow();

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

    const assetsAfter = await admin.from("marqos_assets").select("id").eq("workspace_id", workspaceId);
    expect(assetsAfter.data?.length ?? 0).toBe(assetsBefore.data?.length ?? 0);

    // deactivate the forced-failure prompt so it doesn't interfere with later tests
    await admin.from("prompt_versions").update({ is_active: false }).eq("id", failingPrompt.id);
  });

  it("E (persistence failure). a provider success with no usable image data fails the job and creates no Asset", async () => {
    const noImagePrompt = await createPromptVersion(workspaceId, {
      workspaceId,
      name: "No image data prompt",
      purpose: "content_generate_image",
      template: NO_IMAGE_DATA_SENTINEL,
      configuration: { model: "gpt-image-1" },
    });
    createdPromptIds.push(noImagePrompt.id);

    const assetsBefore = await admin.from("marqos_assets").select("id").eq("workspace_id", workspaceId);

    await expect(generateImageAssetFromBrief(workspaceId, contentId, { adapter })).rejects.toThrow(/did not return usable image data/);

    const { data: jobs } = await admin
      .from("ai_jobs")
      .select("id, status")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(1);
    // Critically: even though the PROVIDER call itself succeeded, the job
    // must be 'failed', not 'completed', because persistence never happened.
    expect(jobs![0].status).toBe("failed");
    createdJobIds.push(jobs![0].id);

    const assetsAfter = await admin.from("marqos_assets").select("id").eq("workspace_id", workspaceId);
    expect(assetsAfter.data?.length ?? 0).toBe(assetsBefore.data?.length ?? 0);

    await admin.from("prompt_versions").update({ is_active: false }).eq("id", noImagePrompt.id);
    const { data: reactivate } = await admin
      .from("prompt_versions")
      .select("id")
      .eq("purpose", "content_generate_image")
      .is("workspace_id", null)
      .order("version", { ascending: false })
      .limit(1)
      .single();
    if (reactivate) await admin.from("prompt_versions").update({ is_active: true }).eq("id", reactivate.id);
  });

  it("H. an unauthorized (viewer-role) user cannot invoke image generation", async () => {
    setTestAccessToken(null);
    const {
      data: { session: viewerSession },
    } = await viewer.client.auth.getSession();
    setTestAccessToken(viewerSession!.access_token);

    await expect(generateImageAssetFromBrief(workspaceId, contentId, { adapter })).rejects.toThrow(/permission/);

    const {
      data: { session: editorSession },
    } = await editor.client.auth.getSession();
    setTestAccessToken(editorSession!.access_token);
  });

  it("G. workspace tenant isolation: a member of another workspace cannot generate against, or see, this workspace's content/assets", async () => {
    setTestAccessToken(null);
    const {
      data: { session: outsiderSession },
    } = await outsider.client.auth.getSession();
    setTestAccessToken(outsiderSession!.access_token);

    await expect(generateImageAssetFromBrief(workspaceId, contentId, { adapter })).rejects.toThrow();

    const { data: visibleAssets } = await outsider.client.from("marqos_assets").select("id").eq("workspace_id", workspaceId);
    expect(visibleAssets).toEqual([]);

    const {
      data: { session: editorSession },
    } = await editor.client.auth.getSession();
    setTestAccessToken(editorSession!.access_token);
  });

  it("J. generation never creates a content approval or publication (approval/publication gate unchanged)", async () => {
    const approvalsBefore = await listContentApprovals(workspaceId, contentId);
    const { data: publicationsBefore } = await admin.from("publications").select("id").eq("workspace_id", workspaceId);

    const { jobId, asset } = await generateImageAssetFromBrief(workspaceId, contentId, { adapter });
    createdJobIds.push(jobId);
    createdAssetIds.push(asset.id);

    const approvalsAfter = await listContentApprovals(workspaceId, contentId);
    const { data: publicationsAfter } = await admin.from("publications").select("id").eq("workspace_id", workspaceId);

    expect(approvalsAfter.length).toBe(approvalsBefore.length);
    expect(publicationsAfter?.length ?? 0).toBe(publicationsBefore?.length ?? 0);
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping content-ai-image-generation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
