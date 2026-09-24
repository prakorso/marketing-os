import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { resolveAiProviderAdapter } from "@/lib/ai/registry";
import { AiCapabilityNotSupportedError, AiProviderError, type AiProviderAdapter, type AiProviderImageResult } from "@/lib/ai/provider";
import { getCurrentUserRole } from "@/server/services/workspaces";
import type { AiJob, AiJobStatus, PromptVersion } from "@/types/database";

/**
 * MVP-5.3 AI Foundation — generic, reusable AI job/prompt lifecycle plus
 * the two currently-active consumer entry points (generateText,
 * generateImage), per the approved DECISIONS #21-#28.
 *
 * Scope boundary (DECISIONS #21, approved): Content-first only. This
 * module does not orchestrate creating a content_versions/assets row from
 * a generation result — that wiring is explicitly deferred to the next
 * phase ("the next phase will handle the Content consumer/UI"). Callers
 * that want traceable Content artifacts pass the returned `jobId` into
 * createContentVersion()/uploadAsset() themselves (see
 * src/server/services/content.ts, src/server/services/assets.ts).
 *
 * Execution model (DECISIONS #27, approved D11): both generateText and
 * generateImage in this phase run as the synchronous fast-path — the
 * ai_jobs row still exists and is driven through its full lifecycle
 * (queued -> running -> completed/failed), but that transition completes
 * within the calling request rather than being processed by a background
 * worker. This codebase does have real scheduled-execution infrastructure
 * (Netlify Scheduled Functions — see netlify/functions/,
 * src/server/services/publication-scheduler.ts), so async processing is
 * NOT canonically unavailable; it is deliberately not wired up here
 * because nothing in this foundation-only phase creates a queued backlog
 * for a worker to process (no UI triggers generation yet). If a future
 * phase's Content Studio wiring genuinely needs multi-minute async image
 * generation, the same Netlify Scheduled Function pattern already
 * established for publications can be applied to ai_jobs without
 * inventing a new mechanism.
 *
 * Authorization: generateText/generateImage/createPromptVersion require
 * editor role (assertEditor, matching every other domain's write pattern).
 * All actual table writes use the service-role client — no authenticated
 * INSERT/UPDATE policy exists on ai_jobs/ai_usage/prompt_versions
 * (DECISIONS #24) — mirroring the notifications.ts precedent.
 */

async function assertEditor(workspaceId: string) {
  const role = await getCurrentUserRole(workspaceId);
  if (role !== "owner" && role !== "admin" && role !== "marketer") {
    throw new Error("You do not have permission to trigger AI generation in this workspace");
  }
}

async function getCurrentUserId(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Authentication required");
  }
  return user.id;
}

// =============================================================================
// Prompt versions — immutable rows; only `is_active` is ever updated
// (DECISIONS #26, approved D10)
// =============================================================================

export async function listPromptVersionsForWorkspace(workspaceId: string, purpose?: string): Promise<PromptVersion[]> {
  const supabase = await createClient();
  let query = supabase.from("prompt_versions").select("*").eq("workspace_id", workspaceId);
  if (purpose) query = query.eq("purpose", purpose);
  const { data, error } = await query.order("version", { ascending: false });
  if (error) throw new Error(`Failed to list prompt versions: ${error.message}`);
  return data ?? [];
}

/**
 * Resolves the active prompt for a purpose using the canonical precedence
 * (Engineering Blueprint §12, DECISIONS #26): workspace-specific active
 * prompt first, else the global (workspace_id IS NULL) active prompt, else
 * explicit failure — no silent default.
 */
