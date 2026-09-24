// MVP-5.35C-F — TEST HARNESS ONLY (MOCK_PROVIDER for the real CLI entrypoint).
//
// Preloaded with `--import` by tests/database/level4-operator-cli-smoke.test.ts
// so the UNMODIFIED operator/preflight CLIs can run end to end against LOCAL
// Supabase. The scripts know nothing about it (no flag, no env switch).
//
//  - Refuses to load unless NEXT_PUBLIC_SUPABASE_URL is a loopback address.
//  - Loopback requests (local Supabase) pass through and are recorded.
//  - graph.instagram.com is answered IN-PROCESS (never reaches the network):
//      POST /<ig-id>/media          → fake container id
//      GET  /<container>?fields=... → IN_PROGRESS, then FINISHED
//      POST /<ig-id>/media_publish  → fake media id (MVP-5.35C-I Level 5 smoke;
//                                     the Level 4 smoke asserts it never happens)
//      GET  /<that media id>?fields=…permalink… → fake verification (C-J.1 G4)
//      anything else → recorded, HTTP 500
//  - Every other host is recorded and blocked.
// Only host, method and path are recorded — never query strings or bodies.
import { appendFileSync } from "node:fs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid.invalid").hostname;
if (!LOOPBACK.has(supabaseHost)) {
  throw new Error("level4-mock-graph: refusing to run against a non-local Supabase");
}

const logFile = process.env.MOCK_GRAPH_LOG;
const record = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const realFetch = globalThis.fetch.bind(globalThis);
let statusReads = 0;

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const entry = { host: url.hostname, method, path: url.pathname };

  if (LOOPBACK.has(url.hostname)) {
    record({ ...entry, kind: "local" });
    return realFetch(input, init);
  }
  if (url.hostname === "graph.instagram.com") {
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && /^\/\d+\/media$/.test(url.pathname)) {
      record({ ...entry, kind: "graph_container_create" });
      return json(200, { id: "17900000000000000888" });
    }
    if (method === "GET" && url.pathname === "/18000000000000000555" && (url.searchParams.get("fields") ?? "").includes("permalink")) {
      record({ ...entry, kind: "graph_media_read" });
      return json(200, { id: "18000000000000000555", permalink: "https://www.instagram.com/p/MOCKL5TEST/", timestamp: "2026-09-24T12:00:00+0000", media_type: "IMAGE" });
    }
    if (method === "GET" && /^\/\d+$/.test(url.pathname) && url.searchParams.get("fields") === "status_code") {
      statusReads += 1;
      record({ ...entry, kind: "graph_container_status" });
      return json(200, { status_code: statusReads === 1 ? "IN_PROGRESS" : "FINISHED" });
    }
    if (method === "POST" && /^\/\d+\/media_publish$/.test(url.pathname)) {
      record({ ...entry, kind: "graph_media_publish" });
      return json(200, { id: "18000000000000000555" });
    }
    record({ ...entry, kind: "graph_unexpected" });
    return json(500, { error: { message: "unexpected graph request in MOCK_PROVIDER harness" } });
  }
  record({ ...entry, kind: "blocked" });
  throw new TypeError("level4-mock-graph: network access blocked");
};
