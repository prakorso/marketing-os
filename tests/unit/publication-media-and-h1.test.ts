import { describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/social/provider";
import { executeProviderPublishSafely, isInstagramStagedPublishingEnabled, PublishedPersistenceError } from "@/server/services/publication-execution";
import { isModelBPublishReady, validateImagePublishEligibility } from "@/server/services/publication-media";
import type { Asset, Publication, SocialAccount } from "@/types/database";

/** MVP-5.35C-B — pure IMAGE eligibility rules and the generic-path H1 fix. */

const WS = "11111111-1111-1111-1111-111111111111";

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "a1",
    workspace_id: WS,
    brand_id: null,
    storage_bucket: "assets",
    storage_path: `${WS}/a1.jpg`,
    file_name: "a1.jpg",
    mime_type: "image/jpeg",
    asset_type: "image",
    file_size: 500_000,
    width: 1080,
    height: 1350,
    duration_ms: null,
    checksum: null,
    metadata: null,
    source_asset_id: null,
    created_by: null,
    created_at: "",
    updated_at: "",
    archived_at: null,
    ai_job_id: null,
    ...overrides,
  };
}

const modelB = {
  platform: "instagram",
  status: "connected",
  external_account_id: "17849990000000042",
  vault_secret_id: "v",
  metadata: { credentialKind: "real", instagramScopedUserId: "38281234567890123" },
} as Pick<SocialAccount, "platform" | "status" | "metadata" | "external_account_id" | "vault_secret_id">;

const variant = { platform: "instagram", format: "image", caption: "Hello #marqos" };

function check(overrides: { variant?: object; account?: object; assets?: Asset[] } = {}) {
  return validateImagePublishEligibility({
    workspaceId: WS,
    variant: { ...variant, ...(overrides.variant ?? {}) } as typeof variant,
    socialAccount: { ...modelB, ...(overrides.account ?? {}) } as typeof modelB,
    assets: overrides.assets ?? [asset()],
  });
}

describe("validateImagePublishEligibility", () => {
  it("accepts one JPEG asset for a Model-B Instagram image variant and targets the professional <IG_ID>", () => {
    expect(check()).toMatchObject({ ok: true, caption: "Hello #marqos", targetAccountId: "17849990000000042" });
  });

  it.each([
    ["unsupported format", { variant: { format: "carousel" } }, "unsupported_variant_format"],
    ["non-instagram variant", { variant: { platform: "tiktok" } }, "unsupported_variant_format"],
    ["zero assets", { assets: [] }, "no_publish_media"],
    [">1 asset", { assets: [asset(), asset({ id: "a2", storage_path: `${WS}/a2.jpg` })] }, "unsupported_media_count"],
    ["png mime", { assets: [asset({ mime_type: "image/png", storage_path: `${WS}/a1.png` })] }, "unsupported_media_type"],
    ["video", { assets: [asset({ asset_type: "video" })] }, "unsupported_media_type"],
    ["jpeg mime with png extension", { assets: [asset({ storage_path: `${WS}/a1.png` })] }, "unsupported_media_type"],
    ["archived", { assets: [asset({ archived_at: "2026-01-01" })] }, "asset_archived"],
    ["foreign workspace path", { assets: [asset({ storage_path: `other/a1.jpg` })] }, "invalid_storage_path"],
    ["path traversal", { assets: [asset({ storage_path: `${WS}/../x.jpg` })] }, "invalid_storage_path"],
    ["other bucket", { assets: [asset({ storage_bucket: "public" })] }, "invalid_storage_path"],
    ["> 8 MB", { assets: [asset({ file_size: 9 * 1024 * 1024 })] }, "image_spec_violation"],
    ["too tall", { assets: [asset({ width: 1080, height: 1920 })] }, "image_spec_violation"],
    ["too wide", { assets: [asset({ width: 2000, height: 1000 })] }, "image_spec_violation"],
    ["caption > 2200 chars", { variant: { caption: "x".repeat(2201) } }, "caption_limit_exceeded"],
    ["> 30 hashtags", { variant: { caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") } }, "caption_limit_exceeded"],
    ["> 20 mentions", { variant: { caption: Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" ") } }, "caption_limit_exceeded"],
    ["legacy (non-Model-B) account", { account: { external_account_id: "38281234567890120", metadata: { credentialKind: "real" } } }, "account_not_publish_ready"],
    ["legacy rendering equal to scoped id", { account: { external_account_id: "38281234567890120" } }, "account_not_publish_ready"],
    ["mock account", { account: { metadata: {} } }, "account_not_publish_ready"],
    ["disconnected account", { account: { status: "disconnected" } }, "account_not_publish_ready"],
  ])("rejects %s", (_label, overrides, code) => {
    expect(check(overrides as never)).toMatchObject({ ok: false, code });
  });

  it("allows missing width/height (provider validates) and a null caption", () => {
    expect(check({ assets: [asset({ width: null, height: null })], variant: { caption: null } })).toMatchObject({ ok: true, caption: null });
  });

  it("isModelBPublishReady requires provenance and a non-legacy exact id", () => {
    expect(isModelBPublishReady(modelB)).toBe(true);
    expect(isModelBPublishReady({ ...modelB, vault_secret_id: null })).toBe(false);
  });
});

describe("executeProviderPublishSafely (H1, generic path)", () => {
  const published = { id: "p1", status: "published" } as Publication;
  const failed = { id: "p1", status: "failed" } as Publication;
  const result = { externalPublicationId: "m1", externalUrl: null, providerResponse: {} };

  it("provider success + local published write failure NEVER calls persistFailed and never re-invokes the provider", async () => {
    const publish = vi.fn(async () => result);
    const persistPublished = vi.fn(async () => {
      throw new Error("db down");
    });
    const persistFailed = vi.fn(async () => failed);

    await expect(executeProviderPublishSafely({ publish, persistPublished, persistFailed, retries: 3 })).rejects.toBeInstanceOf(PublishedPersistenceError);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(persistPublished).toHaveBeenCalledTimes(3);
    expect(persistFailed).not.toHaveBeenCalled();
  });

  it("a transient local write failure is retried and then succeeds", async () => {
    const persistPublished = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(published);
    const persistFailed = vi.fn();
    await expect(executeProviderPublishSafely({ publish: async () => result, persistPublished, persistFailed })).resolves.toBe(published);
    expect(persistFailed).not.toHaveBeenCalled();
  });

  it("a provider failure still marks failed with the normalized error", async () => {
    const persistFailed = vi.fn(async () => failed);
    await executeProviderPublishSafely({
      publish: async () => {
        throw new ProviderError("nope", "mock_forced_failure", { mock: true });
      },
      persistPublished: vi.fn(),
      persistFailed,
    });
    expect(persistFailed).toHaveBeenCalledWith({ errorCode: "mock_forced_failure", errorMessage: "nope", providerResponse: { mock: true } });
  });
});

describe("staged publishing enablement gate (D3)", () => {
  it("is OFF unless MARQOS_INSTAGRAM_STAGED_PUBLISHING is exactly 'enabled'", () => {
    vi.stubEnv("MARQOS_INSTAGRAM_STAGED_PUBLISHING", "");
    expect(isInstagramStagedPublishingEnabled()).toBe(false);
    vi.stubEnv("MARQOS_INSTAGRAM_STAGED_PUBLISHING", "true");
    expect(isInstagramStagedPublishingEnabled()).toBe(false);
    vi.stubEnv("MARQOS_INSTAGRAM_STAGED_PUBLISHING", "enabled");
    expect(isInstagramStagedPublishingEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});