export async function resolveActivePromptVersion(workspaceId: string, purpose: string): Promise<PromptVersion> {
  const supabase = await createClient();

  const { data: workspaceSpecific, error: workspaceError } = await supabase
    .from("prompt_versions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("purpose", purpose)
    .eq("is_active", true)
    .maybeSingle();
  if (workspaceError) throw new Error(`Failed to resolve prompt: ${workspaceError.message}`);
  if (workspaceSpecific) return workspaceSpecific;

  const { data: global, error: globalError } = await supabase
    .from("prompt_versions")
    .select("*")
    .is("workspace_id", null)
    .eq("purpose", purpose)
    .eq("is_active", true)
    .maybeSingle();
  if (globalError) throw new Error(`Failed to resolve prompt: ${globalError.message}`);
  if (global) return global;

  throw new Error(`No active prompt found for purpose "${purpose}" (checked workspace-specific and global)`);
}

export type CreatePromptVersionInput = {
  /** Omit (or pass the caller's own workspaceId) for a workspace-specific prompt; pass null explicitly for a global prompt. */
  workspaceId: string | null;
  name: string;
  purpose: string;
  template: string;
  configuration?: Record<string, unknown>;
  /** Defaults to true — a newly-created prompt version normally supersedes the previous active one for its scope. */
  isActive?: boolean;
};

/**
 * Creates a new, immutable prompt version. If `isActive` (default true),
 * any existing active row for the same (workspaceId, purpose) scope is
 * deactivated first, then the new row is inserted active — in that order,
 * so the partial unique index (at most one active per scope+purpose,
 * 20260917090000_ai.sql) is never violated. This is the only place
 * `is_active` is ever updated on an existing row; `template`/`configuration`
 * /`version`/`purpose`/`name` are never updated after creation.
 */
export async function createPromptVersion(callerWorkspaceId: string, input: CreatePromptVersionInput): Promise<PromptVersion> {
  await assertEditor(callerWorkspaceId);
  const requestedBy = await getCurrentUserId();

  const scopeWorkspaceId = input.workspaceId;
  const isActive = input.isActive ?? true;

  const service = createServiceRoleClient();

  let versionQuery = service.from("prompt_versions").select("version").eq("purpose", input.purpose);
  versionQuery = scopeWorkspaceId ? versionQuery.eq("workspace_id", scopeWorkspaceId) : versionQuery.is("workspace_id", null);
  const { data: existingVersions, error: versionError } = await versionQuery.order("version", { ascending: false }).limit(1);
  if (versionError) throw new Error(`Failed to determine next prompt version: ${versionError.message}`);
  const nextVersion = existingVersions && existingVersions.length > 0 ? existingVersions[0].version + 1 : 1;

  if (isActive) {
    let deactivateQuery = service.from("prompt_versions").update({ is_active: false }).eq("purpose", input.purpose).eq("is_active", true);
    deactivateQuery = scopeWorkspaceId
      ? deactivateQuery.eq("workspace_id", scopeWorkspaceId)
      : deactivateQuery.is("workspace_id", null);
    const { error: deactivateError } = await deactivateQuery;
    if (deactivateError) throw new Error(`Failed to deactivate previous prompt version: ${deactivateError.message}`);
  }

  const { data, error } = await service
    .from("prompt_versions")
    .insert({
      workspace_id: scopeWorkspaceId,
      name: input.name,
      purpose: input.purpose,
      version: nextVersion,
      template: input.template,
      configuration: input.configuration ?? {},
      is_active: isActive,
      created_by: requestedBy,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create prompt version: ${error.message}`);
  return data;
}

/** Minimum template contract (DECISIONS #26: "do not invent complex template-language functionality") — plain {{key}} substitution, no conditionals/loops/escaping rules. */
function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in variables ? variables[key] : match));
}

// =============================================================================
// ai_jobs lifecycle — generic, reusable across future consumers
// =============================================================================

type CreateAiJobInput = {
  workspaceId: string;
  requestedBy: string | null;
  triggerType: "user" | "system";
  jobType: string;
  provider: string;
  model: string;
  promptVersionId: string | null;
  inputReference: Record<string, unknown>;
};

async function createAiJob(input: CreateAiJobInput): Promise<AiJob> {
  const service = createServiceRoleClient();
  const { data, error } = await service
    .from("ai_jobs")
    .insert({
      workspace_id: input.workspaceId,
      requested_by: input.requestedBy,
      trigger_type: input.triggerType,
      job_type: input.jobType,
      provider: input.provider,
      model: input.model,
      status: "queued",
      input_reference: input.inputReference,
      prompt_version_id: input.promptVersionId,
    })
    .select()
    .single();
  if (error) throw new Error(`Failed to create AI job: ${error.message}`);
  return data;
}

async function markAiJobRunning(jobId: string): Promise<void> {
  const service = createServiceRoleClient();
  const { error } = await service
    .from("ai_jobs")
    .update({ status: "running" as AiJobStatus, started_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to mark AI job running: ${error.message}`);
}

async function markAiJobCompleted(jobId: string, outputReference: Record<string, unknown>): Promise<void> {
  const service = createServiceRoleClient();
  const { error } = await service
    .from("ai_jobs")
    .update({
      status: "completed" as AiJobStatus,
      output_reference: outputReference,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to mark AI job completed: ${error.message}`);
}

async function markAiJobFailed(jobId: string, errorCode: string, errorMessage: string): Promise<void> {
  const service = createServiceRoleClient();
  const { error } = await service
    .from("ai_jobs")
    .update({
      status: "failed" as AiJobStatus,
      error_code: errorCode,
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) throw new Error(`Failed to mark AI job failed: ${error.message}`);
}

type RecordAiUsageInput = {
  workspaceId: string;
  aiJobId: string;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  imageCount: number | null;
  /** No pricing/billing logic exists in this phase (approved scope) — left NULL unless a caller can honestly supply one. */
  estimatedCost: number | null;
  currency: string | null;
};

async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  const service = createServiceRoleClient();
  const { error } = await service.from("ai_usage").insert({
    workspace_id: input.workspaceId,
    ai_job_id: input.aiJobId,
    provider: input.provider,
    model: input.model,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    image_count: input.imageCount,
    estimated_cost: input.estimatedCost,
    currency: input.currency,
  });
  if (error) throw new Error(`Failed to record AI usage: ${error.message}`);
}

/**
 * AI audit integration (Database Architecture §13: audit_logs.metadata
 * carries ai_job_id "when relevant"). Uses the RLS-scoped client (not
 * service-role) so log_audit_event's SECURITY DEFINER auth.uid() pin
 * reflects the real triggering user — the only path this codebase has for
 * client-attributable audit entries (no TS audit helper exists; this
 * mirrors the only existing call convention, the raw .rpc() call).
 */
async function auditAiJobOutcome(workspaceId: string, action: string, jobId: string, metadata: Record<string, unknown>) {
  const supabase = await createClient();
  await supabase.rpc("log_audit_event", {
    p_workspace_id: workspaceId,
    p_action: action,
    p_entity_type: "ai_jobs",
    p_entity_id: jobId,
    p_metadata: metadata,
  });
  // Best-effort: a failure to audit must not fail the AI generation itself
  // (mirrors this codebase's general error-isolation discipline elsewhere,
  // e.g. notifyFailureSideEffect in publications.ts). No error is thrown.
}

export async function listAiJobsForWorkspace(workspaceId: string): Promise<AiJob[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list AI jobs: ${error.message}`);
  return data ?? [];
}

// =============================================================================
// Active consumers: generateText / generateImage (DECISIONS #21, approved)
// =============================================================================

function normalizeError(err: unknown): { code: string; message: string } {
  if (err instanceof AiProviderError) return { code: err.code, message: err.message };
  if (err instanceof AiCapabilityNotSupportedError) return { code: "not_supported", message: err.message };
  if (err instanceof Error) return { code: "unknown_error", message: err.message };
  return { code: "unknown_error", message: "AI generation failed" };
}

/**
 * Resolves the prompt (if `promptPurpose` given) and/or the model, per the
 * caller's input. Exactly one of `promptPurpose` or `rawPrompt` must be
 * provided. No default model name is invented anywhere in this module —
 * DECISIONS #23 names OpenAI as the provider but no canonical document
 * names a specific model, so one must come from either the caller or the
 * resolved prompt's `configuration.model`.
 */
async function resolvePromptAndModel(
  workspaceId: string,
  input: { promptPurpose?: string; promptVariables?: Record<string, string>; rawPrompt?: string; model?: string },
): Promise<{ prompt: string; model: string; promptVersion: PromptVersion | null }> {
  if (!input.promptPurpose && !input.rawPrompt) {
    throw new Error("Either promptPurpose or rawPrompt must be provided");
  }
  if (input.promptPurpose && input.rawPrompt) {
    throw new Error("Provide only one of promptPurpose or rawPrompt, not both");
  }

  if (input.promptPurpose) {
    const promptVersion = await resolveActivePromptVersion(workspaceId, input.promptPurpose);
    const prompt = renderTemplate(promptVersion.template, input.promptVariables ?? {});
    const configuredModel = promptVersion.configuration.model;
    const model = input.model ?? (typeof configuredModel === "string" ? configuredModel : undefined);
    if (!model) {
      throw new Error(
        `No model specified for purpose "${input.promptPurpose}" — provide input.model or set configuration.model on the active prompt version`,
      );
    }
    return { prompt, model, promptVersion };
  }

  if (!input.model) {
    throw new Error("model is required when using rawPrompt (no prompt configuration to fall back to)");
  }
  return { prompt: input.rawPrompt!, model: input.model, promptVersion: null };
}

export type GenerateTextInput = {
  promptPurpose?: string;
  promptVariables?: Record<string, string>;
  rawPrompt?: string;
  model?: string;
  /** Typed entity reference recorded in input_reference (DECISIONS #25 hybrid semantics) — not a functional dependency of this call. */
  contentBriefId?: string;
};

export type GenerateResult = {
  jobId: string;
  text: string;
};

/**
 * `deps.adapter` is a test-only injection seam (dependency injection, not a
 * public capability) — production callers never pass it, so
 * resolveAiProviderAdapter(job.provider) (the real OpenAI adapter) is
 * always used outside tests. Tests inject MockAiProviderAdapter here
 * instead of a special "mock" entry in the production registry, so the
 * registry itself only ever names real providers (DECISIONS #23: OpenAI).
 */
export async function generateText(
  workspaceId: string,
  input: GenerateTextInput,
  deps?: { adapter?: AiProviderAdapter },
): Promise<GenerateResult> {
  await assertEditor(workspaceId);
  const requestedBy = await getCurrentUserId();

  const { prompt, model, promptVersion } = await resolvePromptAndModel(workspaceId, input);

  const job = await createAiJob({
    workspaceId,
    requestedBy,
    triggerType: "user",
    jobType: "content_generate_text",
    provider: "openai",
    model,
    promptVersionId: promptVersion?.id ?? null,
    inputReference: {
      workspaceId,
      contentBriefId: input.contentBriefId ?? null,
      promptVersionId: promptVersion?.id ?? null,
      promptPurpose: input.promptPurpose ?? null,
      resolvedRequest: { prompt, model },
    },
  });

  await markAiJobRunning(job.id);

  try {
    const adapter = deps?.adapter ?? resolveAiProviderAdapter(job.provider);
    const result = await adapter.generateText({ prompt, model });

    await markAiJobCompleted(job.id, { text: result.text });
    await recordAiUsage({
      workspaceId,
      aiJobId: job.id,
      provider: job.provider,
      model: job.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      imageCount: null,
      estimatedCost: null,
      currency: null,
    });
    await auditAiJobOutcome(workspaceId, "ai_job.completed", job.id, { job_type: job.job_type, provider: job.provider });

    return { jobId: job.id, text: result.text };
  } catch (err) {
    const { code, message } = normalizeError(err);
    await markAiJobFailed(job.id, code, message);
    await auditAiJobOutcome(workspaceId, "ai_job.failed", job.id, { job_type: job.job_type, provider: job.provider, error_code: code });
    throw new Error(`AI text generation failed: ${message}`);
  }
}

export type GenerateImageInput = {
  promptPurpose?: string;
  promptVariables?: Record<string, string>;
  rawPrompt?: string;
  model?: string;
  contentBriefId?: string;
};

export type GenerateImageResult = {
  jobId: string;
  imageBase64: string | null;
  imageUrl: string | null;
};

/**
 * Sync fast-path in this phase — see module header for why no async
 * worker is wired up here.
 *
 * MVP-5.5: `deps.onSuccess`, if provided, runs after a successful provider
 * response but BEFORE the job is marked completed. This is how a consumer
 * (e.g. src/server/services/content.ts's image-to-Asset persistence) can
 * make "the job is only completed once persistence into Asset Storage also
 * succeeds" true, without this generic AI Service needing to know anything
 * about Storage, Assets, or content_assets — it only needs to know that an
 * optional post-processing step exists and that its failure means the
 * whole operation failed. If the hook throws, the SAME catch block below
 * that handles a provider failure handles it too: the job is marked
 * failed, using the hook's own error message. This does not change
 * ai_jobs' schema, statuses, or contract — only this function's internal
 * control flow gains one optional extension point, narrowly scoped to the
 * one real need MVP-5.5 has (do not report a job completed before its
 * artifact is durably persisted).
 *
 * output_reference intentionally never includes the raw image bytes
 * (Database Architecture principle 6; Engineering Blueprint §15: binary
 * content is not stored directly in PostgreSQL, including as base64 inside
 * JSONB) — only lean metadata, plus whatever the hook itself chooses to
 * merge in (e.g. an asset id), is persisted.
 */
export async function generateImage(
  workspaceId: string,
  input: GenerateImageInput,
  deps?: {
    adapter?: AiProviderAdapter;
    onSuccess?: (result: AiProviderImageResult, jobId: string) => Promise<Record<string, unknown>>;
  },
): Promise<GenerateImageResult> {
  await assertEditor(workspaceId);
  const requestedBy = await getCurrentUserId();

  const { prompt, model, promptVersion } = await resolvePromptAndModel(workspaceId, input);

  const job = await createAiJob({
    workspaceId,
    requestedBy,
    triggerType: "user",
    jobType: "content_generate_image",
    provider: "openai",
    model,
    promptVersionId: promptVersion?.id ?? null,
    inputReference: {
      workspaceId,
      contentBriefId: input.contentBriefId ?? null,
      promptVersionId: promptVersion?.id ?? null,
      promptPurpose: input.promptPurpose ?? null,
      resolvedRequest: { prompt, model },
    },
  });

  await markAiJobRunning(job.id);

  try {
    const adapter = deps?.adapter ?? resolveAiProviderAdapter(job.provider);
    const result = await adapter.generateImage({ prompt, model });

    const extraOutputReference = deps?.onSuccess ? await deps.onSuccess(result, job.id) : {};

    await markAiJobCompleted(job.id, {
      imageCount: result.imageCount,
      hasImageBase64: result.imageBase64 !== null,
      imageUrl: result.imageUrl,
      ...extraOutputReference,
    });
    await recordAiUsage({
      workspaceId,
      aiJobId: job.id,
      provider: job.provider,
      model: job.model,
      inputTokens: null,
      outputTokens: null,
      imageCount: result.imageCount,
      estimatedCost: null,
      currency: null,
    });
    await auditAiJobOutcome(workspaceId, "ai_job.completed", job.id, { job_type: job.job_type, provider: job.provider });

    return { jobId: job.id, imageBase64: result.imageBase64, imageUrl: result.imageUrl };
  } catch (err) {
    const { code, message } = normalizeError(err);
    await markAiJobFailed(job.id, code, message);
    await auditAiJobOutcome(workspaceId, "ai_job.failed", job.id, { job_type: job.job_type, provider: job.provider, error_code: code });
    throw new Error(`AI image generation failed: ${message}`);
  }
}
