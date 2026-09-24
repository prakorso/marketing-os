import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInstagramMediaContainer, getInstagramMediaContainerStatus, publishInstagramMediaContainer } from "@/lib/social/instagram-adapter";
import type { StagedMediaPublisher } from "@/lib/social/provider";
import { createAttemptStore, type AttemptStore } from "@/server/services/instagram-image-publishing";
import type { ContentVariant, Database, SocialAccount } from "@/types/database";

import { LEVEL4_FIXTURE, LEVEL5_FIXTURE } from "../../scripts/lib/operator-target";
import { installProviderCallGuard, type ProviderCallGuard } from "../../scripts/lib/provider-call-guard";
import { LEVEL5_CONFIRMATION, level5StatusReadCeiling, runLevel5PublishOperator, type Level5Deps } from "../../scripts/mvp-5.35-level5-publish";
import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.35C-I — Level 5 operator in TEST_MODE: LOCAL Supabase; the REAL
 * Graph adapter functions run under the REAL provider-call guard, whose
 * base fetch answers graph.instagram.com in-process (MOCK_PROVIDER) and
 * passes only loopback Supabase through. No Meta call is possible. Fake IDs
 * and fake secrets only.
 */

const REPO = path.resolve(__dirname, "../..");
const FAKE_TOKEN = "IGAAfakeLevel5Token00000000000000001";
const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-L5-0001";
const FAKE_IG_ID = "17849990000000042";
const CONTAINER = "17900000000000000888";
const MEDIA = "18000000000000000555";
const CONFIRM = `--confirm-level5-publish=${LEVEL5_CONFIRMATION}`;

type GraphMode = "ok" | "publish_throws" | "publish_500";
const PERMALINK = "https://www.instagram.com/p/FAKEL5POST/";
/** G4 (verification read) behaviors after a successful publish. */
type G4Mode = "ok" | "timeout" | "http_500" | "malformed_json" | "missing_id" | "invalid_id" | "mismatched_id" | "missing_permalink" | "unsafe_permalink" | "video";

