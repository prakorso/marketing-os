/**
 * AI Provider Interface (Engineering Blueprint §10). Only the six canonical
 * capability names are declared here — `generate_text`, `generate_image`,
 * `analyze_content`, `analyze_signal`, `generate_variants`,
 * `generate_insight` — matching Blueprint §10's exact list, which itself
 * calls them "potential capabilities."
 *
 * MVP-5.3 approved scope (DECISIONS #21/#22): only generateText and
 * generateImage are active consumers. The other four are declared (an
 * adapter must implement the full interface) but throw
 * AiCapabilityNotSupportedError rather than faking behavior — no mock/real
 * implementation exists for topic classification, content analysis,
 * variant generation, or insight generation in this phase.
 *
 * Adapters never resolve credentials themselves; the calling service
 * resolves the provider key and the adapter reads it only at the point of
 * its own outbound call (see openai-adapter.ts) — mirroring
 * src/lib/social/provider.ts's "adapter never sees/persists a credential it
 * didn't need to" discipline, adapted for a single platform-level key
 * (DECISIONS #23) rather than a per-call resolved value.
 */

export type AiProviderTextInput = {
  prompt: string;
  model: string;
};

export type AiProviderTextResult = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Raw provider response, kept for ai_jobs.output_reference (DECISIONS #25 hybrid semantics) — never logged with credentials attached. */
  raw: Record<string, unknown>;
};

export type AiProviderImageInput = {
  prompt: string;
  model: string;
};

export type AiProviderImageResult = {
  /** Base64-encoded image content, or a provider-hosted URL — never a local file path. */
  imageBase64: string | null;
  imageUrl: string | null;
  imageCount: number;
  raw: Record<string, unknown>;
};

/** Normalized AI provider failure — mirrors ProviderError (src/lib/social/provider.ts). */
export class AiProviderError extends Error {
  code: string;
  providerResponse: Record<string, unknown>;

  constructor(message: string, code: string, providerResponse: Record<string, unknown> = {}) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.providerResponse = providerResponse;
  }
}

/**
 * Thrown by the four inactive capability methods (DECISIONS #21/#22). Not a
 * provider failure — this is a deliberate "not built yet" signal, distinct
 * from AiProviderError, so callers/tests can tell the two apart.
 */
export class AiCapabilityNotSupportedError extends Error {
  constructor(capability: string) {
    super(`AI capability "${capability}" is not supported in this phase`);
    this.name = "AiCapabilityNotSupportedError";
  }
}

export interface AiProviderAdapter {
  generateText(input: AiProviderTextInput): Promise<AiProviderTextResult>;
  generateImage(input: AiProviderImageInput): Promise<AiProviderImageResult>;
  analyzeContent(input: unknown): Promise<never>;
  analyzeSignal(input: unknown): Promise<never>;
  generateVariants(input: unknown): Promise<never>;
  generateInsight(input: unknown): Promise<never>;
}

/**
 * Deterministic mock adapter — no network call, no real credential. Used by
 * every test in this phase (see registry.ts is NOT wired to this by
 * default in application code — the mock is imported directly by tests,
 * mirroring how MockProviderAdapter is the registry's only entry in the
 * social domain, but here the real OpenAiProviderAdapter is what the
 * registry resolves; tests substitute the mock explicitly).
 *
 * Testing seam: if `prompt` is exactly this sentinel value, the active
 * methods throw an AiProviderError instead of succeeding — mirroring
 * MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL's role in the social domain.
 */
export const AI_MOCK_FORCE_FAILURE_PROMPT = "ai-mock-force-failure";

export class MockAiProviderAdapter implements AiProviderAdapter {
  async generateText(input: AiProviderTextInput): Promise<AiProviderTextResult> {
    if (input.prompt === AI_MOCK_FORCE_FAILURE_PROMPT) {
      throw new AiProviderError("Mock AI provider forced failure", "mock_forced_failure", { mock: true });
    }
    return {
      text: `mock generated text for: ${input.prompt}`,
      inputTokens: 12,
      outputTokens: 8,
      raw: { mock: true, model: input.model },
    };
  }

  async generateImage(input: AiProviderImageInput): Promise<AiProviderImageResult> {
    if (input.prompt === AI_MOCK_FORCE_FAILURE_PROMPT) {
      throw new AiProviderError("Mock AI provider forced failure", "mock_forced_failure", { mock: true });
    }
    return {
      imageBase64: null,
      imageUrl: `https://mock.invalid/ai-image/${encodeURIComponent(input.prompt)}`,
      imageCount: 1,
      raw: { mock: true, model: input.model },
    };
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
