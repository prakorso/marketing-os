import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LEVEL4_CONFIRMATION, LEVEL4_FIXTURE_TAG, LEVEL4_IDEMPOTENCY_PREFIX } from "../../scripts/mvp-5.35-level4-dry-run";
import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.35C-F — LOCAL smoke of the REAL CLI entrypoints under the pinned
 * runner, exactly as a Level 4 operator would start them:
 *
 *   npx --no-install tsx --conditions=react-server scripts/<script>.ts …
 *
 * plus one harness preload (`--import tests/smoke/level4-mock-graph.mjs`)
 * that answers graph.instagram.com in-process (MOCK_PROVIDER), blocks any
 * other non-loopback host and refuses to load unless Supabase is local. The
 * scripts are unmodified: main() runs its real wiring (local Vault RPC with
 * a FAKE token, local storage signing, the two Graph functions). Fake IDs only.
 */

const REPO = path.resolve(__dirname, "../..");
const PRELOAD = "./tests/smoke/level4-mock-graph.mjs";
const FAKE_TOKEN = "IGAAfakeCliSmokeToken000000000000000001";
const FAKE_IG_ID = "17849990000000042";

type Logged = { host: string; method: string; path: string; kind: string };

function runCli(script: string, args: string[], logFile: string) {
  const res = spawnSync("npx", ["--no-install", "tsx", "--conditions=react-server", "--import", PRELOAD, script, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 90_000,
    env: {
      NODE_ENV: "production",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      MOCK_GRAPH_LOG: logFile,
    },
  });
  writeFileSync(`${logFile}.stdout`, res.stdout ?? "");
  writeFileSync(`${logFile}.stderr`, res.stderr ?? "");
  let log: Logged[] = [];
  try {
    log = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    log = [];
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, log };
}

