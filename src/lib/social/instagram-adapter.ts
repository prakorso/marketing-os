import "server-only";

import {
  ProviderError,
  type MediaContainerCreateResult,
  type MediaContainerStatus,
  type MediaContainerStatusResult,
  type MediaPublishResult,
  type ProviderFailureDetails,
  type ProviderMetricsInput,
  type ProviderPublishInput,
  type ProviderPublishResult,
  type RecentMediaResult,
  type SocialProviderAdapter,
  type StagedMediaPublisher,
} from "./provider";
import type { RawProviderResponse } from "@/lib/analytics/raw-response";

/**
 * Instagram Provider Adapter (MVP-5.19). Implements only the flow verified
 * against the real Instagram API in MVP-5.16–5.18 (see
 * evidence/instagram/mvp-5.17-real-oauth-and-insights-capture.json and
 * mvp-5.18-impressions-and-rate-limit-capture.json) — no field, endpoint,
 * or behavior here was invented from documentation or memory.
 *
 * Scope boundary (Decision #41: adapters fetch and return raw, never
 * normalize): this module performs provider authentication/token
 * exchange, provider API requests, and provider error/pagination
 * handling only. It never maps a provider field to a Marqos canonical
 * metric, never determines metric state, never computes an engagement
 * rate, and never touches the database — that is the Normalizer's job
 * (MVP-5.20, not implemented here).
 *
 * `publish()` throws — real evidence never verified Instagram content
 * publishing in this session; content_publish is a different, unverified
 * scope, so this deliberately does not pretend to support it.
 *
 * Real endpoints used (Meta official docs, cross-verified against real
 * responses):
 *   POST https://api.instagram.com/oauth/access_token       (code -> short-lived token)
 *   GET  https://graph.instagram.com/access_token            (short-lived -> long-lived token)
 *   GET  https://graph.instagram.com/me/media                (media discovery)
 *   GET  https://graph.instagram.com/{media-id}/insights     (media insights)
 *
 * Verified metrics only (MVP-5.17): reach, likes, comments, shares,
 * saved, views. `impressions` is deliberately excluded from the default
 * request — MVP-5.18 proved it returns an explicit HTTP 400
 * IGApiException for the tested FEED/CAROUSEL_ALBUM media, not a value,
 * not an omission. `clicks` has no verified Instagram field at all
 * (MVP-5.13) and is never requested.
 *
 * Security (MVP-5.17 finding, now a permanent constraint): Instagram's
 * own `/me/media` response embeds the live access token inside
 * `paging.next`. Every raw payload this module returns is passed through
 * `redactInstagramAccessTokens()` first — a live token must never cross
 * into a RawProviderResponse, a thrown error, or a log line.
 */

const TOKEN_EXCHANGE_URL = "https://api.instagram.com/oauth/access_token";
const LONG_LIVED_EXCHANGE_URL = "https://graph.instagram.com/access_token";
const MEDIA_LIST_URL = "https://graph.instagram.com/me/media";
const PROFILE_URL = "https://graph.instagram.com/me";
const GRAPH_BASE_URL = "https://graph.instagram.com";

/** MVP-5.17/5.18-verified metric set only — never impressions, never clicks. */
export const INSTAGRAM_VERIFIED_INSIGHTS_METRICS = "reach,likes,comments,shares,saved,views";

/** MVP-5.18-verified allowlist. Never dump all response headers (MVP-5.16's own rationale, carried forward). */
const RATE_LIMIT_HEADER_ALLOWLIST = [
  "x-app-usage",
  "x-business-use-case-usage",
  "x-ad-account-usage",
  "x-page-usage",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

type JsonRecord = Record<string, unknown>;

export type InstagramShortLivedToken = {
  accessToken: string;
  userId?: string;
  permissions?: string[];
};

export type InstagramLongLivedToken = {
  accessToken: string;
  tokenType?: string;
  expiresInSeconds?: number;
};

export type InstagramMediaItem = {
  id: string;
  mediaType?: string;
  mediaProductType?: string;
  timestamp?: string;
  permalink?: string;
};

export type InstagramRawResult<TBody> = {
  httpStatus: number;
  ok: boolean;
  payload: TBody;
  rateLimitHeaders: Record<string, string>;
};

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

function extractSafeRateLimitHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of RATE_LIMIT_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) safe[name] = value;
  }
  return safe;
}

