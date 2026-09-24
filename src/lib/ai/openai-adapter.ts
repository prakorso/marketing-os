import "server-only";

import {
  AiCapabilityNotSupportedError,
  AiProviderError,
  type AiProviderAdapter,
  type AiProviderImageInput,
  type AiProviderImageResult,
  type AiProviderTextInput,
  type AiProviderTextResult,
} from "./provider";

/**
 * OpenAI Provider Adapter (DECISIONS #23: OpenAI is the initial AI
 * provider, accessed only through the AI Provider Interface). Isolated
 * here per Engineering Blueprint §10 ("UI components must not call OpenAI
 * SDKs directly") — no other module in this codebase makes an OpenAI API
 * call.
 *
 * Credential handling (DECISIONS #23, approved D7): a single
 * environment-configured, server-side platform-level key. Read only at the
 * point of use, guarded by `import "server-only"`, exactly like
 * src/lib/supabase/service-role.ts's pattern — no shared env/config module
 * exists anywhere in this codebase, so none is introduced here. The key is
 * never included in any thrown error, log, or ai_jobs/ai_usage row.
 */

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not configured");
  }
  return apiKey;
}

export class OpenAiProviderAdapter implements AiProviderAdapter {
  async generateText(input: AiProviderTextInput): Promise<AiProviderTextResult> {
    const apiKey = getApiKey();

    let response: Response;
    try {
      response = await fetch(`${OPENAI_API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: input.prompt }],
        }),
      });
    } catch (err) {
      // Network-level failure — never include the request headers/apiKey.
      throw new AiProviderError(err instanceof Error ? err.message : "OpenAI request failed", "network_error", {});
    }

    const data: unknown = await response.json().catch(() => ({}));
    const payload = (data ?? {}) as Record<string, unknown>;

    if (!response.ok) {
      const errorInfo = (payload.error ?? {}) as Record<string, unknown>;
      throw new AiProviderError(
        typeof errorInfo.message === "string" ? errorInfo.message : "OpenAI text generation failed",
        typeof errorInfo.code === "string" ? errorInfo.code : String(response.status),
        payload,
      );
    }

    const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
    const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

    return {
      text: choices?.[0]?.message?.content ?? "",
      inputTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
      outputTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
      raw: payload,
    };
  }

  async generateImage(input: AiProviderImageInput): Promise<AiProviderImageResult> {
    const apiKey = getApiKey();

    let response: Response;
    try {
      response = await fetch(`${OPENAI_API_BASE_URL}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          prompt: input.prompt,
          n: 1,
        }),
      });
    } catch (err) {
      throw new AiProviderError(err instanceof Error ? err.message : "OpenAI request failed", "network_error", {});
    }

    const data: unknown = await response.json().catch(() => ({}));
    const payload = (data ?? {}) as Record<string, unknown>;

    if (!response.ok) {
      const errorInfo = (payload.error ?? {}) as Record<string, unknown>;
      throw new AiProviderError(
        typeof errorInfo.message === "string" ? errorInfo.message : "OpenAI image generation failed",
        typeof errorInfo.code === "string" ? errorInfo.code : String(response.status),
        payload,
      );
    }

    const results = payload.data as Array<{ b64_json?: string; url?: string }> | undefined;
    const first = results?.[0];

    return {
      imageBase64: first?.b64_json ?? null,
      imageUrl: first?.url ?? null,
      imageCount: results?.length ?? 0,
      raw: payload,
    };
  }

  // MVP-5.3 approved scope (DECISIONS #21/#22): these four capabilities are
  // named on the interface per Blueprint §10, but not implemented — no
  // fake AI behavior is created for them in this phase.
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
