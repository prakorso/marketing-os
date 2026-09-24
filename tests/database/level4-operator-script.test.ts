import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MediaContainerStatusResult, StagedMediaPublisher } from "@/lib/social/provider";
import type { ContentVariant, SocialAccount } from "@/types/database";

import {
  LEVEL4_CONFIRMATION,
  LEVEL4_FIXTURE_TAG,
  LEVEL4_IDEMPOTENCY_PREFIX,
  parseOperatorArgs,
  runLevel4DryRunOperator,
  type OperatorDeps,
} from "../../scripts/mvp-5.35-level4-dry-run";
import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * MVP-5.35C-E — the Level 4 operator script, exercised in TEST_MODE:
 * LOCAL Supabase, a fake credential resolver (no Vault read) and a
 * MOCK_PROVIDER (no Meta call). Fake identifiers only.
 */

const SIGNED_URL = "https://local.invalid/sign/assets/SIGNEDURLSENTINEL-OPS-0001";
const FAKE_TOKEN = "IGAAfakeOperatorToken00000000000000001";
const FAKE_IG_ID = "17849990000000042";
const CONFIRM = `--confirm-level4-dry-run=${LEVEL4_CONFIRMATION}`;

/** MOCK_PROVIDER: a full staged publisher behind a Proxy that records every property read. */
function mockProvider(statuses: MediaContainerStatusResult[] = [{ ok: true, status: "FINISHED" }]) {
  const calls = { create: 0, status: 0, publish: 0 };
  const accessed = new Set<string | symbol>();
  const queue = [...statuses];
  const full: StagedMediaPublisher = {
    async createMediaContainer() {
      calls.create += 1;
      return { ok: true, containerId: "17900000000000000888" };
    },
    async getMediaContainerStatus() {
      calls.status += 1;
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async publishMediaContainer() {
      calls.publish += 1;
      return { ok: true, mediaId: "18000000000000000999" };
    },
    async listRecentMedia() {
      return { ok: true, items: [] };
    },
  };
  const provider = new Proxy(full, {
    get(target, prop, receiver) {
      accessed.add(prop);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { provider, calls, accessed };
}

describe("parseOperatorArgs (pure)", () => {
  const ok = ["--workspace", "ws", "--publication", "00000000-0000-4000-8000-000000000001", CONFIRM];
  const refusal = (argv: string[]) => {
    try {
      parseOperatorArgs(argv);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("accepts exactly the three flags", () => {
    expect(parseOperatorArgs(ok)).toEqual({ workspace: "ws", publication: "00000000-0000-4000-8000-000000000001" });
  });
  it("refuses missing/wrong/unknown arguments", () => {
    expect(refusal(ok.slice(2))).toBe("missing_workspace_arg");
    expect(refusal([...ok.slice(0, 2), CONFIRM])).toBe("missing_publication_arg");
    expect(refusal(ok.slice(0, 4))).toBe("missing_confirmation");
    expect(refusal([...ok.slice(0, 4), "--confirm-level4-dry-run"])).toBe("missing_confirmation");
    expect(refusal([...ok.slice(0, 4), "--confirm-level4-dry-run=yes"])).toBe("wrong_confirmation");
    expect(refusal([...ok.slice(0, 4), `--confirm-level4-dry-run=${LEVEL4_CONFIRMATION.toLowerCase()}`])).toBe("wrong_confirmation");
    expect(refusal([...ok, "--dry-run"])).toBe("unknown_argument");
    expect(refusal([...ok, "--token=abc"])).toBe("unknown_argument");
    expect(refusal([...ok, "--workspace=other"])).toBe("duplicate_argument");
    expect(refusal(["--workspace", "ws", "--publication", "not-a-uuid", CONFIRM])).toBe("invalid_publication_id");
  });
});

describe.skipIf(!hasLocalSupabase)("MVP-5.35C-E Level 4 operator script (local DB, TEST_MODE)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;
  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let workspaceSlug: string;
  let otherWorkspaceId: string;
  let contentId: string;
  let account: SocialAccount;
  let legacyAccount: SocialAccount;
  let threadsAccount: SocialAccount;
  const vaultIds: string[] = [];

  async function asset(opts: { mime?: string; ext?: string } = {}): Promise<string> {
    const id = crypto.randomUUID();
    const { data, error } = await admin
      .from("marqos_assets")
      .insert({
        id,
        workspace_id: workspaceId,
        storage_path: `${workspaceId}/${id}.${opts.ext ?? "jpg"}`,
        file_name: `${id}.${opts.ext ?? "jpg"}`,
        mime_type: opts.mime ?? "image/jpeg",
        asset_type: "image",
        file_size: 400_000,
        width: 1080,
        height: 1350,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`asset: ${error?.message}`);
    return data.id;
  }

  async function variant(opts: { tag?: string | null; assets?: number; mime?: string; ext?: string } = {}): Promise<ContentVariant> {
    const { data: version } = await admin
      .from("content_versions")
      .insert({ content_id: contentId, workspace_id: workspaceId, version_number: Math.floor(Math.random() * 1e9) + 1, generation_method: "human", content_payload: { text: "ops" } })
      .select()
      .single();
    const tag = opts.tag === undefined ? LEVEL4_FIXTURE_TAG : opts.tag;
    const { data: v } = await admin
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspaceId, platform: "instagram", format: "image", caption: "Level 4 operator test", metadata: tag ? { fixture: tag } : {} })
      .select()
      .single();
    await admin.from("content_approvals").insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: version!.id, status: "approved", reviewed_at: new Date().toISOString() });
    for (let i = 0; i < (opts.assets ?? 1); i += 1) {
      await admin.from("marqos_content_variant_assets").insert({ content_variant_id: v!.id, asset_id: await asset(opts), workspace_id: workspaceId, sort_order: i });
    }
    return v!;
  }

  async function publication(opts: { variant?: ContentVariant; account?: SocialAccount; status?: "scheduled" | "publishing"; key?: string } = {}) {
    const v = opts.variant ?? (await variant());
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: v.id,
        social_account_id: (opts.account ?? account).id,
        status: "scheduled",
        scheduled_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        idempotency_key: opts.key ?? `${LEVEL4_IDEMPOTENCY_PREFIX}${crypto.randomUUID()}`,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`publication: ${error?.message}`);
    if ((opts.status ?? "publishing") === "scheduled") return data;
    return (await admin.from("publications").update({ status: "publishing" }).eq("id", data.id).select().single()).data!;
  }

  function harness(provider = mockProvider()) {
    const order: string[] = [];
    const resolved: SocialAccount[] = [];
    const logs: string[] = [];
    const deps: OperatorDeps = {
      db: admin,
      resolveCredential: async (acct) => {
        order.push("resolve");
        resolved.push(acct);
        return FAKE_TOKEN;
      },
      provider: provider.provider,
      signMediaUrl: async () => {
        order.push("sign");
        return SIGNED_URL;
      },
      sleep: async () => {},
      log: (line) => logs.push(line),
    };
    return { deps, order, resolved, logs, provider };
  }

  const argv = (publicationId: string, workspace = workspaceId) => ["--workspace", workspace, "--publication", publicationId, CONFIRM];
  const attempts = async (id: string) => (await admin.from("publication_attempts").select("*").eq("publication_id", id)).data ?? [];

  async function expectRefused(args: string[], code: string, h = harness()) {
    const result = await runLevel4DryRunOperator(args, h.deps);
    expect(result.exitCode).toBe(2);
    expect(result.evidence).toMatchObject({ result: "refused", code });
    expect(h.resolved).toHaveLength(0); // credential resolver never called
    expect(h.provider.calls).toEqual({ create: 0, status: 0, publish: 0 });
    expect(h.provider.accessed.size).toBe(0);
    return result;
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    workspaceSlug = `l4-ops-${Date.now()}`;
    const { data: ws } = await editor.client.rpc("create_workspace", { p_name: "L4 operator", p_slug: workspaceSlug });
    workspaceId = ws!.id;
    const { data: other } = await editor.client.rpc("create_workspace", { p_name: "L4 other", p_slug: `l4-ops-other-${Date.now()}` });
    otherWorkspaceId = other!.id;
    const { data: brand } = await admin.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content } = await admin.from("content").insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "MARQOS L4 DRY RUN — do not publish" }).select().single();
    contentId = content!.id;

    const vaultSecret = async () => {
      const { data } = await vaultAdmin.rpc("create_social_account_vault_secret", { p_secret: FAKE_TOKEN, p_description: "l4-ops" });
      vaultIds.push(data as string);
      return data as string;
    };
    const insertAccount = async (row: Record<string, unknown>) => {
      const { data, error } = await admin
        .from("social_accounts")
        .insert({ workspace_id: workspaceId, status: "connected", vault_secret_id: await vaultSecret(), ...row } as never)
        .select()
        .single();
      if (error || !data) throw new Error(`account: ${error?.message}`);
      return data as SocialAccount;
    };
    account = await insertAccount({ platform: "instagram", external_account_id: FAKE_IG_ID, account_name: "l4-ops", metadata: { credentialKind: "real", instagramScopedUserId: "38281234567890123" } });
    // Legacy (pre-Model-B) rendering: no scoped id recorded.
    legacyAccount = await insertAccount({ platform: "instagram", external_account_id: "17849990000000043", account_name: "l4-legacy", metadata: { credentialKind: "real" } });
    threadsAccount = await insertAccount({ platform: "threads", external_account_id: "100000000000001", account_name: "l4-threads", metadata: { credentialKind: "fake" } });
  });

  afterAll(async () => {
    for (const id of vaultIds) await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: id });
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  describe("guards refuse BEFORE credential resolution and provider access", () => {
    it("argument guards (missing workspace / publication / confirmation, wrong confirmation)", async () => {
      const pub = await publication();
      await expectRefused(["--publication", pub.id, CONFIRM], "missing_workspace_arg");
      await expectRefused(["--workspace", workspaceId, CONFIRM], "missing_publication_arg");
      await expectRefused(["--workspace", workspaceId, "--publication", pub.id], "missing_confirmation");
      await expectRefused(["--workspace", workspaceId, "--publication", pub.id, "--confirm-level4-dry-run=CREATE"], "wrong_confirmation");
      expect(await attempts(pub.id)).toHaveLength(0);
    });

    it("unknown workspace and wrong workspace", async () => {
      const pub = await publication();
      await expectRefused(argv(pub.id, "no-such-workspace-slug"), "workspace_not_found");
      await expectRefused(argv(pub.id, otherWorkspaceId), "publication_workspace_mismatch");
    });

    it("publication absent", async () => {
      await expectRefused(argv(crypto.randomUUID()), "publication_not_found");
    });

    it("wrong fixture tag (variant tag or idempotency prefix)", async () => {
      await expectRefused(argv((await publication({ variant: await variant({ tag: "some-other-fixture" }) })).id), "not_level4_fixture");
      await expectRefused(argv((await publication({ variant: await variant({ tag: null }) })).id), "not_level4_fixture");
      await expectRefused(argv((await publication({ key: `ordinary-${crypto.randomUUID()}` })).id), "not_level4_fixture");
    });

    it("wrong account and non-Model-B account", async () => {
      await expectRefused(argv((await publication({ account: threadsAccount })).id), "account_not_instagram");
      await expectRefused(argv((await publication({ account: legacyAccount })).id), "account_not_model_b_ready");
    });

    it("wrong publication state", async () => {
      await expectRefused(argv((await publication({ status: "scheduled" })).id), "publication_not_publishing");
    });

    it("zero, multiple and unsupported assets", async () => {
      await expectRefused(argv((await publication({ variant: await variant({ assets: 0 }) })).id), "media_no_publish_media");
      await expectRefused(argv((await publication({ variant: await variant({ assets: 2 }) })).id), "media_unsupported_media_count");
      await expectRefused(argv((await publication({ variant: await variant({ mime: "image/png", ext: "png" }) })).id), "media_unsupported_media_type");
    });

    it("prior open attempt", async () => {
      const pub = await publication();
      await admin.from("publication_attempts").insert({ workspace_id: workspaceId, publication_id: pub.id, provider: "instagram" });
      await expectRefused(argv(pub.id), "prior_attempt_exists");
      expect(await attempts(pub.id)).toHaveLength(1);
    });

    it("workspace slug resolves to the same exact workspace", async () => {
      const pub = await publication({ status: "scheduled" });
      await expectRefused(argv(pub.id, workspaceSlug), "publication_not_publishing"); // got past A/B by slug
    });
  });

  describe("valid MOCK_PROVIDER path", () => {
    it("resolves the credential only after every guard, creates exactly one container, never touches publishMediaContainer, then refuses a rerun", async () => {
      const pub = await publication();
      const h = harness(mockProvider([{ ok: true, status: "IN_PROGRESS" }, { ok: true, status: "FINISHED" }]));

      const result = await runLevel4DryRunOperator(argv(pub.id), h.deps);

      expect(result.exitCode).toBe(0);
      expect(result.evidence).toMatchObject({
        result: "dry_run_container_ready",
        workspaceId,
        publicationId: pub.id,
        containerId: "17900000000000000888",
        attemptStage: "failed",
        publicationStatus: "failed",
        errorCode: "dry_run_container_ready",
        providerCalls: { create: 1, status: 2 },
        providerStatusTransitions: ["IN_PROGRESS", "FINISHED"],
      });
      expect(h.order).toEqual(["resolve", "sign"]); // credential first resolved after all guards, before any provider work
      expect(h.resolved.map((a) => a.id)).toEqual([account.id]);
      expect(h.provider.calls).toEqual({ create: 1, status: 2, publish: 0 });
      expect(h.provider.accessed.has("publishMediaContainer")).toBe(false);
      expect([...h.provider.accessed].sort()).toEqual(["createMediaContainer", "getMediaContainerStatus"]);

      const rows = await attempts(pub.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ stage: "failed", error_code: "dry_run_container_ready", container_ids: ["17900000000000000888"] });

      // Evidence and logs never carry the token, the signed URL or the vault secret id.
      const emitted = JSON.stringify(result.evidence) + h.logs.join("\n");
      for (const secret of [FAKE_TOKEN, SIGNED_URL, "SIGNEDURLSENTINEL", account.vault_secret_id!]) {
        expect(emitted).not.toContain(secret);
      }

      // Rerun: refused before credential/provider; zero additional containers.
      const again = harness();
      const rerun = await expectRefused(argv(pub.id), "publication_not_publishing", again);
      expect(rerun.evidence.containerId).toBeNull();
      expect(await attempts(pub.id)).toHaveLength(1);

    });

    it("prior completed dry-run attempt refuses independently of the publication state", async () => {
      const pub = await publication();
      await admin.from("publication_attempts").insert({
        workspace_id: workspaceId,
        publication_id: pub.id,
        provider: "instagram",
        stage: "failed",
        error_code: "dry_run_container_ready",
        container_ids: ["17900000000000000111"],
      });
      await expectRefused(argv(pub.id), "prior_attempt_exists");
      expect(await attempts(pub.id)).toHaveLength(1);
    });

    it("a failing credential resolver refuses without provider access", async () => {
      const pub = await publication();
      const h = harness();
      h.deps.resolveCredential = async () => {
        throw new Error(`vault error mentioning ${FAKE_TOKEN}`);
      };
      const result = await runLevel4DryRunOperator(argv(pub.id), h.deps);
      expect(result).toMatchObject({ exitCode: 2, evidence: { result: "refused", code: "credential_unavailable" } });
      expect(JSON.stringify(result.evidence)).not.toContain(FAKE_TOKEN);
      expect(h.provider.accessed.size).toBe(0);
      expect(await attempts(pub.id)).toHaveLength(0);
    });
  });
});
