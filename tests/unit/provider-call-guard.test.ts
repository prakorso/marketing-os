import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installProviderCallGuard, type ProviderCallGuard } from "../../scripts/lib/provider-call-guard";

/**
 * MVP-5.35C-I — operator provider-call guard. A fake base fetch sits BELOW
 * the guard; nothing leaves the process. Fake identifiers/secrets only.
 */

const SUPA = "http://127.0.0.1:54321";
const IG = "17849990000000042";
const CONTAINER = "17900000000000000123";
const MEDIA = "18000000000000000999";
const OBJECT = "assets/ws-1/asset-1.jpg";
const FAKE_TOKEN = "IGAAfakeGuardToken0000000000000001";
const SIGNED = "http://127.0.0.1:54321/storage/v1/object/sign/assets/ws-1/asset-1.jpg?token=FAKESIGNEDTOKEN123";

type Behavior = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const happy: Behavior = (url) => {
  if (url.pathname === `/${IG}/media`) return json(200, { id: CONTAINER });
  if (url.pathname === `/${CONTAINER}`) return json(200, { status_code: "FINISHED", id: CONTAINER });
  if (url.pathname === `/${IG}/media_publish`) return json(200, { id: MEDIA });
  if (url.pathname === `/${MEDIA}`) return json(200, { id: MEDIA, permalink: "https://www.instagram.com/p/FAKE/" });
  return json(200, []);
};

