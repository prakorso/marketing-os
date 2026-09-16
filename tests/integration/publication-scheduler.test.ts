import { createClient } from "@supabase/supabase-js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL } from "@/lib/social/provider";
import { executePublication } from "@/server/services/publication-execution";
import { runScheduledPublications } from "@/server/services/publication-scheduler";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "../database/helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Integration tests for the MVP-2.4 scheduler orchestration
 * (runScheduledPublications → claim_due_publications →
 * executePublicationAsSystem → mark*AsSystem), plus a regression check
 * that the pre-existing user-facing executePublication() path is
 * unaffected by the MVP-2.4 refactor.
 *
 * runScheduledPublications() itself never touches the cookie-based RLS
 * client (only the service-role client, via createServiceRoleClient()),
 * so — unlike tests/integration/publication-execution.test.ts's
 * executePublication() tests — most tests here need only the
 * `server-only` stub, not the `next-headers`/`@supabase/ssr` mocks. The
 * one exception is the executePublication() regression test, which does
 * need setTestAccessToken exactly as MVP-2.3's suite did.
 *
 * Requires a running local Supabase stack. Skipped automatically
 * otherwise.
 */
describe.skipIf(!hasLocalSupabase)("runScheduledPublications — scheduler orchestration", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];
  const vaultSecretIds: string[] = [];

  type Fixture = { workspaceId: string; variantId: string; accountId: string };

  async function createVaultSecret(secret: string): Promise<string> {
    const { data, error } = await vaultAdmin.rpc("create_social_account_vault_secret", {
      p_secret: secret,
      p_description: "publication-scheduler-test",
    });
    if (error || !data) throw new Error(`Failed to create test vault secret: ${error?.message}`);
    vaultSecretIds.push(data as string);
    return data as string;
  }

  async function createFixture(label: string, credential: string): Promise<Fixture> {
    const owner = await createSignedInTestUser(admin);
    createdUserIds.push(owner.userId);

    const { data: workspace, error } = await owner.client.rpc("create_workspace", {
      p_name: label,
      p_slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    createdWorkspaceIds.push(workspace.id);

    const { data: brand } = await owner.client.from("brands").insert({ workspace_id: workspace.id, name: "B" }).select().single();
    const { data: content } = await owner.client
      .from("content")
      .insert({ workspace_id: workspace.id, brand_id: brand!.id, title: "C" })
      .select()
      .single();
    const { data: version } = await owner.client
      .from("content_versions")
      .insert({
        content_id: content!.id,
        workspace_id: workspace.id,
        version_number: 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    const { data: variant } = await owner.client
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspace.id, platform: "instagram" })
      .select()
      .single();

    await admin.from("content_approvals").insert({
      workspace_id: workspace.id,
      content_id: content!.id,
      content_version_id: version!.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });

    const secretId = await createVaultSecret(credential);
    const { data: account } = await owner.client
      .from("social_accounts")
      .insert({
        workspace_id: workspace.id,
        platform: "instagram",
        external_account_id: `scheduler-fixture-${label}`,
        account_name: "Fixture Account",
        vault_secret_id: secretId,
      })
      .select()
      .single();

    return { workspaceId: workspace.id, variantId: variant!.id, accountId: account!.id };
  }

  async function insertDuePublication(fixture: Fixture): Promise<string> {
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: fixture.workspaceId,
        content_variant_id: fixture.variantId,
        social_account_id: fixture.accountId,
        status: "scheduled",
        scheduled_at: new Date(Date.now() - 1000).toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert publication fixture: ${error?.message}`);
    return data.id;
  }

  afterAll(async () => {
    setTestAccessToken(null);
    if (createdWorkspaceIds.length > 0) {
      await admin.from("publications").delete().in("workspace_id", createdWorkspaceIds);
    }
    for (const secretId of vaultSecretIds) {
      await vaultAdmin.rpc("delete_social_account_vault_secret", { p_secret_id: secretId });
    }
    await cleanupTestData(admin, { workspaceIds: createdWorkspaceIds, userIds: createdUserIds });
  });

  it("11, 13. successfully executes multiple due publications across workspaces, each becoming published", async () => {
    const fixtureA = await createFixture("SchedA", "dev-only-fixture-secret-a");
    const fixtureB = await createFixture("SchedB", "dev-only-fixture-secret-b");
    const idA = await insertDuePublication(fixtureA);
    const idB = await insertDuePublication(fixtureB);

    const summary = await runScheduledPublications();

    expect(summary.claimed).toBeGreaterThanOrEqual(2);
    expect(summary.publicationIds).toContain(idA);
    expect(summary.publicationIds).toContain(idB);

    const { data: pubA } = await admin.from("publications").select("status, external_publication_id").eq("id", idA).single();
    const { data: pubB } = await admin.from("publications").select("status, external_publication_id").eq("id", idB).single();
    expect(pubA?.status).toBe("published");
    expect(pubB?.status).toBe("published");
    expect(pubA?.external_publication_id).toBeTruthy();
    expect(pubB?.external_publication_id).toBeTruthy();
  });

  it("12, 14. a mock provider failure becomes failed without preventing other claimed publications from succeeding", async () => {
    const fixtureFail = await createFixture("SchedFail", MOCK_PROVIDER_FORCE_FAILURE_CREDENTIAL);
    const fixtureOk = await createFixture("SchedOk", "dev-only-fixture-secret-ok");
    const idFail = await insertDuePublication(fixtureFail);
    const idOk = await insertDuePublication(fixtureOk);

    const summary = await runScheduledPublications();

    expect(summary.publicationIds).toContain(idFail);
    expect(summary.publicationIds).toContain(idOk);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.succeeded).toBeGreaterThanOrEqual(1);

    const { data: failedPub } = await admin.from("publications").select("status, error_code").eq("id", idFail).single();
    const { data: okPub } = await admin.from("publications").select("status").eq("id", idOk).single();
    expect(failedPub?.status).toBe("failed");
    expect(failedPub?.error_code).toBe("mock_forced_failure");
    expect(okPub?.status).toBe("published");
  });

  it("15, 19. the scheduler summary never contains credential values, and only safe metadata is present", async () => {
    const secretValue = "dev-only-fixture-secret-never-leaked";
    const fixture = await createFixture("SchedSecret", secretValue);
    await insertDuePublication(fixture);

    const summary = await runScheduledPublications();

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secretValue);
    expect(Object.keys(summary).sort()).toEqual(["claimed", "failed", "publicationIds", "succeeded"].sort());
  });

  it("16. the system execution path resolves the workspace from the claimed row itself, not from any external input", async () => {
    const fixture = await createFixture("SchedWorkspace", "dev-only-fixture-secret-workspace");
    const id = await insertDuePublication(fixture);

    const summary = await runScheduledPublications();
    expect(summary.publicationIds).toContain(id);

    const { data: pub } = await admin.from("publications").select("workspace_id, status").eq("id", id).single();
    // Confirms the executed row's workspace_id matches the fixture's own
    // workspace — runScheduledPublications never received a workspaceId
    // as an argument at all; it can only have come from the claimed row.
    expect(pub?.workspace_id).toBe(fixture.workspaceId);
    expect(pub?.status).toBe("published");
  });

  it("17. executePublication() user-facing authorization behavior remains intact after the MVP-2.4 refactor", async () => {
    const owner = await createSignedInTestUser(admin);
    createdUserIds.push(owner.userId);

    const { data: workspace } = await owner.client.rpc("create_workspace", {
      p_name: "RegressionCheck",
      p_slug: `regression-check-${Date.now()}`,
    });
    createdWorkspaceIds.push(workspace!.id);

    const {
      data: { session },
    } = await owner.client.auth.getSession();
    setTestAccessToken(session!.access_token);

    const { data: brand } = await owner.client.from("brands").insert({ workspace_id: workspace!.id, name: "B" }).select().single();
    const { data: content } = await owner.client
      .from("content")
      .insert({ workspace_id: workspace!.id, brand_id: brand!.id, title: "C" })
      .select()
      .single();
    const { data: version } = await owner.client
      .from("content_versions")
      .insert({
        content_id: content!.id,
        workspace_id: workspace!.id,
        version_number: 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    const { data: variant } = await owner.client
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: workspace!.id, platform: "instagram" })
      .select()
      .single();
    await admin.from("content_approvals").insert({
      workspace_id: workspace!.id,
      content_id: content!.id,
      content_version_id: version!.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    const secretId = await createVaultSecret("dev-only-fixture-secret-regression");
    const { data: account } = await owner.client
      .from("social_accounts")
      .insert({
        workspace_id: workspace!.id,
        platform: "instagram",
        external_account_id: "regression-account",
        account_name: "A",
        vault_secret_id: secretId,
      })
      .select()
      .single();
    const { data: publication } = await owner.client
      .from("publications")
      .insert({
        workspace_id: workspace!.id,
        content_variant_id: variant!.id,
        social_account_id: account!.id,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();

    const result = await executePublication(workspace!.id, publication!.id);
    expect(result.status).toBe("published");

    setTestAccessToken(null);
  });

  it("18. executePublicationAsSystem is not imported by any browser-facing route/action under src/app", () => {
    const appDir = join(__dirname, "..", "..", "src", "app");
    const offenders: string[] = [];

    function scan(dir: string) {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
          scan(fullPath);
        } else if (/\.(ts|tsx)$/.test(entry)) {
          const contents = readFileSync(fullPath, "utf8");
          if (contents.includes("executePublicationAsSystem") || contents.includes("markPublishingAsSystem") ||
              contents.includes("markPublishedAsSystem") || contents.includes("markFailedAsSystem")) {
            offenders.push(fullPath);
          }
        }
      }
    }

    scan(appDir);
    expect(offenders).toEqual([]);
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/integration] Skipping publication-scheduler.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
