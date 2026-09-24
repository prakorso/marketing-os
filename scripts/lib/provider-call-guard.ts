import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

/**
 * MVP-5.35C-I — OPERATOR-ONLY provider call guard (defense in depth for the
 * Level 5 one-off CLI). NEVER imported by src/, the scheduler or Netlify.
 *
 * Threat model: the operator PROCESS doing more than authorized — a
 * business-logic regression (second create, retry, publish without a
 * checkpoint), a wrong target, stray hosts, or secrets leaking into
 * evidence. It is not a boundary against a malicious operator.
 *
 * Model: wraps globalThis.fetch (install BEFORE any client is created —
 * supabase-js captures fetch at client creation). DEFAULT DENY: a request
 * matching no rule is blocked BEFORE dispatch (TypeError; nothing sent).
 *
 *   S1 supabase /rest/v1/<table>                          unbounded
 *   S2 POST /rest/v1/rpc/read_social_account_vault_secret ≤ 1   (target authorized)
 *   S3 POST /storage/v1/object/sign/<exact bucket/path>   ≤ 3   (target authorized)
 *   G1 POST graph /<IG_ID>/media                          ≤ 1   (target authorized)
 *   G2 GET  graph /<captured container>?fields=status_code ≤ N  (container captured)
 *   G3 POST graph /<IG_ID>/media_publish                  ≤ 1   (captured container, FINISHED
 *        observed, creation_id === captured container, ARMED)
 *   G4 GET  graph /<captured media id>?fields=…           ≤ 1   (only if allowMediaRead AND
 *        verification-armed — the operator arms it only after the publication
 *        is durably published; MVP-5.35C-J.1)
 *
 * Counters increment at DISPATCH and never decrement: an ambiguous request
 * consumes its ceiling. The guard never retries. Evidence is append-only
 * JSONL, fsync'd per line; G1/G3 write DISPATCH before the request leaves,
 * so "DISPATCH without RESPONSE" identifies an ambiguous irreversible call
 * after a crash. Only safe fields are written — never query strings,
 * headers, bodies, tokens or signed URLs.
 */

export const GUARD_RULES = ["S1", "S2", "S3", "G1", "G2", "G3", "G4"] as const;
export type GuardRule = (typeof GUARD_RULES)[number];

export type GuardCounters = Record<GuardRule, number> & { blocked: number };

export type GuardCaptured = {
  containerId: string | null;
  statusCodes: string[];
  finished: boolean;
  mediaId: string | null;
};

export type GuardTarget = {
  /** Authorized Instagram professional account id (digits). */
  igAccountId: string;
  /** Exact storage object that may be signed: "<bucket>/<path>". */
  signObjectPath: string;
};

export type ProviderCallGuardOptions = {
  supabaseUrl: string;
  evidencePath: string;
  /** G2 ceiling; derive from the execution budget (poll budget / interval + 1). */
  statusReadCeiling?: number;
  signCeiling?: number;
  /** G4 (safe read of the captured media id). Disabled unless explicitly authorized. */
  allowMediaRead?: boolean;
  /** Underlying fetch (tests inject a fake; defaults to the current globalThis.fetch). */
  baseFetch?: typeof fetch;
  now?: () => Date;
};

export interface ProviderCallGuard {
  /** Once only, after the target guards passed. Until then only S1 is allowed. */
  authorizeTarget(target: GuardTarget): void;
  /** Called by the operator ONLY after the publish_requested checkpoint resolved. */
  arm(): void;
  /** G4 precondition: called by the operator ONLY after the publication is durably published with the G3 media id. */
  armVerification(): void;
  readonly armed: boolean;
  counters(): GuardCounters;
  captured(): GuardCaptured;
  registerSecret(type: string, value: string): void;
  /** Types of registered secrets found in the evidence file or the given texts. Never returns values. */
  findSecretLeaks(texts?: readonly string[]): string[];
  readonly evidencePath: string;
  uninstall(): void;
}

const GRAPH_HOST = "graph.instagram.com";
const VAULT_RPC_PATH = "/rest/v1/rpc/read_social_account_vault_secret";
const DIGITS = /^[0-9]+$/;
const G4_FIELDS = new Set(["id", "permalink", "timestamp", "media_type"]);

type Decision = { allow: true; rule: GuardRule } | { allow: false; rule: GuardRule | "none"; reason: string };

function requestParts(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  return { url: new URL(href), method };
}