describe("provider-call guard (operator-only)", () => {
  let dir: string;
  let evidencePath: string;
  let guard: ProviderCallGuard | null = null;
  let dispatched: string[];
  let behavior: Behavior;
  const originalFetch = globalThis.fetch;

  const install = (opts: { allowMediaRead?: boolean; statusReadCeiling?: number } = {}) => {
    guard = installProviderCallGuard({
      supabaseUrl: SUPA,
      evidencePath,
      statusReadCeiling: opts.statusReadCeiling ?? 3,
      allowMediaRead: opts.allowMediaRead,
      baseFetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        dispatched.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return behavior(url, init);
      }) as typeof fetch,
    });
    return guard;
  };
  const lines = () => readFileSync(evidencePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const post = (pathname: string, body?: URLSearchParams) => fetch(`https://graph.instagram.com${pathname}`, { method: "POST", body });
  const createForm = () => new URLSearchParams({ image_url: SIGNED, access_token: FAKE_TOKEN });
  const publishForm = (creation = CONTAINER) => new URLSearchParams({ creation_id: creation, access_token: FAKE_TOKEN });
  const status = (id = CONTAINER) => fetch(`https://graph.instagram.com/${id}?fields=status_code&access_token=${FAKE_TOKEN}`);

  async function toReadyAndArmed(g: ProviderCallGuard) {
    g.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    await post(`/${IG}/media`, createForm());
    await status();
    g.arm();
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "guard-"));
    evidencePath = path.join(dir, "evidence.jsonl");
    dispatched = [];
    behavior = happy;
  });
  afterEach(() => {
    guard?.uninstall();
    guard = null;
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it("default deny: unknown host, unknown RPC, non-REST supabase path — blocked before dispatch", async () => {
    const g = install();
    g.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    await expect(fetch("https://example.com/")).rejects.toThrow(/host_not_allowed/);
    await expect(fetch(`${SUPA}/rest/v1/rpc/other_rpc`, { method: "POST" })).rejects.toThrow(/rpc_not_allowed/);
    await expect(fetch(`${SUPA}/auth/v1/admin/users`)).rejects.toThrow(/supabase_path_not_allowed/);
    await expect(fetch(`${SUPA}/storage/v1/object/assets/ws-1/asset-1.jpg`, { method: "DELETE" })).rejects.toThrow(/supabase_path_not_allowed/);
    expect(dispatched).toEqual([]);
    expect(g.counters().blocked).toBe(4);
  });

  it("before target authorization only table REST is allowed (no Vault, no signing, no Graph)", async () => {
    install();
    await expect(fetch(`${SUPA}/rest/v1/publications?id=eq.x`)).resolves.toBeInstanceOf(Response);
    await expect(fetch(`${SUPA}/rest/v1/rpc/read_social_account_vault_secret`, { method: "POST" })).rejects.toThrow(/target_not_authorized/);
    await expect(fetch(`${SUPA}/storage/v1/object/sign/${OBJECT}`, { method: "POST" })).rejects.toThrow(/target_not_authorized/);
    await expect(post(`/${IG}/media`, createForm())).rejects.toThrow(/ig_account_not_authorized/);
    expect(dispatched).toEqual(["GET /rest/v1/publications"]);
  });

  it("Vault RPC ≤ 1; signing only the exact authorized object, ≤ ceiling", async () => {
    const g = install();
    g.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    await fetch(`${SUPA}/rest/v1/rpc/read_social_account_vault_secret`, { method: "POST" });
    await expect(fetch(`${SUPA}/rest/v1/rpc/read_social_account_vault_secret`, { method: "POST" })).rejects.toThrow(/ceiling_reached/);
    await expect(fetch(`${SUPA}/storage/v1/object/sign/assets/ws-1/other.jpg`, { method: "POST" })).rejects.toThrow(/sign_object_not_authorized/);
    for (let i = 0; i < 3; i += 1) await fetch(`${SUPA}/storage/v1/object/sign/${OBJECT}`, { method: "POST" });
    await expect(fetch(`${SUPA}/storage/v1/object/sign/${OBJECT}`, { method: "POST" })).rejects.toThrow(/ceiling_reached/);
    expect(g.counters()).toMatchObject({ S2: 1, S3: 3 });
  });

  it("G1: second POST /media blocked; wrong IG_ID blocked; container id captured losslessly", async () => {
    const g = install();
    g.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    await expect(post(`/17849990000000099/media`, createForm())).rejects.toThrow(/ig_account_not_authorized/);
    const res = await post(`/${IG}/media`, createForm());
    expect(await res.json()).toEqual({ id: CONTAINER }); // response still readable by the caller
    expect(g.captured().containerId).toBe(CONTAINER);
    await expect(post(`/${IG}/media`, createForm())).rejects.toThrow(/ceiling_reached/);
    expect(dispatched.filter((d) => d.endsWith("/media"))).toHaveLength(1);
  });

  it("G2: only the captured container, only fields=status_code, bounded", async () => {
    const g = install({ statusReadCeiling: 2 });
    g.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    await expect(status()).rejects.toThrow(/graph_id_not_authorized/); // before capture
    await post(`/${IG}/media`, createForm());
    await expect(status("17900000000000000999")).rejects.toThrow(/graph_id_not_authorized/);
    await expect(fetch(`https://graph.instagram.com/${CONTAINER}?fields=id,caption`)).rejects.toThrow(/graph_id_not_authorized/);
    await status();
    await status();
    await expect(status()).rejects.toThrow(/ceiling_reached/);
    expect(g.captured()).toMatchObject({ statusCodes: ["FINISHED", "FINISHED"], finished: true });
  });

  it("G3 preconditions: before FINISHED, while unarmed, creation_id mismatch, wrong IG_ID — all blocked before dispatch", async () => {
    const g = install();
    g.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    await post(`/${IG}/media`, createForm());
    await expect(post(`/${IG}/media_publish`, publishForm())).rejects.toThrow(/container_not_finished/);
    await status();
    await expect(post(`/${IG}/media_publish`, publishForm())).rejects.toThrow(/not_armed/);
    g.arm();
    await expect(post(`/${IG}/media_publish`, publishForm("17900000000000000124"))).rejects.toThrow(/creation_id_mismatch/);
    await expect(post(`/17849990000000099/media_publish`, publishForm())).rejects.toThrow(/media_publish_target_not_authorized/);
    expect(dispatched.some((d) => d.includes("media_publish"))).toBe(false);
    expect(g.counters().G3).toBe(0);
  });

  it("G3: exactly one media_publish; the second is blocked; media id captured; caller can read the body", async () => {
    const g = install();
    await toReadyAndArmed(g);
    const res = await post(`/${IG}/media_publish`, publishForm());
    expect(await res.json()).toEqual({ id: MEDIA });
    expect(g.captured().mediaId).toBe(MEDIA);
    await expect(post(`/${IG}/media_publish`, publishForm())).rejects.toThrow(/ceiling_reached/);
    expect(dispatched.filter((d) => d.includes("media_publish"))).toHaveLength(1);
  });

  it("an ambiguous (throwing) media_publish consumes the ceiling permanently; DISPATCH precedes the request, ERROR follows", async () => {
    const g = install();
    await toReadyAndArmed(g);
    behavior = (url) => {
      if (url.pathname.endsWith("/media_publish")) {
        const events = lines().map((line) => `${line.rule}:${line.event}`);
        expect(events).toContain("G3:DISPATCH"); // durable BEFORE the request leaves
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      }
      return happy(url);
    };
    await expect(post(`/${IG}/media_publish`, publishForm())).rejects.toThrow("timeout");
    expect(g.counters().G3).toBe(1);
    await expect(post(`/${IG}/media_publish`, publishForm())).rejects.toThrow(/ceiling_reached/);
    const g3 = lines().filter((line) => line.rule === "G3");
    expect(g3.map((line) => line.event)).toEqual(["DISPATCH", "ERROR", "BLOCKED"]);
    expect(g3[1].error).toBe("TimeoutError");
    expect(g.captured().mediaId).toBeNull();
  });

  it("malformed / non-digit / 5xx ids are never captured", async () => {
    const g = install();
    g.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    behavior = () => json(200, { id: "17900000000000000123abc" });
    await post(`/${IG}/media`, createForm());
    expect(g.captured().containerId).toBeNull();

    const g2Dir = mkdtempSync(path.join(tmpdir(), "guard-"));
    g.uninstall();
    guard = installProviderCallGuard({ supabaseUrl: SUPA, evidencePath: path.join(g2Dir, "e.jsonl"), baseFetch: (async () => json(500, { id: CONTAINER })) as typeof fetch });
    guard.authorizeTarget({ igAccountId: IG, signObjectPath: OBJECT });
    await post(`/${IG}/media`, createForm());
    expect(guard.captured().containerId).toBeNull();
    rmSync(g2Dir, { recursive: true, force: true });
  });

  it("G4 is disabled by default; when explicitly allowed only the captured media id with safe fields, once", async () => {
    let g = install();
    await toReadyAndArmed(g);
    await post(`/${IG}/media_publish`, publishForm());
    await expect(fetch(`https://graph.instagram.com/${MEDIA}?fields=id,permalink`)).rejects.toThrow(/graph_id_not_authorized/);
    g.uninstall();

    g = install({ allowMediaRead: true });
    await toReadyAndArmed(g);
    await post(`/${IG}/media_publish`, publishForm());
    await expect(fetch(`https://graph.instagram.com/${MEDIA}?fields=id,permalink`)).rejects.toThrow(/verification_not_armed/);
    g.armVerification();
    await expect(fetch(`https://graph.instagram.com/${MEDIA}?fields=id,permalink,insights`)).rejects.toThrow(/graph_id_not_authorized/);
    await fetch(`https://graph.instagram.com/${MEDIA}?fields=id,permalink,timestamp`);
    await expect(fetch(`https://graph.instagram.com/${MEDIA}?fields=id`)).rejects.toThrow(/ceiling_reached/);
  });

  it("G4 (allowMediaRead): blocked before any G3 capture, for a wrong media id, after a failed/ambiguous G3; response stays readable", async () => {
    let g = install({ allowMediaRead: true });
    await toReadyAndArmed(g);
    await expect(fetch(`https://graph.instagram.com/${MEDIA}?fields=id,permalink`)).rejects.toThrow(/graph_id_not_authorized/); // no G3 yet
    await post(`/${IG}/media_publish`, publishForm());
    await expect(fetch(`https://graph.instagram.com/18000000000000000998?fields=id,permalink`)).rejects.toThrow(/graph_id_not_authorized/);
    await expect(fetch(`https://graph.instagram.com/${MEDIA}?fields=id,permalink`)).rejects.toThrow(/verification_not_armed/); // durable success not signalled
    g.armVerification();
    const res = await fetch(`https://graph.instagram.com/${MEDIA}?fields=id,permalink,timestamp,media_type&access_token=${FAKE_TOKEN}`);
    expect(await res.json()).toMatchObject({ id: MEDIA });
    expect(g.counters().G4).toBe(1);
    expect(readFileSync(evidencePath, "utf8")).not.toContain(FAKE_TOKEN);
    g.uninstall();

    // An ambiguous G3 (throws) captures no media id → G4 can never target anything.
    g = install({ allowMediaRead: true });
    behavior = (url) => {
      if (url.pathname.endsWith("/media_publish")) throw Object.assign(new Error("reset"), { name: "TypeError" });
      return happy(url);
    };
    await toReadyAndArmed(g);
    await expect(post(`/${IG}/media_publish`, publishForm())).rejects.toThrow("reset");
    await expect(fetch(`https://graph.instagram.com/${MEDIA}?fields=id`)).rejects.toThrow(/graph_id_not_authorized/);
    expect(() => g.armVerification()).toThrow(/captured media id/);
    expect(g.counters().G4).toBe(0);
  });

  it("evidence never contains query strings, bodies, headers, the token or the signed URL", async () => {
    const g = install();
    await toReadyAndArmed(g);
    await fetch(`${SUPA}/storage/v1/object/sign/${OBJECT}?download=1`, { method: "POST", headers: { authorization: "Bearer FAKEBEARER" } });
    await post(`/${IG}/media_publish`, publishForm());
    const text = readFileSync(evidencePath, "utf8");
    for (const forbidden of [FAKE_TOKEN, "access_token", "token=", "FAKESIGNEDTOKEN123", "FAKEBEARER", "image_url", "creation_id", "?"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("secret self-check reports only the TYPE of a registered secret that leaked", () => {
    const g = install();
    g.registerSecret("instagram_token", FAKE_TOKEN);
    g.registerSecret("signed_url", SIGNED);
    expect(g.findSecretLeaks(["clean output"])).toEqual([]);
    const leaks = g.findSecretLeaks([`oops ${FAKE_TOKEN}`]);
    expect(leaks).toEqual(["instagram_token"]);
    expect(JSON.stringify(leaks)).not.toContain(FAKE_TOKEN);
  });

  it("uninstall restores the previous fetch", () => {
    const before = globalThis.fetch;
    const g = install();
    expect(globalThis.fetch).not.toBe(before);
    g.uninstall();
    guard = null;
    expect(globalThis.fetch).toBe(before);
  });
});
