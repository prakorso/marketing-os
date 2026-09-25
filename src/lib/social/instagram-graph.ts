import type {
  MediaContainerCreateResult,
  MediaContainerStatus,
  MediaContainerStatusResult,
  MediaPublishResult,
  ProviderFailureDetails,
  RecentMediaResult,
} from "./provider";

/**
 * MVP-5.36 — Instagram Graph publishing calls and the pure helpers they
 * share, split out of instagram-adapter.ts WITHOUT `server-only`.
 *
 * Why no `server-only` here: the Level-6 scheduled function is bundled by
 * the Netlify function bundler with default resolution conditions, where
 * `server-only` throws at module load (MVP-5.36A §4). Everything in this
 * module is pure: no environment variable, no Vault, no database, no
 * secret — the credential is always a caller-supplied parameter and never
 * returned, logged or embedded in a result. Secret-bearing code (OAuth
 * client secret, service role) stays in `server-only` modules.
 */

export const GRAPH_BASE_URL = "https://graph.instagram.com";

type JsonRecord = Record<string, unknown>;

/**
 * Blanket redaction net (MVP-5.17): replaces any `access_token=<value>`
 * occurrence inside a string, at any depth of a JSON-like structure —
 * covers `paging.next` and any other URL a provider response might embed
 * a live token in, not only fields this adapter knows about by name.
 */
export function redactInstagramAccessTokens<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/([?&]access_token=)[^&]+/g, "$1[REDACTED]") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactInstagramAccessTokens(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: JsonRecord = {};
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      out[key] = redactInstagramAccessTokens(entry);
    }
    return out as T;
  }
  return value;
}

/**
 * MVP-5.35B.1: provider-native identifiers are opaque strings and must be
 * preserved losslessly. Instagram's token exchange returns `user_id` as a
 * raw JSON number (MVP-5.17 evidence) that can exceed
 * Number.MAX_SAFE_INTEGER, so `res.json()` rounds it before any String()
 * conversion can happen. This parses the body with a reviver that reads
 * the ORIGINAL source text of `user_id` (ES2024 JSON.parse source text
 * access; Node >= 21 — Netlify functions run nodejs24.x), never a JS
 * number. A value that cannot be recovered exactly (no source access on an
 * unsafe integer, or a non-integer literal such as `3.8e16`) becomes
 * UNRECOVERABLE_IDENTIFIER and is rejected by the caller instead of being
 * persisted rounded.
 */
// `id`/`user_id` are provider-native identifiers (token exchange: user_id;
// GET /me: id = app-scoped id, user_id = professional account <IG_ID>).
const LOSSLESS_ID_KEYS = new Set(["user_id", "id"]);
export const UNRECOVERABLE_IDENTIFIER = Symbol("unrecoverable-identifier");

export function parseJsonPreservingIdentifiers(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (!LOSSLESS_ID_KEYS.has(key) || typeof value !== "number") {
      return value;
    }
    const source = context?.source;
    if (typeof source === "string") {
      return /^\d+$/.test(source) ? source : UNRECOVERABLE_IDENTIFIER;
    }
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : UNRECOVERABLE_IDENTIFIER;
  });
}

export async function readJsonPreservingIdentifiers(res: Response): Promise<unknown> {
  try {
    return parseJsonPreservingIdentifiers(await res.text());
  } catch {
    return null;
  }
}

// =============================================================================
// MVP-5.35C-B — staged IMAGE publishing (container → status → media_publish)
//
// Every function returns a CLASSIFIED result; none throws for provider
// outcomes and none retries. The access token travels only in the POST
// body / query string of the request itself and never appears in a result,
// error, or log. Container and media ids are parsed losslessly (the `id`
// key goes through the MVP-5.35B.1 reviver) and returned as strings.
// =============================================================================

// MVP-5.35C-D: ≤ 10 s per request (fits the 45 s application budget inside the 60 s platform limit).
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const CONTAINER_STATUS_VALUES: readonly MediaContainerStatus[] = ["FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED", "PUBLISHED"];

function failureDetails(code: string, message: string, httpStatus: number | null, body: unknown): ProviderFailureDetails {
  const safe = (redactInstagramAccessTokens(body) ?? {}) as JsonRecord;
  const nested = safe.error && typeof safe.error === "object" ? (safe.error as JsonRecord) : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    code: nested && typeof nested.type === "string" ? nested.type : code,
    message: nested && typeof nested.message === "string" ? nested.message : message,
    httpStatus,
    providerCode: num(nested?.code),
    providerSubcode: num(nested?.error_subcode),
    fbtraceId: nested && typeof nested.fbtrace_id === "string" ? nested.fbtrace_id : null,
  };
}