describe.skipIf(!hasLocalSupabase)("MVP-5.35C-F Level 4 CLI smoke (pinned tsx runner, LOCAL Supabase, MOCK_PROVIDER)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;
  // Set L4_SMOKE_EVIDENCE_DIR to keep the request logs and stdout for a report.
  const keep = process.env.L4_SMOKE_EVIDENCE_DIR;
  const dir = keep ?? mkdtempSync(path.join(tmpdir(), "l4-cli-smoke-"));
  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let workspaceSlug: string;
  let publicationId: string;
  let scheduledPublicationId: string;
  let vaultId: string;
  const objects: string[] = [];

  async function fixturePublication(accountId: string, contentId: string, status: "scheduled" | "publishing") {
    const { data: version } = await admin
      .from("content_versions")
      .insert({ content_id: contentId, workspace_id: workspaceId, version_number: Math.floor(Math.random() * 1e9) + 1, generation_method: "human", content_payload: { text: LEVEL4_FIXTURE_TAG } })
      .select()
      .single();
    await admin.from("content_approvals").insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: version!.id, status: "approved", reviewed_at: new Date().toISOString() });
    const { data: variant } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "MARQOS Level 4 dry run — unpublished container test", metadata: { fixture: LEVEL4_FIXTURE_TAG } })
      .select()
      .single();
    const assetId = crypto.randomUUID();
    const storagePath = `${workspaceId}/${assetId}.jpg`;
    const { error: uploadError } = await admin.storage.from("assets").upload(storagePath, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { contentType: "image/jpeg" });
    if (uploadError) throw new Error(`upload: ${uploadError.message}`);
    objects.push(storagePath);
    await admin.from("marqos_assets").insert({ id: assetId, workspace_id: workspaceId, storage_path: storagePath, file_name: `${assetId}.jpg`, mime_type: "image/jpeg", asset_type: "image", file_size: 400_000, width: 1080, height: 1350, metadata: { fixture: "mvp-5.35-level4" } });
    await admin.from("marqos_content_variant_assets").insert({ content_variant_id: variant!.id, asset_id: assetId, workspace_id: workspaceId, sort_order: 0 });
    const { data: pub, error } = await admin
      .from("publications")
      .insert({ workspace_id: workspaceId, content_variant_id: variant!.id, social_account_id: accountId, status: "scheduled", scheduled_at: new Date(Date.now() + 365 * 86_400_000).toISOString(), idempotency_key: `${LEVEL4_IDEMPOTENCY_PREFIX}${crypto.randomUUID()}` })
      .select()
      .single();
    if (error || !pub) throw new Error(`publication: ${error?.message}`);
    if (status === "publishing") await admin.from("publications").update({ status: "publishing" }).eq("id", pub.id);
    return pub.id;
  }

  beforeAll(async () => {
    expect(["127.0.0.1", "localhost"]).toContain(new URL(supabaseUrl!).hostname);
    editor = await createSignedInTestUser(admin);
    workspaceSlug = `l4-cli-${Date.now()}`;
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "L4 CLI smoke", p_slug: workspaceSlug });
    workspaceId = ws!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "MARQOS L4 DRY RUN — DO NOT PUBLISH" }).select().single();
    const { data: vault } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "l4-cli-smoke" });
    vaultId = vault as string;
    const { data: account } = await admin
      .from("social_accounts")
      .insert({ workspace_id: workspaceId, platform: "instagram", external_account_id: FAKE_IG_ID, account_name: "l4-cli", status: "connected", vault_secret_id: vaultId, metadata: { credentialKind: "real", instagramScopedUserId: "38281234567890123" } })
      .select()
      .single();
    publicationId = await fixturePublication(account!.id, content!.id, "publishing");
    scheduledPublicationId = await fixturePublication(account!.id, content!.id, "scheduled");
  });

  afterAll(async () => {
    if (objects.length) await admin.storage.from("assets").remove(objects);
    if (vaultId) await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: vaultId });
    await cleanupTestData(admin, { workspaceIds: [workspaceId].filter(Boolean), userIds: [editor?.userId].filter((id): id is string => Boolean(id)) });
    if (!keep) rmSync(dir, { recursive: true, force: true });
  });

  it("the runner refuses to start the script without the react-server condition (server-only guard intact)", () => {
    const res = spawnSync("npx", ["--no-install", "tsx", "scripts/mvp-5.35-level4-dry-run.ts"], { cwd: REPO, encoding: "utf8", timeout: 60_000, env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME } });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("server-only");
  });

  it("preflight CLI: read-only, stops before any credential, reports FIXTURE_READY_EXCEPT_STATE_MOVE for a scheduled fixture", () => {
    const run = runCli("scripts/mvp-5.35-level4-preflight.ts", ["--workspace", workspaceId, "--publication", scheduledPublicationId], path.join(dir, "preflight.log"));
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.verdict).toBe("FIXTURE_READY_EXCEPT_STATE_MOVE");
    expect(out.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([{ guard: "F_state", ok: false, code: "publication_not_publishing" }]);
    expect(run.log.every((e) => e.kind === "local" && e.method === "GET" && e.path.startsWith("/rest/v1/"))).toBe(true);
    expect(run.log.some((e) => e.path.includes("/rpc/"))).toBe(false);
  });

  it("operator CLI: guards → credential → exactly one mock container → FINISHED → dry_run_container_ready; rerun refuses", async () => {
    const args = ["--workspace", workspaceSlug, "--publication", publicationId, `--confirm-level4-dry-run=${LEVEL4_CONFIRMATION}`];
    const run = runCli("scripts/mvp-5.35-level4-dry-run.ts", args, path.join(dir, "run1.log"));
    expect(run.status).toBe(0);
    const evidence = JSON.parse(run.stdout);
    expect(evidence).toMatchObject({
      result: "dry_run_container_ready",
      workspaceId,
      publicationId,
      containerId: "17900000000000000888",
      attemptStage: "failed",
      publicationStatus: "failed",
      errorCode: "dry_run_container_ready",
      providerCalls: { create: 1, status: 2 },
      providerStatusTransitions: ["IN_PROGRESS", "FINISHED"],
    });

    // Ordering: every guard read → Vault RPC (local, fake token) → signing → Graph.
    const idx = (pred: (e: Logged) => boolean) => run.log.findIndex(pred);
    const vaultRead = idx((e) => e.path === "/rest/v1/rpc/read_social_account_vault_secret");
    const lastGuardRead = idx((e) => e.method === "GET" && e.path === "/rest/v1/publication_attempts");
    const attemptInsert = idx((e) => e.method === "POST" && e.path === "/rest/v1/publication_attempts");
    const sign = idx((e) => e.path.startsWith("/storage/v1/object/sign/"));
    const create = idx((e) => e.kind === "graph_container_create");
    expect(lastGuardRead).toBeGreaterThanOrEqual(0);
    expect(vaultRead).toBeGreaterThan(lastGuardRead);
    expect(attemptInsert).toBeGreaterThan(vaultRead);
    expect(sign).toBeGreaterThan(vaultRead);
    expect(create).toBeGreaterThan(sign);
    expect(run.log.filter((e) => e.path === "/rest/v1/rpc/read_social_account_vault_secret")).toHaveLength(1);

    // Provider surface: one container create, two status reads, never media_publish, nothing else off-box.
    expect(run.log.filter((e) => e.kind === "graph_container_create").map((e) => e.path)).toEqual([`/${FAKE_IG_ID}/media`]);
    expect(run.log.filter((e) => e.kind === "graph_container_status")).toHaveLength(2);
    expect(run.log.filter((e) => e.kind === "graph_unexpected" || e.kind === "blocked")).toEqual([]);
    expect(run.log.some((e) => e.path.includes("media_publish"))).toBe(false);

    // No secret in any output.
    const emitted = run.stdout + run.stderr;
    for (const secret of [FAKE_TOKEN, "access_token", "/storage/v1/object/sign", "token=", process.env.SUPABASE_SERVICE_ROLE_KEY!, vaultId]) {
      expect(emitted).not.toContain(secret);
    }

    const { data: attempts } = await admin.from("publication_attempts").select("stage, error_code, container_ids").eq("publication_id", publicationId);
    expect(attempts).toEqual([{ stage: "failed", error_code: "dry_run_container_ready", container_ids: ["17900000000000000888"] }]);

    // Rerun: refused by the guards — no Vault read, no signing, no Graph request, no new attempt.
    const rerun = runCli("scripts/mvp-5.35-level4-dry-run.ts", args, path.join(dir, "run2.log"));
    expect(rerun.status).toBe(2);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ result: "refused", code: "publication_not_publishing", containerId: null });
    expect(rerun.log.every((e) => e.kind === "local" && e.method === "GET" && !e.path.includes("/rpc/"))).toBe(true);
    const { count } = await admin.from("publication_attempts").select("id", { count: "exact", head: true }).eq("publication_id", publicationId);
    expect(count).toBe(1);
  });
});