/**
 * Builds a ProviderError from a real Instagram/Meta error response.
 * MVP-5.18 confirmed at least two distinct shapes exist — this never
 * assumes one universal envelope:
 *   OAuth/token endpoint:  { error_type, code, error_message }
 *   Graph/Insights endpoint: { error: { message, type, code, fbtrace_id } }
 * The thrown error's `providerResponse` is the redacted body only —
 * never includes the access token used for the request that failed.
 */
function buildInstagramProviderError(httpStatus: number, body: unknown, stage?: InstagramOAuthStage): ProviderError {
  const safeBody = redactInstagramAccessTokens(body) as JsonRecord | null;
  const nested = safeBody?.error as JsonRecord | undefined;

  if (nested && typeof nested === "object") {
    // Graph/Insights shape: { error: { message, type, code, fbtrace_id } }
    const message = typeof nested.message === "string" ? nested.message : "Instagram API request failed";
    const code = typeof nested.type === "string" ? nested.type : "ig_api_exception";
    return new ProviderError(message, code, { httpStatus, ...safeBody }, stage);
  }

  if (typeof safeBody?.error_type === "string" || typeof safeBody?.error_message === "string") {
    // OAuth/token exchange shape: { error_type, code, error_message }
    const message = typeof safeBody?.error_message === "string" ? safeBody.error_message : "Instagram OAuth request failed";
    const code = typeof safeBody?.error_type === "string" ? safeBody.error_type : "oauth_exception";
    return new ProviderError(message, code, { httpStatus, ...safeBody }, stage);
  }

  return new ProviderError(
    "Instagram API request failed with an unrecognized error shape",
    "unknown_error_shape",
    { httpStatus, ...(safeBody ?? {}) },
    stage,
  );
}

/** The OAuth-connection provider calls, tagged on their ProviderErrors (MVP-5.34A, profile_lookup MVP-5.35B.3). */
export type InstagramOAuthStage = "short_lived_exchange" | "long_lived_exchange" | "profile_lookup";

/**
 * MVP-5.34A: the only shape an Instagram OAuth failure may be returned or
 * logged in. Built field-by-field from an explicit allowlist — never a
 * spread of providerResponse — so the code, tokens, client secret, request
 * URLs, and Vault values have no path into it.
 */
export type InstagramOAuthDiagnostics = {
  stage: "connection";
  providerStage: string | null;
  error: string;
  message: string;
  httpStatus: number | null;
  providerCode: number | null;
  providerSubcode: number | null;
  fbtraceId: string | null;
};

