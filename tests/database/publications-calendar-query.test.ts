import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPublicationsForCalendar } from "@/server/services/publications";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * Database/service-level tests for MVP-2.5's listPublicationsForCalendar
 * (src/server/services/publications.ts): half-open [start, end) range
 * behavior, the locked calendar status scope (scheduled/publishing/
 * published/failed/cancelled — never draft/approved), status filtering,
 * ordering, and workspace isolation.
 *
 * This file calls the REAL listPublicationsForCalendar export, not a
 * hand-copied re-implementation of its query — even though it lives under
 * tests/database/ (matching the requested file path), it needs the same
 * server-only/next-headers/@supabase/ssr mocking vitest.config.ts already
 * established in MVP-2.3/2.4 (those aliases are global to the Vitest
 * module graph, not scoped to tests/integration/), so the RLS-scoped
 * client inside the service function authenticates as a real signed-in
 * test user via setTestAccessToken, exactly like
 * tests/integration/publication-execution.test.ts.
 *
 * Platform filtering (test-plan item 14) is intentionally NOT exercised
 * here: MVP-2.5 implements platform filtering client-side, over the
 * already workspace-scoped, already-fetched event list (see
 * CalendarView.tsx) — listPublicationsForCalendar itself has no platform
 * parameter, since publications carries no platform column of its own
 * (platform is resolved via social_accounts, a deliberate MVP-2.2 design
 * choice) and a service-layer platform filter would require an embedded
 * join this codebase's hand-authored Database type doesn't support.
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("listPublicationsForCalendar — [start, end) range, status scope, isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let accountId: string;

  const createdPublicationIds: string[] = [];
  function track(id: string | undefined) {
    if (id) createdPublicationIds.push(id);
    return id;
  }

  async function createApprovedVariant(ws = workspaceId, client = editor.client): Promise<{ variantId: string }> {
    const { data: brand } = await client.from("brands").insert({ workspace_id: ws, name: "B" }).select().single();
    const { data: content } = await client
      .from("content")
      .insert({ workspace_id: ws, brand_id: brand!.id, title: `Content ${Date.now()}-${Math.random()}` })
      .select()
      .single();
    const { data: version } = await client
      .from("content_versions")
      .insert({
        content_id: content!.id,
        workspace_id: ws,
        version_number: Math.floor(Math.random() * 1_000_000) + 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    const { data: variant } = await client
      .from("content_variants")
      .insert({ content_version_id: version!.id, workspace_id: ws, platform: "instagram" })
      .select()
      .single();
    await admin.from("content_approvals").insert({
      workspace_id: ws,
      content_id: content!.id,
      content_version_id: version!.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    return { variantId: variant!.id };
  }

  async function insertPublication(
    variantId: string,
    status: string,
    scheduledAt: string | null,
    ws = workspaceId,
    accId = accountId,
    client = editor.client,
  ): Promise<string> {
    const { data, error } = await client
      .from("publications")
      .insert({
        workspace_id: ws,
        content_variant_id: variantId,
        social_account_id: accId,
        status: status as never,
        scheduled_at: scheduledAt,
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to insert publication fixture: ${error?.message}`);
    if (ws === workspaceId) track(data.id);
    return data.id;
  }

  /** Drives a scheduled publication through publishing to the target terminal status, honoring the lifecycle trigger. */
  async function reachStatus(publicationId: string, target: "published" | "failed" | "cancelled"): Promise<void> {
    if (target === "cancelled") {
      const { error } = await editor.client.from("publications").update({ status: "cancelled" }).eq("id", publicationId);
      if (error) throw new Error(`Failed to cancel fixture: ${error.message}`);
      return;
    }
    await editor.client.from("publications").update({ status: "publishing" }).eq("id", publicationId);
    if (target === "published") {
      await editor.client
        .from("publications")
        .update({ status: "published", published_at: new Date().toISOString() })
        .eq("id", publicationId);
    } else {
      await editor.client
        .from("publications")
        .update({ status: "failed", error_code: "test", error_message: "test" })
        .eq("id", publicationId);
    }
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Calendar Query Tenant A",
      p_slug: `calendar-query-a-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Calendar Query Tenant B",
      p_slug: `calendar-query-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "calendar-query-fixture-account",
        account_name: "Fixture Account",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);
    accountId = account.id;

    const {
      data: { session },
    } = await editor.client.auth.getSession();
    setTestAccessToken(session!.access_token);
  });

  afterAll(async () => {
    setTestAccessToken(null);
    if (createdPublicationIds.length > 0) {
      await admin.from("publications").delete().in("id", createdPublicationIds);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  const RANGE_START = "2027-03-01T00:00:00.000Z";
  const RANGE_END = "2027-04-01T00:00:00.000Z";

  it("1, 2. includes a publication exactly at the start boundary", async () => {
    const { variantId } = await createApprovedVariant();
    const id = await insertPublication(variantId, "scheduled", RANGE_START);

    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    expect(rows.map((r) => r.id)).toContain(id);
  });

  it("3. excludes a publication exactly at the end boundary", async () => {
    const { variantId } = await createApprovedVariant();
    const id = await insertPublication(variantId, "scheduled", RANGE_END);

    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("4. excludes NULL scheduled_at even for a calendar-visible status", async () => {
    const { variantId } = await createApprovedVariant();
    const id = await insertPublication(variantId, "draft", null);
    await admin.from("publications").update({ status: "scheduled" }).eq("id", id);
    const { data: confirmNull } = await admin.from("publications").select("scheduled_at").eq("id", id).single();
    expect(confirmNull?.scheduled_at).toBeNull();

    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it("5. excludes draft and approved publications from the default (unfiltered) call", async () => {
    const { variantId } = await createApprovedVariant();
    const draftId = await insertPublication(variantId, "draft", RANGE_START);
    const { data: approvedRow } = await editor.client
      .from("publications")
      .update({ status: "approved" })
      .eq("id", draftId)
      .select()
      .single();
    expect(approvedRow?.status).toBe("approved");

    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    expect(rows.map((r) => r.id)).not.toContain(draftId);
  });

  it("rejects draft/approved even if explicitly passed in the statuses filter (never widens beyond the locked set)", async () => {
    const { variantId } = await createApprovedVariant();
    const draftId = await insertPublication(variantId, "draft", RANGE_START);

    const rows = await listPublicationsForCalendar(workspaceId, {
      start: RANGE_START,
      end: RANGE_END,
      statuses: ["draft", "approved"] as never,
    });
    expect(rows.map((r) => r.id)).not.toContain(draftId);
  });

  it("6-10. includes scheduled/publishing/published/failed/cancelled publications", async () => {
    const scheduledId = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);

    const publishingId = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);
    await editor.client.from("publications").update({ status: "publishing" }).eq("id", publishingId);

    const publishedId = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);
    await reachStatus(publishedId, "published");

    const failedId = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);
    await reachStatus(failedId, "failed");

    const cancelledId = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);
    await reachStatus(cancelledId, "cancelled");

    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(scheduledId);
    expect(ids).toContain(publishingId);
    expect(ids).toContain(publishedId);
    expect(ids).toContain(failedId);
    expect(ids).toContain(cancelledId);
  });

  it("11. status filter narrows results to the requested statuses only", async () => {
    const scheduledId = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);
    const failedId = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);
    await reachStatus(failedId, "failed");

    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END, statuses: ["failed"] });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(failedId);
    expect(ids).not.toContain(scheduledId);
  });

  it("12. workspace isolation: another workspace's publications never appear, even querying with the editor's own session", async () => {
    const { variantId: otherVariantId } = await createApprovedVariant(otherWorkspaceId, outsider.client);
    const { data: otherAccount } = await outsider.client
      .from("social_accounts")
      .insert({
        workspace_id: otherWorkspaceId,
        platform: "tiktok",
        external_account_id: "calendar-query-other-account",
        account_name: "Other Account",
      })
      .select()
      .single();
    const otherPubId = await insertPublication(
      otherVariantId,
      "scheduled",
      RANGE_START,
      otherWorkspaceId,
      otherAccount!.id,
      outsider.client,
    );

    // Query as the editor (not a member of otherWorkspaceId) for
    // otherWorkspaceId directly — RLS must return nothing regardless of
    // the workspaceId argument passed in.
    const rowsAsEditorForOtherWorkspace = await listPublicationsForCalendar(otherWorkspaceId, {
      start: RANGE_START,
      end: RANGE_END,
    });
    expect(rowsAsEditorForOtherWorkspace.map((r) => r.id)).not.toContain(otherPubId);

    const rowsForOwnWorkspace = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    expect(rowsForOwnWorkspace.map((r) => r.id)).not.toContain(otherPubId);

    await admin.from("publications").delete().eq("id", otherPubId);
  });

  it("13. ordering is scheduled_at ascending", async () => {
    const later = await insertPublication((await createApprovedVariant()).variantId, "scheduled", "2027-03-20T00:00:00.000Z");
    const earlier = await insertPublication((await createApprovedVariant()).variantId, "scheduled", "2027-03-05T00:00:00.000Z");

    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    const earlierIndex = rows.findIndex((r) => r.id === earlier);
    const laterIndex = rows.findIndex((r) => r.id === later);
    expect(earlierIndex).toBeGreaterThanOrEqual(0);
    expect(laterIndex).toBeGreaterThanOrEqual(0);
    expect(earlierIndex).toBeLessThan(laterIndex);
  });

  it("15. returns only plain publication columns — no joined data, no credentials", async () => {
    const id = await insertPublication((await createApprovedVariant()).variantId, "scheduled", RANGE_START);
    const rows = await listPublicationsForCalendar(workspaceId, { start: RANGE_START, end: RANGE_END });
    const row = rows.find((r) => r.id === id) as unknown as Record<string, unknown>;
    expect(row).toBeDefined();
    const keys = Object.keys(row!).sort();
    expect(keys).toEqual(
      [
        "content_variant_id",
        "created_at",
        "created_by",
        "error_code",
        "error_message",
        "external_publication_id",
        "external_url",
        "id",
        "idempotency_key",
        "provider_response",
        "published_at",
        "scheduled_at",
        "social_account_id",
        "status",
        "updated_at",
        "workspace_id",
      ].sort(),
    );
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping publications-calendar-query.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
