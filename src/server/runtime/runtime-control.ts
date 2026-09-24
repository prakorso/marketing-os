import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, PublishingRuntimeMode } from "@/types/database";

/**
 * MVP-5.36 (Decision #44) — the two independent runtime publishing controls.
 * Both must be ON; everything else is OFF (fail-closed).
 */

export const RUNTIME_CONTROL_KEY = "instagram_scheduled_publishing" as const;

export type RuntimeControlState =
  | { on: true; mode: PublishingRuntimeMode }
  | { on: false; reason: "missing" | "unreadable" | "disabled" };

/** DB runtime control (the fast kill switch). Missing row, read failure or enabled !== true ⇒ OFF. */
export async function readRuntimeControl(client: SupabaseClient<Database> | null): Promise<RuntimeControlState> {
  if (!client) return { on: false, reason: "unreadable" };
  try {
    const { data, error } = await client
      .from("publishing_runtime_control")
      .select("enabled, mode")
      .eq("key", RUNTIME_CONTROL_KEY)
      .maybeSingle();
    if (error) return { on: false, reason: "unreadable" };
    if (!data) return { on: false, reason: "missing" };
    if (data.enabled !== true) return { on: false, reason: "disabled" };
    // Anything but an explicit 'publish' is dry run: the publish request is then structurally impossible.
    return { on: true, mode: data.mode === "publish" ? "publish" : "dry_run" };
  } catch {
    return { on: false, reason: "unreadable" };
  }
}

/** Deploy-time env gate: exactly "enabled", nothing else. */
export function isEnvPublishingGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MARQOS_INSTAGRAM_STAGED_PUBLISHING === "enabled";
}