describe.skipIf(!hasLocalSupabase)("MVP-5.35C-I Level 5 operator (local DB, guarded MOCK_PROVIDER)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;
  const dir = mkdtempSync(path.join(tmpdir(), "l5-op-"));
  const realFetch = globalThis.fetch;
  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let workspaceSlug: string;
  let contentId: string;
  let account: SocialAccount;
  let threadsAccount: SocialAccount;
  const vaultIds: string[] = [];
  const objects: string[] = [];

  async function variant(opts: { tag?: string; mime?: string; ext?: string } = {}): Promise<ContentVariant> {
    const { data: version } = await admin
      .from("content_versions")
      .insert({ content_id: contentId, workspace_id: workspaceId, version_number: Math.floor(Math.random() * 1e9) + 1, generation_method: "human", content_payload: { text: "l5" } })
      .select()
      .single();
    await admin.from("content_approvals").insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: version!.id, status: "approved", reviewed_at: new Date().toISOString() });
    const { data: v } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "System test post by MARQOS (automated publishing check). Please ignore.", metadata: { fixture: opts.tag ?? LEVEL5_FIXTURE.tag } })
      .select()
      .single();
    const assetId = crypto.randomUUID();
    const ext = opts.ext ?? "jpg";
    const storagePath = `${workspaceId}/${assetId}.${ext}`;
    await admin.storage.from("assets").upload(storagePath, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { contentType: opts.mime ?? "image/jpeg" });
    objects.push(storagePath);
    await admin.from("marqos_assets").insert({ id: assetId, workspace_id: workspaceId, storage_path: storagePath, file_name: `${assetId}.${ext}`, mime_type: opts.mime ?? "image/jpeg", asset_type: "image", file_size: 400_000, width: 1080, height: 1350 });
    await admin.from("marqos_content_variant_assets").insert({ content_variant_id: v!.id, asset_id: assetId, workspace_id: workspaceId, sort_order: 0 });
    return v!;
  }

  async function publication(opts: { v?: ContentVariant; acct?: SocialAccount; status?: "scheduled" | "publishing"; prefix?: string } = {}) {
    const v = opts.v ?? (await variant());
    const { data, error } = await admin
      .from("publications")
      .insert({ workspace_id: workspaceId, content_variant_id: v.id, social_account_id: (opts.acct ?? account).id, status: "scheduled", scheduled_at: new Date(Date.now() + 365 * 86_400_000).toISOString(), idempotency_key: `${opts.prefix ?? LEVEL5_FIXTURE.idempotencyPrefix}${crypto.randomUUID()}` })
      .select()
      .single();
    if (error || !data) throw new Error(`publication: ${error?.message}`);
    if ((opts.status ?? "publishing") === "publishing") await admin.from("publications").update({ status: "publishing" }).eq("id", data.id);
    return data.id;
  }

  /** One operator process: guard installed first, then the operator's own client (as main() does). */
  async function operate(argv: string[], opts: { mode?: GraphMode; g4?: G4Mode; failCheckpoint?: boolean; failPublishedWrite?: boolean; credential?: string } = {}) {
    const evidencePath = path.join(dir, `ev-${crypto.randomUUID()}.jsonl`);
    const graph: string[] = [];
    const resolved: string[] = [];
    const mode = opts.mode ?? "ok";
    const g4 = opts.g4 ?? "ok";
    const g4Fields: string[] = [];
    const guard: ProviderCallGuard = installProviderCallGuard({
      supabaseUrl: supabaseUrl!,
      evidencePath,
      statusReadCeiling: level5StatusReadCeiling(),
      allowMediaRead: true, // as main() installs it (owner-authorized G4)
      baseFetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === "graph.instagram.com") {
          graph.push(`${init?.method ?? "GET"} ${url.pathname}`);
          const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
          if (url.pathname.endsWith("/media_publish")) {
            if (mode === "publish_throws") throw Object.assign(new Error("reset"), { name: "TypeError" });
            if (mode === "publish_500") return json(500, { error: { message: "internal" } });
            return json(200, { id: MEDIA });
          }
          if (url.pathname.endsWith("/media")) return json(200, { id: CONTAINER });
          if (url.pathname === `/${MEDIA}`) {
            g4Fields.push(url.searchParams.get("fields") ?? "");
            const good = { id: MEDIA, permalink: PERMALINK, timestamp: "2026-09-24T12:00:00+0000", media_type: "IMAGE" };
            if (g4 === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
            if (g4 === "http_500") return json(500, { error: { message: "internal" } });
            if (g4 === "malformed_json") return new Response("{not json", { status: 200 });
            if (g4 === "missing_id") return json(200, { ...good, id: undefined });
            if (g4 === "invalid_id") return json(200, { ...good, id: "18000000000000000555x" });
            if (g4 === "mismatched_id") return json(200, { ...good, id: "18000000000000000556" });
            if (g4 === "missing_permalink") return json(200, { ...good, permalink: undefined });
            if (g4 === "unsafe_permalink") return json(200, { ...good, permalink: `${PERMALINK}?access_token=LEAKY` });
            if (g4 === "video") return json(200, { ...good, media_type: "VIDEO" });
            return json(200, good);
          }
          return json(200, { status_code: "FINISHED" });
        }
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("test harness: non-loopback");
        return realFetch(input, init);
      }) as typeof fetch,
    });
    try {
      const db = createClient<Database>(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
      const base = createAttemptStore(db);
      const failStage = opts.failCheckpoint ? "publish_requested" : opts.failPublishedWrite ? "published" : null;
      const attempts: AttemptStore = failStage
        ? { ...base, update: async (ws, id, patch) => (patch.stage === failStage ? Promise.reject(new Error("injected")) : base.update(ws, id, patch)) }
        : base;
      const provider: StagedMediaPublisher = {
        createMediaContainer: createInstagramMediaContainer,
        getMediaContainerStatus: getInstagramMediaContainerStatus,
        publishMediaContainer: publishInstagramMediaContainer,
        listRecentMedia: async () => ({ ok: true, items: [] }),
      };
      const deps: Level5Deps = {
        db,
        guard,
        attempts,
        provider,
        resolveCredential: async (acct) => {
          resolved.push(acct.id);
          return opts.credential ?? FAKE_TOKEN;
        },
        signMediaUrl: async () => SIGNED_URL,
        sleep: async () => {},
        log: () => {},
      };
      const result = await runLevel5PublishOperator(argv, deps);
      // A second media_publish from the same process is impossible once one was dispatched (or never armed).
      const secondPublish = await fetch(`https://graph.instagram.com/${FAKE_IG_ID}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: CONTAINER }) }).then(
        () => "dispatched",
        (err: Error) => err.message,
      );
      // …and a second G4 read is impossible (ceiling after one read; never allowed without a captured G3 id).
      const secondVerify = await fetch(`https://graph.instagram.com/${MEDIA}?fields=id`).then(
        () => "dispatched",
        (err: Error) => err.message,
      );
      const events = readFileSync(evidencePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      return { ...result, graph, g4Fields, resolved, guard: { armed: guard.armed, counters: guard.counters() }, events, evidenceText: readFileSync(evidencePath, "utf8"), secondPublish, secondVerify };
    } finally {
      guard.uninstall();
    }
  }

  const argv = (publicationId: string, workspace = workspaceId) => ["--workspace", workspace, "--publication", publicationId, CONFIRM];
  const attemptsOf = async (id: string) => (await admin.from("publication_attempts").select("*").eq("publication_id", id).order("attempt_number")).data ?? [];
  const pubRow = async (id: string) => (await admin.from("publications").select("*").eq("id", id).single()).data!;

  async function expectRefused(args: string[], code: string) {
    const run = await operate(args);
    expect(run.exitCode).toBe(2);
    expect(run.evidence).toMatchObject({ result: "refused", code });
    expect(run.resolved).toEqual([]); // credential never resolved
    expect(run.graph).toEqual([]);
    expect(run.guard.counters).toMatchObject({ S2: 0, S3: 0, G1: 0, G2: 0, G3: 0 });
    return run;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    workspaceSlug = `l5-op-${Date.now()}`;
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "L5 operator", p_slug: workspaceSlug });
    workspaceId = ws!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "MARQOS L5 PUBLISH TEST" }).select().single();
    contentId = content!.id;
    const insertAccount = async (row: Record<string, unknown>) => {
      const { data: secret } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "l5-op" });
      vaultIds.push(secret as string);
      const { data } = await admin
        .from("social_accounts")
        .insert({ workspace_id: workspaceId, status: "connected", vault_secret_id: secret as string, ...row } as never)
        .select()
        .single();
      return data as SocialAccount;
    };
    account = await insertAccount({ platform: "instagram", external_account_id: FAKE_IG_ID, account_name: "l5", metadata: { credentialKind: "real", instagramScopedUserId: "38281234567890123" } });
    threadsAccount = await insertAccount({ platform: "threads", external_account_id: "100000000000002", account_name: "l5-threads", metadata: { credentialKind: "fake" } });
  });

  afterAll(async () => {
    if (objects.length) await admin.storage.from("assets").remove(objects);
    for (const id of vaultIds) await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
    await cleanupTestData(admin, { workspaceIds: [workspaceId].filter(Boolean), userIds: [editor?.userId].filter((id): id is string => Boolean(id)) });
    rmSync(dir, { recursive: true, force: true });
  });

  describe("guards refuse before credential, signing or any Graph request", () => {
    it("arguments: missing workspace/publication/confirmation, wrong confirmation, a Level 4 confirmation", async () => {
      const pub = await publication();
      await expectRefused(["--publication", pub, CONFIRM], "missing_workspace_arg");
      await expectRefused(["--workspace", workspaceId, CONFIRM], "missing_publication_arg");
      await expectRefused(["--workspace", workspaceId, "--publication", pub], "missing_confirmation");
      await expectRefused(["--workspace", workspaceId, "--publication", pub, "--confirm-level5-publish=yes"], "wrong_confirmation");
      await expectRefused(["--workspace", workspaceId, "--publication", pub, "--confirm-level4-dry-run=CREATE_ONE_UNPUBLISHED_INSTAGRAM_CONTAINER"], "unknown_argument");
      expect(await attemptsOf(pub)).toEqual([]);
    });

    it("fixture contract: wrong tag, the Level 4 fixture, wrong idempotency prefix", async () => {
      await expectRefused(argv(await publication({ v: await variant({ tag: "something-else" }) })), "not_level5_fixture");
      await expectRefused(argv(await publication({ v: await variant({ tag: LEVEL4_FIXTURE.tag }), prefix: LEVEL4_FIXTURE.idempotencyPrefix })), "not_level5_fixture");
      await expectRefused(argv(await publication({ prefix: "ordinary-" })), "not_level5_fixture");
    });

    it("state, account, asset and attempt history", async () => {
      await expectRefused(argv(await publication({ status: "scheduled" })), "publication_not_publishing");
      await expectRefused(argv(await publication({ acct: threadsAccount })), "account_not_instagram");
      await expectRefused(argv(await publication({ v: await variant({ mime: "image/png", ext: "png" }) })), "media_unsupported_media_type");
      const withAttempt = await publication();
      await admin.from("publication_attempts").insert({ workspace_id: workspaceId, publication_id: withAttempt, provider: "instagram" });
      await expectRefused(argv(withAttempt), "prior_attempt_exists");
    });
  });

  describe("valid MOCK_PROVIDER path", () => {
    it("one create → FINISHED → checkpoint → ARMED → exactly one media_publish → attempt published FIRST → publication published; rerun refused", async () => {
      const pub = await publication();
      const run = await operate(argv(pub, workspaceSlug));
      expect(run.exitCode).toBe(0);
      expect(run.evidence).toMatchObject({
        result: "published",
        workspaceId,
        publicationId: pub,
        igAccountId: FAKE_IG_ID,
        containerId: CONTAINER,
        mediaId: MEDIA,
        attemptStage: "published",
        publicationStatus: "published",
        providerCalls: { create: 1, status: 1, publish: 1, verify: 1 },
        providerStatusTransitions: ["FINISHED"],
        verification: { attempted: true, verified: true, code: "verified", mediaId: MEDIA, permalink: PERMALINK, timestamp: "2026-09-24T12:00:00+0000", mediaType: "IMAGE" },
      });
      expect(run.resolved).toEqual([account.id]);
      expect(run.graph).toEqual([`POST /${FAKE_IG_ID}/media`, `GET /${CONTAINER}`, `POST /${FAKE_IG_ID}/media_publish`, `GET /${MEDIA}`]);
      expect(run.g4Fields).toEqual(["id,permalink,timestamp,media_type"]); // exact G3 media id, exact safe fields
      expect(run.guard.counters).toMatchObject({ S2: 0, G1: 1, G2: 1, G3: 1, G4: 1, blocked: 2 }); // blocked = the two probes below
      expect(run.secondPublish).toMatch(/ceiling_reached/);
      expect(run.secondVerify).toMatch(/ceiling_reached/);

      // Evidence ordering: target authorized → G1 → G2 FINISHED → checkpoint PATCH → ARMED → G3 DISPATCH → attempt PATCH → publication PATCH.
      const idx = (pred: (e: Record<string, unknown>) => boolean) => run.events.findIndex(pred);
      const authorized = idx((e) => e.event === "TARGET_AUTHORIZED");
      const g1 = idx((e) => e.rule === "G1" && e.event === "DISPATCH");
      const finished = idx((e) => e.rule === "G2" && e.status_code === "FINISHED");
      const armed = idx((e) => e.event === "ARMED");
      const g3 = idx((e) => e.rule === "G3" && e.event === "DISPATCH");
      const g3Response = idx((e) => e.rule === "G3" && e.event === "RESPONSE");
      const attemptPatches = run.events.map((e, i) => (e.method === "PATCH" && e.path === "/rest/v1/publication_attempts" ? i : -1)).filter((i) => i >= 0);
      const pubPatch = idx((e) => e.method === "PATCH" && e.path === "/rest/v1/publications");
      expect(authorized).toBeGreaterThan(-1);
      expect(g1).toBeGreaterThan(authorized);
      expect(finished).toBeGreaterThan(g1);
      expect(armed).toBeGreaterThan(finished);
      expect(attemptPatches.some((i) => i > finished && i < armed)).toBe(true); // the publish_requested checkpoint resolved first
      expect(g3).toBeGreaterThan(armed);
      expect(run.events[g3Response]).toMatchObject({ status: 200, capturedId: MEDIA });
      expect(Math.max(...attemptPatches)).toBeLessThan(pubPatch); // attempt 'published' before the publication
      // G4 only AFTER the publication was durably published (PATCH) and read back (GET).
      const g4 = idx((e) => e.rule === "G4" && e.event === "RESPONSE");
      const readBacks = run.events.map((e, i) => (e.method === "GET" && e.path === "/rest/v1/publications" && i > pubPatch ? i : -1)).filter((i) => i >= 0);
      expect(g4).toBeGreaterThan(pubPatch);
      expect(readBacks.some((i) => i < g4)).toBe(true);
      expect(run.events[g4]).toMatchObject({ path: `/${MEDIA}`, status: 200 });

      const [attempt] = await attemptsOf(pub);
      expect(attempt).toMatchObject({ stage: "published", external_media_id: MEDIA, container_ids: [CONTAINER] });
      expect(await pubRow(pub)).toMatchObject({ status: "published", external_publication_id: MEDIA });

      // Redaction: no token / signed URL anywhere.
      for (const text of [JSON.stringify(run.evidence), run.evidenceText]) {
        for (const secret of [FAKE_TOKEN, SIGNED_URL, "SIGNEDURLSENTINEL", "access_token", process.env.SUPABASE_SERVICE_ROLE_KEY!]) expect(text).not.toContain(secret);
      }

      // Rerun: refused by guards (published); nothing dispatched.
      await expectRefused(argv(pub), "publication_not_publishing");
    });

    it("checkpoint (publish_requested) persistence failure → guard never armed, media_publish dispatched 0, known-not-published", async () => {
      const pub = await publication();
      const run = await operate(argv(pub), { failCheckpoint: true });
      expect(run.evidence).toMatchObject({ result: "failed_known", code: "checkpoint_failed", publicationStatus: "failed" });
      expect(run.guard.armed).toBe(false);
      expect(run.guard.counters.G3).toBe(0);
      expect(run.graph.some((g) => g.includes("media_publish"))).toBe(false);
      expect(run.secondPublish).toMatch(/not_armed/);
      expect(run.evidence.verification).toMatchObject({ attempted: false, code: "not_applicable" });
      expect(run.guard.counters.G4).toBe(0);
      expect(run.secondVerify).toMatch(/graph_id_not_authorized/);
    });

    it.each(["publish_throws", "publish_500"] as const)("ambiguous media_publish (%s) → outcome_unknown, publication stays publishing, no second dispatch, rerun refused", async (mode) => {
      const pub = await publication();
      const run = await operate(argv(pub), { mode });
      expect(run.exitCode).toBe(1);
      expect(run.evidence).toMatchObject({ result: "outcome_unknown", attemptStage: "outcome_unknown", publicationStatus: "publishing", mediaId: null });
      expect(run.guard.counters.G3).toBe(1);
      expect(run.graph.filter((g) => g.includes("media_publish"))).toHaveLength(1);
      expect(run.secondPublish).toMatch(/ceiling_reached/);
      expect(run.evidence.verification).toMatchObject({ attempted: false, code: "not_applicable" });
      expect(run.guard.counters.G4).toBe(0);
      expect(run.graph.some((g) => g === `GET /${MEDIA}`)).toBe(false);
      const g3 = run.events.filter((e) => e.rule === "G3").map((e) => e.event);
      expect(g3.slice(0, 2)).toEqual(["DISPATCH", mode === "publish_throws" ? "ERROR" : "RESPONSE"]);

      const rerun = await expectRefused(argv(pub), "prior_attempt_exists");
      expect(rerun.graph).toEqual([]);
      expect(await attemptsOf(pub)).toHaveLength(1);
    });

    it.each([
      ["timeout", "provider_verification_failed"],
      ["http_500", "provider_verification_failed"],
      ["malformed_json", "g4_invalid_response"],
      ["missing_id", "g4_invalid_response"],
      ["invalid_id", "g4_invalid_response"],
      ["mismatched_id", "g4_media_id_mismatch"],
      ["missing_permalink", "g4_missing_permalink"],
      ["unsafe_permalink", "g4_unsafe_permalink"],
      ["video", "g4_unsupported_media_type"],
    ] as const)("G4 failure after a durable publish (%s) → %s reported separately; publication/attempt stay published; no retry", async (g4, code) => {
      const pub = await publication();
      const run = await operate(argv(pub), { g4 });
      expect(run.exitCode).toBe(4); // published, not verified
      expect(run.evidence).toMatchObject({
        result: "published",
        mediaId: MEDIA,
        publicationStatus: "published",
        attemptStage: "published",
        providerCalls: { create: 1, publish: 1, verify: 1 },
        verification: { attempted: true, verified: false, code, mediaId: MEDIA, permalink: null, timestamp: null, mediaType: null },
      });
      expect(run.guard.counters).toMatchObject({ G1: 1, G3: 1, G4: 1 });
      expect(run.graph.filter((g) => g.includes("media_publish"))).toHaveLength(1);
      expect(run.graph.filter((g) => g === `GET /${MEDIA}`)).toHaveLength(1);
      expect(run.secondPublish).toMatch(/ceiling_reached/);
      expect(run.secondVerify).toMatch(/ceiling_reached/);
      const [attempt] = await attemptsOf(pub);
      expect(attempt).toMatchObject({ stage: "published", external_media_id: MEDIA });
      expect(await attemptsOf(pub)).toHaveLength(1);
      expect(await pubRow(pub)).toMatchObject({ status: "published", external_publication_id: MEDIA });
      expect(JSON.stringify(run.evidence)).not.toContain("LEAKY");
      expect(run.evidenceText).not.toContain("LEAKY");
    });

    it("pending_reconcile (2xx + media id, attempt 'published' write fails) → mediaId surfaced, G4 = 0", async () => {
      const pub = await publication();
      const run = await operate(argv(pub), { failPublishedWrite: true });
      expect(run.exitCode).toBe(1);
      expect(run.evidence).toMatchObject({
        result: "pending_reconcile",
        code: "attempt_published_persistence_failed",
        mediaId: MEDIA,
        attemptStage: "publish_requested",
        publicationStatus: "publishing",
        providerCalls: { publish: 1, verify: 0 },
        verification: { attempted: false, code: "not_applicable" },
      });
      expect(run.guard.counters).toMatchObject({ G3: 1, G4: 0 });
      expect(run.graph.some((g) => g === `GET /${MEDIA}`)).toBe(false);
      expect(run.secondPublish).toMatch(/ceiling_reached/);
      // The guard independently refuses G4 here: a media id was captured, but durable success was never signalled.
      expect(run.secondVerify).toMatch(/verification_not_armed/);
    });

    it("secret self-check: evidence that would contain the credential is replaced by SECRET_LEAK_DETECTED:<type>", async () => {
      const pub = await publication();
      // A pathological credential equal to a value that appears in the evidence (the publication id).
      const run = await operate(argv(pub), { credential: pub });
      expect(run.exitCode).toBe(3);
      expect(run.evidence).toMatchObject({ result: "secret_leak_detected", code: "SECRET_LEAK_DETECTED:instagram_token", publicationId: null, workspaceId: null });
      expect(JSON.stringify(run.evidence)).not.toContain(pub);
    });
  });

  describe("CLI main() under the pinned runner (guard installed by main; loopback-only mock preload)", () => {
    it("publishes once via the real wiring, writes guard evidence, leaks nothing; rerun refused", async () => {
      const pub = await publication();
      const evidenceDir = path.join(dir, "cli-evidence");
      const env = {
        NODE_ENV: "production" as const,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        MARQOS_OPERATOR_EVIDENCE_DIR: evidenceDir,
        MOCK_GRAPH_LOG: path.join(dir, "cli-mock.log"),
      };
      const run = (args: string[]) =>
        spawnSync("npx", ["--no-install", "tsx", "--conditions=react-server", "--import", "./tests/smoke/level4-mock-graph.mjs", "scripts/mvp-5.35-level5-publish.ts", ...args], {
          cwd: REPO,
          encoding: "utf8",
          timeout: 90_000,
          env,
        });

      const first = run(argv(pub));
      expect(first.status).toBe(0);
      const evidence = JSON.parse(first.stdout);
      expect(evidence).toMatchObject({
        result: "published",
        mediaId: MEDIA,
        publicationStatus: "published",
        providerCalls: { create: 1, publish: 1, verify: 1 },
        guard: { armed: true },
        verification: { attempted: true, verified: true, code: "verified", mediaId: MEDIA, permalink: "https://www.instagram.com/p/MOCKL5TEST/", mediaType: "IMAGE" },
      });
      expect(evidence.guard.counters).toMatchObject({ S2: 1, S3: 1, G1: 1, G3: 1, G4: 1, blocked: 0 });
      const mock = readFileSync(env.MOCK_GRAPH_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(mock.filter((e) => e.kind === "graph_media_publish")).toHaveLength(1);
      expect(mock.filter((e) => e.kind === "graph_media_read").map((e) => e.path)).toEqual([`/${MEDIA}`]);
      // publication durably published (PATCH) BEFORE the G4 read
      const order = mock.map((e) => (e.kind === "graph_media_read" ? "G4" : e.method === "PATCH" && e.path === "/rest/v1/publications" ? "PUB" : null)).filter(Boolean);
      expect(order).toEqual(["PUB", "G4"]);
      expect(mock.filter((e) => e.kind === "graph_unexpected" || e.kind === "blocked")).toEqual([]);
      const files = readdirSync(evidenceDir);
      expect(files).toHaveLength(1);
      const guardText = readFileSync(path.join(evidenceDir, files[0]), "utf8");
      expect(guardText).toContain('"event":"ARMED"');
      for (const text of [first.stdout, first.stderr, guardText]) {
        for (const secret of ["access_token", "token=", "/object/sign/assets/" + "x?", process.env.SUPABASE_SERVICE_ROLE_KEY!, FAKE_TOKEN]) expect(text).not.toContain(secret);
      }
      expect(await pubRow(pub)).toMatchObject({ status: "published", external_publication_id: MEDIA });

      const second = run(argv(pub));
      expect(second.status).toBe(2);
      expect(JSON.parse(second.stdout)).toMatchObject({ result: "refused", code: "publication_not_publishing" });
      const mockAfter = readFileSync(env.MOCK_GRAPH_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(mockAfter.filter((e) => e.kind === "graph_media_publish")).toHaveLength(1);
      expect(mockAfter.filter((e) => e.kind === "graph_media_read")).toHaveLength(1);
      expect(mockAfter.filter((e) => e.kind !== "local")).toHaveLength(mock.filter((e) => e.kind !== "local").length); // rerun: no Graph request at all
    }, 180_000);
  });
});
