import "server-only";

import { OpenAiProviderAdapter } from "./openai-adapter";
import type { AiProviderAdapter } from "./provider";

/**
 * AI provider registry — resolves an adapter from `ai_jobs.provider`
 * (a plain text column, Database Architecture §10), mirroring
 * src/lib/social/registry.ts's platform-keyed pattern. Only "openai" is
 * registered (DECISIONS #23: OpenAI is the initial provider), but the
 * registry itself is provider-based so a future provider can be added here
 * without touching any caller — the same reusability goal social's registry
 * documents for itself.
 */
const registry: Record<string, AiProviderAdapter> = {
  openai: new OpenAiProviderAdapter(),
};

export function resolveAiProviderAdapter(provider: string): AiProviderAdapter {
  const adapter = registry[provider];
  if (!adapter) {
    throw new Error(`No AI provider adapter registered for provider: ${provider}`);
  }
  return adapter;
}
