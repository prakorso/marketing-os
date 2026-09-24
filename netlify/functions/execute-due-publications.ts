import type { Config } from "@netlify/functions";

import { createRuntimeServiceClient } from "@/server/runtime/runtime-client";
import { runScheduledPublishingRuntime } from "@/server/runtime/scheduled-publishing";

/**
 * MVP-5.36 (Decision #44) — thin Netlify Scheduled Function for the
 * Level-6 unattended publishing runtime.
 *
 * All business logic, both gates (DB runtime control + env
 * MARQOS_INSTAGRAM_STAGED_PUBLISHING), the allowlisted capped claim, the
 * provider-free reconciliation, the time budget and the provider-call
 * ceiling live in src/server/runtime/scheduled-publishing.ts. Its module
 * graph is free of `server-only` so this function loads under the Netlify
 * function bundler's default resolution conditions.
 *
 * Scheduled Functions are not publicly HTTP-routable and are not retried.
 * The handler always answers 200 with the safe summary (counts, ids and
 * codes only — never a credential, key, signed URL or request body).
 */
const handler = async (): Promise<Response> => {
  try {
    const summary = await runScheduledPublishingRuntime({ client: createRuntimeServiceClient() });
    return Response.json({ ok: true, summary });
  } catch {
    console.error(JSON.stringify({ scope: "marqos-runtime", event: "final", outcome: "unhandled_error" }));
    return Response.json({ ok: false });
  }
};

export default handler;

export const config: Config = {
  schedule: "*/5 * * * *",
};
