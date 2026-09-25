import { afterEach, describe, expect, it, vi } from "vitest";

import { createInstagramMediaContainer } from "@/lib/social/instagram-graph";

/**
 * MVP-5.36H2 — G1 (container creation) outcome classification in the real
 * Graph client (fetch mocked; no Meta call). Only a 4xx carrying the
 * structured Graph error envelope is an authoritative rejection; every other
 * failure is `unknown` and must never be retried automatically.
 */

const TOKEN = "IGAAfakeG1ClassificationToken000000001";
const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-G1-0001";
const ACCOUNT = "17849990000000042";

const create = () => createInstagramMediaContainer({ credential: TOKEN, accountId: ACCOUNT, imageUrl: SIGNED_URL, caption: null });
const respond = (text: string, status: number) => new Response(text, { status, headers: { "content-type": "application/json" } });
const stub = (impl: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(impl));

describe("createInstagramMediaContainer G1 classification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("2xx with an id → known success", async () => {
    stub(async () => respond(`{"id":17900000000000000123}`, 200));
    expect(await create()).toEqual({ ok: true, containerId: "17900000000000000123" });
  });

  it("4xx with the structured Graph envelope → rejected (known not created)", async () => {
    stub(async () => respond(`{"error":{"message":"Invalid image","type":"OAuthException","code":9004}}`, 400));
    expect(await create()).toMatchObject({ ok: false, outcome: "rejected", httpStatus: 400 });
  });

  it("4xx without the envelope → unknown", async () => {
    stub(async () => respond("<html>bad request</html>", 400));
    expect(await create()).toMatchObject({ ok: false, outcome: "unknown" });
  });

  it("5xx, even with an envelope → unknown", async () => {
    stub(async () => respond(`{"error":{"message":"Please retry","type":"OAuthException","code":2}}`, 503));
    expect(await create()).toMatchObject({ ok: false, outcome: "unknown", httpStatus: 503 });
  });

  it("timeout / transport error → unknown", async () => {
    stub(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await create()).toMatchObject({ ok: false, outcome: "unknown", code: "transport_error" });
  });

  it("2xx without a container id (malformed) → unknown", async () => {
    stub(async () => respond(`{"ok":true}`, 200));
    const result = await create();
    expect(result).toMatchObject({ ok: false, outcome: "unknown", code: "malformed_response" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
