import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInstagramMediaContainer,
  getInstagramMediaContainerStatus,
  InstagramProviderAdapter,
  listInstagramRecentMedia,
  publishInstagramMediaContainer,
} from "@/lib/social/instagram-adapter";
import { isStagedMediaPublisher, MockProviderAdapter } from "@/lib/social/provider";

/**
 * MVP-5.35C-B — staged Instagram publishing HTTP methods (fetch mocked; no
 * Meta call). Raw-text bodies so large integer ids can be expressed.
 * Sentinels must never appear in any result.
 */

const TOKEN = "IGAAfakeStagedPublishToken000000000001";
const SIGNED_URL = "https://ezmg-fake.supabase.co/storage/v1/object/sign/assets/ws/asset.jpg?token=SIGNEDURLSENTINEL0002";
const ACCOUNT = "17849990000000042";

function respond(text: string, status = 200) {
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

function stub(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function transportError(code: string) {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

function expectNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain("SIGNEDURLSENTINEL0002");
  expect(serialized).not.toContain(SIGNED_URL);
}

const publish = () => publishInstagramMediaContainer({ credential: TOKEN, accountId: ACCOUNT, containerId: "17900000000000001" });

describe("MVP-5.35C-B staged Instagram adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("InstagramProviderAdapter exposes the staged capability; the generic publish() stays not_implemented; mock is unaffected", async () => {
    const adapter = new InstagramProviderAdapter();
    expect(isStagedMediaPublisher(adapter)).toBe(true);
    expect(isStagedMediaPublisher(new MockProviderAdapter())).toBe(false);
    await expect(adapter.publish({} as never)).rejects.toMatchObject({ code: "not_implemented" });
  });

  describe("createMediaContainer", () => {
    it("POSTs image_url/caption with the token in the body (not the URL) and returns the exact container id", async () => {
      const fetchMock = stub(async () => respond('{"id":17900000000000000123}'));
      const result = await createInstagramMediaContainer({ credential: TOKEN, accountId: ACCOUNT, imageUrl: SIGNED_URL, caption: "Hello" });
      expect(result).toEqual({ ok: true, containerId: "17900000000000000123" });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://graph.instagram.com/${ACCOUNT}/media`);
      expect(url).not.toContain(TOKEN);
      expect(init.method).toBe("POST");
      const form = new URLSearchParams(String(init.body));
      expect(form.get("image_url")).toBe(SIGNED_URL);
      expect(form.get("caption")).toBe("Hello");
      expect(form.get("access_token")).toBe(TOKEN);
    });

    it("omits caption when absent", async () => {
      const fetchMock = stub(async () => respond('{"id":"1"}'));
      await createInstagramMediaContainer({ credential: TOKEN, accountId: ACCOUNT, imageUrl: SIGNED_URL, caption: null });
      expect(new URLSearchParams(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).has("caption")).toBe(false);
    });

    it("classifies a Graph rejection with safe details", async () => {
      stub(async () =>
        respond(`{"error":{"message":"Invalid image","type":"OAuthException","code":9004,"error_subcode":2207052,"fbtrace_id":"Afb1","echo":"${SIGNED_URL}&access_token=${TOKEN}"}}`, 400),
      );
      const result = await createInstagramMediaContainer({ credential: TOKEN, accountId: ACCOUNT, imageUrl: SIGNED_URL, caption: null });
      expect(result).toMatchObject({ ok: false, code: "OAuthException", httpStatus: 400, providerCode: 9004, providerSubcode: 2207052, fbtraceId: "Afb1" });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("classifies 5xx and transport failures as not ok (never throws)", async () => {
      stub(async () => respond("<html>bad</html>", 502));
      expect((await createInstagramMediaContainer({ credential: TOKEN, accountId: ACCOUNT, imageUrl: SIGNED_URL, caption: null })).ok).toBe(false);
      stub(async () => {
        throw transportError("ECONNRESET");
      });
      const result = await createInstagramMediaContainer({ credential: TOKEN, accountId: ACCOUNT, imageUrl: SIGNED_URL, caption: null });
      expect(result).toMatchObject({ ok: false, code: "transport_error" });
      expectNoSecrets(result);
    });
  });

  describe("getMediaContainerStatus", () => {
    it.each(["FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED", "PUBLISHED"])("maps %s", async (value) => {
      stub(async () => respond(`{"status_code":"${value}","id":"1"}`));
      expect(await getInstagramMediaContainerStatus({ credential: TOKEN, containerId: "1" })).toEqual({ ok: true, status: value });
    });

    it("maps an unexpected value to UNKNOWN_VALUE and a failure to not ok", async () => {
      stub(async () => respond('{"status_code":"SOMETHING_NEW"}'));
      expect(await getInstagramMediaContainerStatus({ credential: TOKEN, containerId: "1" })).toEqual({ ok: true, status: "UNKNOWN_VALUE" });
      stub(async () => {
        throw transportError("ETIMEDOUT");
      });
      const failed = await getInstagramMediaContainerStatus({ credential: TOKEN, containerId: "1" });
      expect(failed.ok).toBe(false);
      expectNoSecrets(failed);
    });
  });

  describe("publishMediaContainer (D4)", () => {
    it("2xx with a media id → published (lossless id), creation_id in the body", async () => {
      const fetchMock = stub(async () => respond('{"id":18000000000000000999}'));
      expect(await publish()).toEqual({ ok: true, mediaId: "18000000000000000999" });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://graph.instagram.com/${ACCOUNT}/media_publish`);
      expect(new URLSearchParams(String(init.body)).get("creation_id")).toBe("17900000000000001");
    });

    it("authoritative structured Graph rejection → rejected", async () => {
      stub(async () => respond('{"error":{"message":"Media not ready","type":"OAuthException","code":9007,"error_subcode":2207027}}', 400));
      expect(await publish()).toMatchObject({ ok: false, outcome: "rejected", providerCode: 9007 });
    });

    it.each([
      ["timeout", () => Promise.reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))],
      ["connection reset", () => Promise.reject(transportError("ECONNRESET"))],
      ["ENOTFOUND after invocation", () => Promise.reject(transportError("ENOTFOUND"))],
      ["ECONNREFUSED after invocation", () => Promise.reject(transportError("ECONNREFUSED"))],
      ["5xx with a Graph body", () => Promise.resolve(respond('{"error":{"message":"Service temporarily unavailable","type":"OAuthException","code":2}}', 503))],
      ["malformed 2xx body", () => Promise.resolve(respond("not json"))],
      ["2xx without id", () => Promise.resolve(respond('{"success":true}'))],
      ["4xx without a structured Graph error", () => Promise.resolve(respond("<html>forbidden</html>", 403))],
    ])("%s → unknown", async (_label, impl) => {
      stub(impl as () => Promise<Response>);
      const result = await publish();
      expect(result).toMatchObject({ ok: false, outcome: "unknown" });
      expectNoSecrets(result);
    });

    it("never retries: exactly one request per call", async () => {
      const fetchMock = stub(async () => {
        throw transportError("ECONNRESET");
      });
      await publish();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("listRecentMedia returns ids/captions/timestamps only (read-only GET)", async () => {
    const fetchMock = stub(async () =>
      respond(`{"data":[{"id":18000000000000000999,"caption":"Hi","timestamp":"2026-09-23T10:00:00+0000"}],"paging":{"next":"https://graph.instagram.com/x?access_token=${TOKEN}"}}`),
    );
    const result = await listInstagramRecentMedia({ credential: TOKEN, accountId: ACCOUNT });
    expect(result).toEqual({ ok: true, items: [{ id: "18000000000000000999", caption: "Hi", timestamp: "2026-09-23T10:00:00+0000" }] });
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe("GET");
    expectNoSecrets(result);
  });
});
