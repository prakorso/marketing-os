import type { Config } from "@netlify/functions";

import { runScheduledPublications } from "@/server/services/publication-scheduler";

/**
 * MVP-2.4 Scheduled Execution — thin Netlify Scheduled Function.
 *
 * This file contains no business logic: it only invokes
 * runScheduledPublications() and reports a safe operational summary.
 * Scheduled Functions (the `config.schedule` export below) are not
 * publicly HTTP-routable — only Netlify's own scheduler invokes them —
 * so this is not a browser/client-reachable entry point. It is never
 * imported by, or reachable from, any Server Action, API route, or
 * client component in src/app.
 *
 * Logging is limited to counts and publication IDs from the summary
 * object returned by runScheduledPublications() — never a credential,
 * access token, or Authorization header. See publication-scheduler.ts
 * and publication-execution.ts for where those are resolved and why they
 * never leave server-side scope.
 */
const handler = async (): Promise<Response> => {
  try {
    const summary = await runScheduledPublications();

    console.log("[execute-due-publications] completed", {
      claimed: summary.claimed,
      succeeded: summary.succeeded,
      failed: summary.failed,
      publicationIds: summary.publicationIds,
    });

    return new Response(JSON.stringify({ ok: true, summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    console.error("[execute-due-publications] failed", error instanceof Error ? error.message : "unknown error");

    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

export default handler;

export const config: Config = {
  schedule: "*/5 * * * *",
};