function formField(body: RequestInit["body"] | undefined, field: string): string | null {
  if (body instanceof URLSearchParams) return body.get(field);
  if (typeof body === "string") return new URLSearchParams(body).get(field);
  return null;
}

export function installProviderCallGuard(options: ProviderCallGuardOptions): ProviderCallGuard {
  const supabaseHost = new URL(options.supabaseUrl).host;
  const statusCeiling = options.statusReadCeiling ?? 9;
  const signCeiling = options.signCeiling ?? 3;
  const now = options.now ?? (() => new Date());
  const previousFetch = globalThis.fetch;
  const baseFetch = (options.baseFetch ?? previousFetch).bind(globalThis);
  const fd = openSync(options.evidencePath, "a");

  const counters: GuardCounters = { S1: 0, S2: 0, S3: 0, G1: 0, G2: 0, G3: 0, G4: 0, blocked: 0 };
  const captured: GuardCaptured = { containerId: null, statusCodes: [], finished: false, mediaId: null };
  const secrets = new Map<string, Set<string>>();
  let target: GuardTarget | null = null;
  let armed = false;
  let verificationArmed = false;

  const record = (entry: Record<string, unknown>) => {
    writeSync(fd, `${JSON.stringify({ t: now().toISOString(), ...entry })}\n`);
    fsyncSync(fd);
  };
  const ceilings: Record<GuardRule, number> = {
    S1: Number.POSITIVE_INFINITY,
    S2: 1,
    S3: signCeiling,
    G1: 1,
    G2: statusCeiling,
    G3: 1,
    G4: options.allowMediaRead ? 1 : 0,
  };

  function decide(url: URL, method: string, init?: RequestInit): Decision {
    const path = url.pathname;
    if (url.host === supabaseHost) {
      if (path.startsWith("/rest/v1/rpc/")) {
        if (method !== "POST" || path !== VAULT_RPC_PATH) return { allow: false, rule: "S2", reason: "rpc_not_allowed" };
        if (!target) return { allow: false, rule: "S2", reason: "target_not_authorized" };
        return { allow: true, rule: "S2" };
      }
      if (path.startsWith("/rest/v1/")) return { allow: true, rule: "S1" };
      if (path.startsWith("/storage/v1/object/sign/")) {
        if (!target) return { allow: false, rule: "S3", reason: "target_not_authorized" };
        const object = decodeURIComponent(path.slice("/storage/v1/object/sign/".length));
        if (method !== "POST" || object !== target.signObjectPath) return { allow: false, rule: "S3", reason: "sign_object_not_authorized" };
        return { allow: true, rule: "S3" };
      }
      return { allow: false, rule: "none", reason: "supabase_path_not_allowed" };
    }
    if (url.hostname === GRAPH_HOST) {
      if (path.includes("media_publish")) {
        if (method !== "POST" || !target || path !== `/${target.igAccountId}/media_publish`) {
          return { allow: false, rule: "G3", reason: "media_publish_target_not_authorized" };
        }
        if (!captured.containerId) return { allow: false, rule: "G3", reason: "no_captured_container" };
        if (!captured.finished) return { allow: false, rule: "G3", reason: "container_not_finished" };
        if (!armed) return { allow: false, rule: "G3", reason: "not_armed" };
        if (formField(init?.body, "creation_id") !== captured.containerId) return { allow: false, rule: "G3", reason: "creation_id_mismatch" };
        return { allow: true, rule: "G3" };
      }
      if (method === "POST" && /^\/[0-9]+\/media$/.test(path)) {
        if (!target || path !== `/${target.igAccountId}/media`) return { allow: false, rule: "G1", reason: "ig_account_not_authorized" };
        return { allow: true, rule: "G1" };
      }
      if (method === "GET" && /^\/[0-9]+$/.test(path)) {
        const id = path.slice(1);
        if (captured.containerId && id === captured.containerId && url.searchParams.get("fields") === "status_code") return { allow: true, rule: "G2" };
        if (options.allowMediaRead && captured.mediaId && id === captured.mediaId) {
          if (!verificationArmed) return { allow: false, rule: "G4", reason: "verification_not_armed" };
          const fields = (url.searchParams.get("fields") ?? "").split(",");
          if (fields.length > 0 && fields.every((field) => G4_FIELDS.has(field))) return { allow: true, rule: "G4" };
        }
        return { allow: false, rule: "none", reason: "graph_id_not_authorized" };
      }
      return { allow: false, rule: "none", reason: "graph_request_not_allowed" };
    }
    return { allow: false, rule: "none", reason: "host_not_allowed" };
  }

  async function capture(rule: GuardRule, res: Response): Promise<Record<string, unknown>> {
    if (rule !== "G1" && rule !== "G2" && rule !== "G3") return {};
    let body: unknown = null;
    try {
      body = JSON.parse(await res.clone().text());
    } catch {
      return { parsed: false };
    }
    const record = (body ?? {}) as Record<string, unknown>;
    if (rule === "G2") {
      const code = typeof record.status_code === "string" ? record.status_code : null;
      if (code && /^[A-Z_]+$/.test(code)) {
        captured.statusCodes.push(code);
        if (res.ok && code === "FINISHED") captured.finished = true;
      }
      return { status_code: code };
    }
    const id = typeof record.id === "string" && DIGITS.test(record.id) ? record.id : null;
    if (res.ok && id) {
      if (rule === "G1") captured.containerId = id;
      else captured.mediaId = id;
    }
    return { capturedId: res.ok ? id : null };
  }

  const guardedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { url, method } = requestParts(input, init);
    const safe = { host: url.host === supabaseHost ? "<supabase>" : url.hostname, method, path: url.pathname };
    const decision = decide(url, method, init);
    if (decision.allow && counters[decision.rule] >= ceilings[decision.rule]) {
      counters.blocked += 1;
      record({ ...safe, rule: decision.rule, event: "BLOCKED", reason: "ceiling_reached" });
      throw new TypeError(`provider-call-guard: blocked (${decision.rule} ceiling_reached)`);
    }
    if (!decision.allow) {
      counters.blocked += 1;
      record({ ...safe, rule: decision.rule, event: "BLOCKED", reason: decision.reason });
      throw new TypeError(`provider-call-guard: blocked (${decision.reason})`);
    }
    const rule = decision.rule;
    counters[rule] += 1; // at dispatch — never decremented
    if (rule === "G1" || rule === "G3") record({ ...safe, rule, event: "DISPATCH", n: counters[rule] });
    let res: Response;
    try {
      res = await baseFetch(input, init);
    } catch (err) {
      record({ ...safe, rule, event: "ERROR", error: err instanceof Error ? err.name : "error" });
      throw err;
    }
    record({ ...safe, rule, event: "RESPONSE", status: res.status, ...(await capture(rule, res)) });
    return res;
  }) as typeof fetch;

  globalThis.fetch = guardedFetch;
  record({ event: "INSTALLED", supabase: "<supabase>", statusCeiling, signCeiling, mediaRead: Boolean(options.allowMediaRead) });

  return {
    authorizeTarget(next) {
      if (target) throw new Error("provider-call-guard: target already authorized");
      if (!DIGITS.test(next.igAccountId) || next.signObjectPath.includes("..") || next.signObjectPath === "") {
        throw new Error("provider-call-guard: invalid target");
      }
      target = { ...next };
      record({ event: "TARGET_AUTHORIZED", igAccountId: next.igAccountId, signObject: next.signObjectPath });
    },
    arm() {
      if (!target) throw new Error("provider-call-guard: cannot arm before the target is authorized");
      armed = true;
      record({ event: "ARMED" });
    },
    armVerification() {
      if (!options.allowMediaRead || !captured.mediaId) throw new Error("provider-call-guard: verification requires allowMediaRead and a captured media id");
      verificationArmed = true;
      record({ event: "VERIFICATION_ARMED", mediaId: captured.mediaId });
    },
    get armed() {
      return armed;
    },
    counters: () => ({ ...counters }),
    captured: () => ({ ...captured, statusCodes: [...captured.statusCodes] }),
    registerSecret(type, value) {
      if (!value) return;
      if (!secrets.has(type)) secrets.set(type, new Set());
      secrets.get(type)!.add(value);
    },
    findSecretLeaks(texts = []) {
      const corpus = [readFileSync(options.evidencePath, "utf8"), ...texts];
      const leaks: string[] = [];
      for (const [type, values] of secrets) {
        if ([...values].some((value) => corpus.some((text) => text.includes(value)))) leaks.push(type);
      }
      return leaks;
    },
    evidencePath: options.evidencePath,
    uninstall() {
      if (globalThis.fetch === guardedFetch) globalThis.fetch = previousFetch;
      record({ event: "UNINSTALLED", counters });
      closeSync(fd);
    },
  };
}