const SECRET_QUERY_PARAM_PATTERN = /([?&](?:access_token|client_secret|code)=)[^&\s"]+/g;
// Instagram Login tokens are "IG"-prefixed opaque strings (MVP-5.17 evidence).
const INSTAGRAM_TOKEN_LIKE_PATTERN = /\bIG[A-Za-z0-9_-]{20,}/g;

function scrub(value: string, sensitiveValues: readonly string[]): string {
  let out = value.replace(SECRET_QUERY_PARAM_PATTERN, "$1[REDACTED]").replace(INSTAGRAM_TOKEN_LIKE_PATTERN, "[REDACTED]");
  for (const secret of sensitiveValues) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Maps any error thrown by connectRealInstagramAccount to the allowlisted
 * diagnostic shape. `sensitiveValues` (e.g. the authorization code, the
 * client secret) are scrubbed from every string field as defense in depth
 * against a provider message that echoes a request value back.
 */
export function toSafeInstagramOAuthDiagnostics(err: unknown, sensitiveValues: readonly string[] = []): InstagramOAuthDiagnostics {
  if (!(err instanceof ProviderError)) {
    return {
      stage: "connection",
      providerStage: null,
      error: "connection_failed",
      message: scrub(err instanceof Error ? err.message : "Instagram connection failed", sensitiveValues),
      httpStatus: null,
      providerCode: null,
      providerSubcode: null,
      fbtraceId: null,
    };
  }

  const body = err.providerResponse;
  // Graph shape nests under `error`; OAuth token shape is flat (see buildInstagramProviderError).
  const nested = body.error && typeof body.error === "object" ? (body.error as JsonRecord) : body;
  const fbtraceId = typeof nested.fbtrace_id === "string" ? scrub(nested.fbtrace_id, sensitiveValues) : null;

  return {
    stage: "connection",
    providerStage: err.stage ?? null,
    error: scrub(err.code, sensitiveValues),
    message: scrub(err.message, sensitiveValues),
    httpStatus: numberOrNull(body.httpStatus),
    providerCode: numberOrNull(nested.code),
    providerSubcode: numberOrNull(nested.error_subcode),
    fbtraceId,
  };
}

/** Granted permission names only — anything not shaped like a scope name is dropped. */
export function safeGrantedPermissionNames(permissions: readonly unknown[] | undefined): string[] {
  return (permissions ?? []).filter((p): p is string => typeof p === "string" && /^[a-z_]{1,100}$/.test(p));
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
const UNRECOVERABLE_IDENTIFIER = Symbol("unrecoverable-identifier");

function parseJsonPreservingIdentifiers(text: string): unknown {
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

async function readJsonPreservingIdentifiers(res: Response): Promise<unknown> {
  try {
    return parseJsonPreservingIdentifiers(await res.text());
  } catch {
    return null;
  }
}

/**
 * Step A (verified, MVP-5.16/5.17): exchange an authorization code for a
 * short-lived access token. POST, form-encoded.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
 */
export async function exchangeInstagramAuthorizationCode(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<InstagramShortLivedToken> {
  const form = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  const res = await fetch(TOKEN_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await readJsonPreservingIdentifiers(res);

  if (!res.ok) {
    throw buildInstagramProviderError(res.status, body, "short_lived_exchange");
  }

  // MVP-5.17-verified real shape: { data: [{ access_token, user_id, permissions }] }.
  const dataArray = (body as JsonRecord)?.data;
  const entry = (Array.isArray(dataArray) ? dataArray[0] : body) as JsonRecord;
  if (!entry || typeof entry.access_token !== "string") {
    throw new ProviderError(
      "Instagram short-lived token exchange succeeded but returned no access_token",
      "no_access_token_in_response",
      {},
      "short_lived_exchange",
    );
  }

  if (entry.user_id === UNRECOVERABLE_IDENTIFIER) {
    throw new ProviderError(
      "Instagram returned an account identifier that cannot be preserved exactly",
      "unrecoverable_account_identifier",
      {},
      "short_lived_exchange",
    );
  }

  return {
    accessToken: entry.access_token,
    // Opaque string, exactly as sent by Instagram (JSON string or integer literal).
    userId: typeof entry.user_id === "string" ? entry.user_id : undefined,
    permissions: Array.isArray(entry.permissions) ? (entry.permissions as string[]) : undefined,
  };
}

export type InstagramProfile = {
  /** GET /me `id` — "the app user's app-scoped ID". Provenance only. */
  appScopedId: string | undefined;
  /** GET /me `user_id` — "the Instagram professional account ID, <IG_ID>". */
  professionalAccountId: string;
  username: string | undefined;
};

/**
 * MVP-5.35B.3 (Model B): GET /me?fields=id,user_id,username. The
 * professional account id is the identity MARQOS acts on (publishing
 * target, natural key). Ids are parsed losslessly (same reviver as the
 * token exchange); a missing or unrecoverable `user_id` fails closed —
 * never a fallback to the token-scoped id, `me`, or stored values. The raw
 * body never leaves this function; errors carry only the redacted Meta
 * error envelope, never the request URL (which holds the token).
 */
export async function fetchInstagramProfile(params: { accessToken: string }): Promise<InstagramProfile> {
  const url = new URL(PROFILE_URL);
  url.searchParams.set("fields", "id,user_id,username");
  url.searchParams.set("access_token", params.accessToken);

  const res = await fetch(url.toString());
  const body = await readJsonPreservingIdentifiers(res);

  if (!res.ok) {
    throw buildInstagramProviderError(res.status, body, "profile_lookup");
  }

  // Documented example nests under `data: [...]`; the live Graph shape is flat. Accept both.
  const dataArray = (body as JsonRecord | null)?.data;
  const entry = (Array.isArray(dataArray) ? dataArray[0] : body) as JsonRecord | null | undefined;

  if (!entry || entry.user_id === UNRECOVERABLE_IDENTIFIER || typeof entry.user_id !== "string" || entry.user_id === "") {
    throw new ProviderError(
      "Instagram did not return an exact professional account id for this authorization",
      entry?.user_id === UNRECOVERABLE_IDENTIFIER ? "unrecoverable_account_identifier" : "missing_professional_account_id",
      {},
      "profile_lookup",
    );
  }

  return {
    professionalAccountId: entry.user_id,
    // Optional provenance: kept only when exact.
    appScopedId: typeof entry.id === "string" && entry.id !== "" ? entry.id : undefined,
    username: typeof entry.username === "string" && entry.username !== "" ? entry.username : undefined,
  };
}

/**
 * Step B (verified, MVP-5.17): exchange a short-lived token for a
 * long-lived one (~60 days, confirmed by real evidence to the second).
 * GET, graph.instagram.com.
 */
export async function exchangeInstagramLongLivedToken(params: {
  clientSecret: string;
  shortLivedAccessToken: string;
}): Promise<InstagramLongLivedToken> {
  const url = new URL(LONG_LIVED_EXCHANGE_URL);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", params.clientSecret);
  url.searchParams.set("access_token", params.shortLivedAccessToken);

  const res = await fetch(url.toString());
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw buildInstagramProviderError(res.status, body, "long_lived_exchange");
  }

  const parsed = body as JsonRecord;
  if (typeof parsed?.access_token !== "string") {
    throw new ProviderError(
      "Instagram long-lived token exchange succeeded but returned no access_token",
      "no_access_token_in_response",
      {},
      "long_lived_exchange",
    );
  }

  return {
    accessToken: parsed.access_token,
    tokenType: typeof parsed.token_type === "string" ? parsed.token_type : undefined,
    expiresInSeconds: typeof parsed.expires_in === "number" ? parsed.expires_in : undefined,
  };
}

/**
 * Step C (verified, MVP-5.17): real media discovery. Not part of the
 * per-publication metrics sync path (which already knows its
 * external_publication_id) — kept as a standalone, adapter-boundary
 * function for account-connection/backfill use, exactly the shape
 * MVP-5.19's directive names as part of the verified flow.
 *
 * The raw payload is redacted before it is returned: MVP-5.17 proved
 * this endpoint's `paging.next` embeds the live access token.
 */
export async function listInstagramMedia(params: { accessToken: string }): Promise<InstagramRawResult<JsonRecord>> {
  const url = new URL(MEDIA_LIST_URL);
  url.searchParams.set("fields", "id,media_type,media_product_type,timestamp,permalink");
  url.searchParams.set("access_token", params.accessToken);

  const res = await fetch(url.toString());
  const body = await res.json().catch(() => null);
  const rateLimitHeaders = extractSafeRateLimitHeaders(res.headers);

  if (!res.ok) {
    throw buildInstagramProviderError(res.status, body);
  }

  return {
    httpStatus: res.status,
    ok: res.ok,
    payload: redactInstagramAccessTokens(body) as JsonRecord,
    rateLimitHeaders,
  };
}

/**
 * Step D (verified, MVP-5.17/5.18): real Media Insights retrieval.
 * Exposed both as the internal primitive (used by getMetrics() below)
 * and as a standalone export, since MVP-5.19's test/verification
 * requirements need direct access to `rateLimitHeaders`, which
 * SocialProviderAdapter.getMetrics()'s existing RawProviderResponse
 * contract has no field for (extending that shared, cross-provider
 * contract is out of this milestone's adapter-only scope).
 */
export async function fetchInstagramMediaInsights(params: {
  mediaId: string;
  accessToken: string;
  metric?: string;
}): Promise<InstagramRawResult<JsonRecord>> {
  const url = new URL(`${GRAPH_BASE_URL}/${params.mediaId}/insights`);
  url.searchParams.set("metric", params.metric ?? INSTAGRAM_VERIFIED_INSIGHTS_METRICS);
  url.searchParams.set("access_token", params.accessToken);

  const res = await fetch(url.toString());
  const body = await res.json().catch(() => null);
  const rateLimitHeaders = extractSafeRateLimitHeaders(res.headers);

  if (!res.ok) {
    throw buildInstagramProviderError(res.status, body);
  }

  return {
    httpStatus: res.status,
    ok: res.ok,
    payload: redactInstagramAccessTokens(body) as JsonRecord,
    rateLimitHeaders,
  };
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
    return { ok: false, ...failureDetails("transport_error", "Container creation request did not complete", null, null) };
  }
  const body = await readJsonPreservingIdentifiers(res);
  if (!res.ok) {
    return { ok: false, ...failureDetails("container_create_failed", "Container creation was rejected", res.status, body) };
  }
  const id = (body as JsonRecord | null)?.id;
  if (typeof id !== "string" || id === "") {
    return { ok: false, ...failureDetails("malformed_response", "Container creation returned no container id", res.status, null) };
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

export class InstagramProviderAdapter implements SocialProviderAdapter, StagedMediaPublisher {
  /**
   * Not implemented: no real evidence verified Instagram content
   * publishing in this session (MVP-5.16–5.18 covered OAuth + Insights
   * only). Throwing here is the honest choice — never a fabricated
   * publish success.
   */
  async publish(_input: ProviderPublishInput): Promise<ProviderPublishResult> {
    throw new ProviderError(
      "Instagram content publishing is not implemented (MVP-5.19 scope is metrics retrieval only)",
      "not_implemented",
    );
  }

  /**
   * Returns the raw, unnormalized Instagram Insights response for one
   * already-published media item. `input.credential` is the already-
   * resolved long-lived access token (Vault resolution happens one layer
   * up, per the existing architecture — this adapter never resolves
   * credentials itself, per src/lib/social/provider.ts's own contract).
   *
   * `observedAt` is always null: MVP-5.18 confirmed the real Insights
   * response contains no observation timestamp of any kind — inventing
   * one here would violate Decision #38's honesty requirement.
   */
  async getMetrics(input: ProviderMetricsInput): Promise<RawProviderResponse> {
    const result = await fetchInstagramMediaInsights({
      mediaId: input.externalPublicationId,
      accessToken: input.credential,
    });

    return {
      provider: input.socialAccount.platform,
      observedAt: null,
      payload: result.payload,
    };
  }

  // MVP-5.35C-B staged capability (the generic publish() above stays not_implemented).
  createMediaContainer(input: Parameters<StagedMediaPublisher["createMediaContainer"]>[0]) {
    return createInstagramMediaContainer(input);
  }

  getMediaContainerStatus(input: Parameters<StagedMediaPublisher["getMediaContainerStatus"]>[0]) {
    return getInstagramMediaContainerStatus(input);
  }

  publishMediaContainer(input: Parameters<StagedMediaPublisher["publishMediaContainer"]>[0]) {
    return publishInstagramMediaContainer(input);
  }

  listRecentMedia(input: Parameters<StagedMediaPublisher["listRecentMedia"]>[0]) {
    return listInstagramRecentMedia(input);
  }
}
