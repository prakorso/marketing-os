import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient, supabaseUrl } from "./helpers";

/**
 * Database-level tests for the MVP-2.4 claim_due_publications RPC
 * (20260916180000_publication_scheduler_claim.sql): due-selection
 * correctness, batch bounding, concurrency safety (FOR UPDATE SKIP
 * LOCKED), cross-workspace handling, and continued enforcement of the
 * existing approval/lifecycle gates even under this service-role,
 * cross-workspace claim path.
 *
 * Pure database/RPC tests — no service-layer imports (see
 * tests/integration/publication-scheduler.test.ts for the orchestration-
 * level tests that exercise runScheduledPublications() end to end).
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("claim_due_publications — due-selection, concurrency, cross-workspace", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;
  const vaultAdmin = hasLocalSupabase ? createClient(supabaseUrl!, process.env.SUPABASE_SERVICE_ROLE_KEY!) : null!;

  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];

  type Fixture = { workspaceId: string; variantId: string; accountId: string; contentId: string };

  async function createWorkspaceWithApprovedVariant(label: string): Promise<Fixture> {
    const owner = await createSignedInTestUser(admin);
    createdUserIds.push(owner.userId);

    const { data: workspace, error } = await owner.client.rpc("create_workspace", {
      p_name: label,
      p_slug: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    createdWorkspaceIds.push(workspace.id);

    const { data: brand, error: brandError } = await owner.client
      .from("brands")
      .insert({ workspace_id: workspace.id, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) throw new Error(`Failed to create brand fixture: ${brandError?.message}`);

    const { data: content, error: contentError } = await owner.client
      .from("content")
      .insert({ workspace_id: workspace.id, brand_id: brand.id, title: "Fixture Content" })
      .select()
      .single();
    if (contentError || !content) throw new Error(`Failed to create content fixture: ${contentError?.message}`);

    const { data: version, error: versionError } = await owner.client
      .from("content_versions")
      .insert({
        content_id: content.id,
        workspace_id: workspace.id,
        version_number: 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    if (versionError || !version) throw new Error(`Failed to create content_version fixture: ${versionError?.message}`);

    const { data: variant, error: variantError } = await owner.client
      .from("content_variants")
      .insert({ content_version_id: version.id, workspace_id: workspace.id, platform: "instagram" })
      .select()
      .single();
    if (variantError || !variant) throw new Error(`Failed to create content_variant fixture: ${variantError?.message}`);

    const { error: approvalError } = await admin.from("content_approvals").insert({
      workspace_id: workspace.id,
      content_id: content.id,
      content_version_id: version.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    if (approvalError) throw new Error(`Failed to seed approval: ${approvalError.message}`);

    const { data: account, error: accountError } = await owner.client
      .from("social_accounts")
      .insert({
        workspace_id: workspace.id,
        platform: "instagram",
        external_account_id: `claim-fixture-${label}`,
        account_name: "Fixture Account",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);

    return { workspaceId: workspace.id, variantId: variant.id, accountId: account.id, contentId: content.id };
  }

  async function insertPublication(
    fixture: Fixture,
    fields: { status?: string; scheduledAt?: string | null },
  ): Promise<string> {
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: fixture.workspaceId,
        content_variant_id: fixture.variantId,
        social_account_id: fixture.accountId,
        status: (fields.status ?? "scheduled") as never,
        scheduled_at: fields.scheduledAt === undefined ? null : fields.scheduledAt,
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert publication fixture: ${error?.message}`);
    return data.id;
  }

  afterAll(async () => {
    if (createdWorkspaceIds.length > 0) {
      await admin.from("publications").delete().in("workspace_id", createdWorkspaceIds);
    }
    await cleanupTestData(admin, { workspaceIds: createdWorkspaceIds, userIds: createdUserIds });
  });

  it("1. does not claim a future scheduled publication", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("Future");
    const id = await insertPublication(fixture, { scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });
    expect(error).toBeNull();
    expect((data ?? []).map((p: { id: string }) => p.id)).not.toContain(id);

    const { data: stillScheduled } = await admin.from("publications").select("status").eq("id", id).single();
    expect(stillScheduled?.status).toBe("scheduled");
  });

  it("2. claims a due scheduled publication", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("Due");
    const id = await insertPublication(fixture, { scheduledAt: new Date(Date.now() - 1000).toISOString() });

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });
    expect(error).toBeNull();
    const claimed = (data ?? []) as { id: string; status: string }[];
    const match = claimed.find((p) => p.id === id);
    expect(match).toBeDefined();
    expect(match?.status).toBe("publishing");
  });

  it("3. claims an overdue scheduled publication (no expiration/grace period)", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("Overdue");
    const id = await insertPublication(fixture, {
      scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });
    expect(error).toBeNull();
    const claimed = (data ?? []) as { id: string; status: string }[];
    expect(claimed.some((p) => p.id === id && p.status === "publishing")).toBe(true);
  });

  it("4. ignores a non-scheduled publication even if scheduled_at is due", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("Draft");
    const id = await insertPublication(fixture, {
      status: "draft",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });
    expect(error).toBeNull();
    expect((data ?? []).map((p: { id: string }) => p.id)).not.toContain(id);

    const { data: stillDraft } = await admin.from("publications").select("status").eq("id", id).single();
    expect(stillDraft?.status).toBe("draft");
  });

  it("5. ignores a scheduled publication with NULL scheduled_at", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("NullSchedule");
    const id = await insertPublication(fixture, { status: "draft" }); // draft avoids the approval-gate on scheduled with null scheduled_at
    // Force status='scheduled' with scheduled_at left NULL directly via
    // service-role, bypassing the app layer (schedulePublication always
    // sets both together) specifically to prove the claim query's own
    // `scheduled_at IS NOT NULL` guard, independent of app discipline.
    // The approval gate still requires an approved decision, which this
    // fixture has (createWorkspaceWithApprovedVariant seeds one).
    const { error: forceError } = await admin.from("publications").update({ status: "scheduled" }).eq("id", id);
    expect(forceError).toBeNull();

    const { data: confirmNull } = await admin.from("publications").select("scheduled_at").eq("id", id).single();
    expect(confirmNull?.scheduled_at).toBeNull();

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });
    expect(error).toBeNull();
    expect((data ?? []).map((p: { id: string }) => p.id)).not.toContain(id);

    const { data: stillScheduled } = await admin.from("publications").select("status").eq("id", id).single();
    expect(stillScheduled?.status).toBe("scheduled");
  });

  it("6. respects the batch size limit", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("Batch");
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => insertPublication(fixture, { scheduledAt: new Date(Date.now() - 1000).toISOString() })),
    );

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 3 });
    expect(error).toBeNull();
    const claimed = (data ?? []) as { id: string }[];
    expect(claimed.length).toBe(3);
    expect(claimed.every((p) => ids.includes(p.id))).toBe(true);

    // remaining 2 should still be claimable afterward
    const { data: second } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 3 });
    expect((second ?? []).length).toBe(2);
  });

  it("7. two concurrent claim attempts cannot claim the same publication", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("Concurrent");
    const id = await insertPublication(fixture, { scheduledAt: new Date(Date.now() - 1000).toISOString() });

    const [first, second] = await Promise.all([
      vaultAdmin.rpc("claim_due_publications", { p_batch_size: 10 }),
      vaultAdmin.rpc("claim_due_publications", { p_batch_size: 10 }),
    ]);

    const firstIds = ((first.data ?? []) as { id: string }[]).map((p) => p.id);
    const secondIds = ((second.data ?? []) as { id: string }[]).map((p) => p.id);
    const totalMatches = [...firstIds, ...secondIds].filter((claimedId) => claimedId === id).length;

    expect(totalMatches).toBe(1);
  });

  it("8. handles publications in multiple workspaces independently in one claim call", async () => {
    const fixtureA = await createWorkspaceWithApprovedVariant("MultiA");
    const fixtureB = await createWorkspaceWithApprovedVariant("MultiB");
    const idA = await insertPublication(fixtureA, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
    const idB = await insertPublication(fixtureB, { scheduledAt: new Date(Date.now() - 1000).toISOString() });

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });
    expect(error).toBeNull();
    const claimed = (data ?? []) as { id: string; workspace_id: string }[];

    const claimedA = claimed.find((p) => p.id === idA);
    const claimedB = claimed.find((p) => p.id === idB);
    expect(claimedA?.workspace_id).toBe(fixtureA.workspaceId);
    expect(claimedB?.workspace_id).toBe(fixtureB.workspaceId);
  });

  it("9. a claimed row remains protected by the lifecycle trigger against further invalid transitions", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("PostClaimGate");
    const id = await insertPublication(fixture, { scheduledAt: new Date(Date.now() - 1000).toISOString() });

    await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });

    const { data: current } = await admin.from("publications").select("status").eq("id", id).single();
    expect(current?.status).toBe("publishing");

    // Double invocation (publishing -> publishing) is rejected for anyone,
    // including service_role — the claim already moved this row out of
    // 'scheduled', so re-entering 'publishing' is not a valid transition.
    const { data, error } = await admin.from("publications").update({ status: "publishing" }).eq("id", id).select();
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("10. service-role cannot bypass the approval gate: a claim attempt on a row whose approval was superseded is skipped, not claimed", async () => {
    const fixture = await createWorkspaceWithApprovedVariant("Superseded");
    const id = await insertPublication(fixture, { scheduledAt: new Date(Date.now() - 1000).toISOString() });

    // Supersede the earlier approval with a later rejection in its own
    // statement/transaction so it gets a strictly later created_at.
    const { error: supersedeError } = await admin.from("content_approvals").insert({
      workspace_id: fixture.workspaceId,
      content_id: fixture.contentId,
      content_version_id: (
        await admin.from("content_variants").select("content_version_id").eq("id", fixture.variantId).single()
      ).data!.content_version_id,
      status: "changes_requested",
      reviewed_at: new Date().toISOString(),
    });
    expect(supersedeError).toBeNull();

    const { data, error } = await vaultAdmin.rpc("claim_due_publications", { p_batch_size: 50 });
    expect(error).toBeNull();
    expect((data ?? []).map((p: { id: string }) => p.id)).not.toContain(id);

    const { data: stillScheduled } = await admin.from("publications").select("status").eq("id", id).single();
    expect(stillScheduled?.status).toBe("scheduled");
  });

  it("claim_due_publications is not executable by an authenticated (non-service-role) client", async () => {
    const owner = await createSignedInTestUser(admin);
    createdUserIds.push(owner.userId);

    const {
      data: { session },
    } = await owner.client.auth.getSession();
    const ownerUntyped = createClient(supabaseUrl!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${session!.access_token}` } },
    });

    const { data, error } = await ownerUntyped.rpc("claim_due_publications", { p_batch_size: 1 });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping publication-scheduler-claim.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