/** A structured Graph error envelope ({ error: { type|code, message } }) — the only authoritative rejection shape. */
function isStructuredGraphRejection(body: unknown): boolean {
  const err = (body as JsonRecord | null)?.error as JsonRecord | undefined;
  return !!err && typeof err === "object" && (typeof err.type === "string" || typeof err.code === "number") && typeof err.message === "string";
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function createInstagramMediaContainer(params: {
  credential: string;
  accountId: string;
  imageUrl: string;
  caption: string | null;
  timeoutMs?: number;
}): Promise<MediaContainerCreateResult> {
  const form = new URLSearchParams({ image_url: params.imageUrl, access_token: params.credential });
  if (params.caption) form.set("caption", params.caption);

  let res: Response;
  try {
    res = await timedFetch(
      `${GRAPH_BASE_URL}/${encodeURIComponent(params.accountId)}/media`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form },
      params.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, outcome: "unknown", ...failureDetails("transport_error", "Container creation request did not complete", null, null) };
  }
  const body = await readJsonPreservingIdentifiers(res);
  if (!res.ok) {
    // MVP-5.36H2: only a 4xx with the structured Graph error envelope proves nothing was created.
    const outcome = res.status >= 400 && res.status < 500 && isStructuredGraphRejection(body) ? "rejected" : "unknown";
    return { ok: false, outcome, ...failureDetails("container_create_failed", "Container creation was rejected", res.status, body) };
  }
  const id = (body as JsonRecord | null)?.id;
  if (typeof id !== "string" || id === "") {
    return { ok: false, outcome: "unknown", ...failureDetails("malformed_response", "Container creation returned no container id", res.status, null) };
  }
  return { ok: true, containerId: id };
}

export async function getInstagramMediaContainerStatus(params: {
  credential: string;
  containerId: string;
  timeoutMs?: number;
}): Promise<MediaContainerStatusResult> {
  const url = new URL(`${GRAPH_BASE_URL}/${encodeURIComponent(params.containerId)}`);
  url.searchParams.set("fields", "status_code");
  url.searchParams.set("access_token", params.credential);

  let res: Response;
  try {
    res = await timedFetch(url.toString(), { method: "GET" }, params.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
  } catch {
    return { ok: false, ...failureDetails("transport_error", "Container status request did not complete", null, null) };
  }
  const body = await readJsonPreservingIdentifiers(res);
  if (!res.ok) {
    return { ok: false, ...failureDetails("container_status_failed", "Container status request was rejected", res.status, body) };
  }
  const raw = (body as JsonRecord | null)?.status_code;
  const status = CONTAINER_STATUS_VALUES.find((value) => value === raw) ?? "UNKNOWN_VALUE";
  return { ok: true, status };
}

/**
 * THE IRREVERSIBLE STEP. Locked decision D4: once this request has been
 * invoked, only a 2xx with a media id (published) or an authoritative
 * structured Graph rejection (rejected) is conclusive. Every other result —
 * any transport exception (including ENOTFOUND/ECONNREFUSED), timeout,
 * 5xx, or malformed body — is `unknown`. Never retried here.
 */
export async function publishInstagramMediaContainer(params: {
  credential: string;
  accountId: string;
  containerId: string;
  timeoutMs?: number;
}): Promise<MediaPublishResult> {
  const form = new URLSearchParams({ creation_id: params.containerId, access_token: params.credential });

  let res: Response;
  try {
    res = await timedFetch(
      `${GRAPH_BASE_URL}/${encodeURIComponent(params.accountId)}/media_publish`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form },
      params.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, outcome: "unknown", ...failureDetails("transport_error", "Publish request did not complete", null, null) };
  }
  const body = await readJsonPreservingIdentifiers(res);

  if (res.ok) {
    const id = (body as JsonRecord | null)?.id;
    if (typeof id === "string" && id !== "") {
      return { ok: true, mediaId: id };
    }
    return { ok: false, outcome: "unknown", ...failureDetails("malformed_response", "Publish succeeded without a parseable media id", res.status, null) };
  }
  if (res.status >= 400 && res.status < 500 && isStructuredGraphRejection(body)) {
    return { ok: false, outcome: "rejected", ...failureDetails("publish_rejected", "Publish was rejected", res.status, body) };
  }
  return { ok: false, outcome: "unknown", ...failureDetails("publish_outcome_unknown", "Publish outcome could not be determined", res.status, body) };
}

/** Read-only recent media (reconciliation evidence only; heuristic). */
export async function listInstagramRecentMedia(params: {
  credential: string;
  accountId: string;
  timeoutMs?: number;
}): Promise<RecentMediaResult> {
  const url = new URL(`${GRAPH_BASE_URL}/${encodeURIComponent(params.accountId)}/media`);
  url.searchParams.set("fields", "id,caption,timestamp");
  url.searchParams.set("limit", "25");
  url.searchParams.set("access_token", params.credential);

  let res: Response;
  try {
    res = await timedFetch(url.toString(), { method: "GET" }, params.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
  } catch {
    return { ok: false, ...failureDetails("transport_error", "Recent media request did not complete", null, null) };
  }
  const body = await readJsonPreservingIdentifiers(res);
  if (!res.ok) {
    return { ok: false, ...failureDetails("recent_media_failed", "Recent media request was rejected", res.status, body) };
  }
  const data = (body as JsonRecord | null)?.data;
  const items = (Array.isArray(data) ? data : [])
    .map((entry) => entry as JsonRecord)
    .filter((entry) => typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id as string,
      caption: typeof entry.caption === "string" ? entry.caption : null,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
    }));
  return { ok: true, items };
}
