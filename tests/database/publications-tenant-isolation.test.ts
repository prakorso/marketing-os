import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTestData,
  createSignedInTestUser,
  hasLocalSupabase,
  serviceRoleClient,
} from "./helpers";

/**
 * RLS / tenant isolation / approval-gate tests for the MVP-2.2 Publications
 * Foundation migration (publications), per Database Architecture §8, §16,
 * §17, §19-21 and Engineering Blueprint §9/§16/§17.
 *
 * Fixture chain per workspace: brand -> content -> content_version ->
 * content_variant -> (content_approvals decisions) -> social_account ->
 * publications. Three variants are seeded with different approval
 * histories to exercise the "latest decision wins" gate (MVP-2.2 explicit
 * decision, see the publications migration header comment and
 * src/server/services/publications.ts):
 *   - variantApproved:      latest (and only) decision is 'approved'
 *   - variantUnapproved:    no content_approvals row at all
 *   - variantSuperseded:    'approved' recorded first, then a later
 *                           'changes_requested' — the latest decision must
 *                           win, so this must NOT be schedulable despite
 *                           the earlier approval.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning, so `npm test` stays
 * green in environments without Docker.
 */
describe.skipIf(!hasLocalSupabase)("Publications RLS + approval gate — tenant isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let brandId: string;
  let accountId: string;
  let otherAccountId: string;
  let otherVariantId: string;

  let variantApprovedId: string;
  let variantUnapprovedId: string;
  let variantSupersededId: string;

  const createdPublicationIds: string[] = [];

  async function createVariantWithVersion(contentId: string): Promise<{ variantId: string; contentVersionId: string }> {
    const { data: version, error: versionError } = await editor.client
      .from("content_versions")
      .insert({
        content_id: contentId,
        workspace_id: workspaceId,
        version_number: Math.floor(Math.random() * 1_000_000) + 1,
        generation_method: "human",
        content_payload: { text: "fixture" },
      })
      .select()
      .single();
    if (versionError || !version) {
      throw new Error(`Failed to create content_version fixture: ${versionError?.message}`);
    }

    const { data: variant, error: variantError } = await editor.client
      .from("content_variants")
      .insert({ content_version_id: version.id, workspace_id: workspaceId, platform: "instagram" })
      .select()
      .single();
    if (variantError || !variant) {
      throw new Error(`Failed to create content_variant fixture: ${variantError?.message}`);
    }

    return { variantId: variant.id, contentVersionId: version.id };
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await editor.client.rpc("create_workspace", {
      p_name: "Publications Tenant A",
      p_slug: `publications-a-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Publications Tenant B",
      p_slug: `publications-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace) throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const { error: memberError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (memberError) throw new Error(`Failed to add viewer to workspace: ${memberError.message}`);

    const { data: brand, error: brandError } = await editor.client
      .from("brands")
      .insert({ workspace_id: workspaceId, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) throw new Error(`Failed to create brand fixture: ${brandError?.message}`);
    brandId = brand.id;

    const { data: content, error: contentError } = await editor.client
      .from("content")
      .insert({ workspace_id: workspaceId, brand_id: brandId, title: "Fixture Content" })
      .select()
      .single();
    if (contentError || !content) throw new Error(`Failed to create content fixture: ${contentError?.message}`);

    // variantApproved: single decision, approved.
    const approved = await createVariantWithVersion(content.id);
    variantApprovedId = approved.variantId;
    const { error: approvedApprovalError } = await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: content.id,
      content_version_id: approved.contentVersionId,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    if (approvedApprovalError) throw new Error(`Failed to seed approval: ${approvedApprovalError.message}`);

    // variantUnapproved: no content_approvals row at all.
    const unapproved = await createVariantWithVersion(content.id);
    variantUnapprovedId = unapproved.variantId;

    // variantSuperseded: approved first, then changes_requested later —
    // the latest decision (changes_requested) must win.
    const superseded = await createVariantWithVersion(content.id);
    variantSupersededId = superseded.variantId;
    const { error: firstDecisionError } = await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: content.id,
      content_version_id: superseded.contentVersionId,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    if (firstDecisionError) throw new Error(`Failed to seed first decision: ${firstDecisionError.message}`);
    // Ensure a strictly later created_at than the first decision.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { error: secondDecisionError } = await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: content.id,
      content_version_id: superseded.contentVersionId,
      status: "changes_requested",
      reviewed_at: new Date().toISOString(),
    });
    if (secondDecisionError) throw new Error(`Failed to seed second decision: ${secondDecisionError.message}`);

    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({
        workspace_id: workspaceId,
        platform: "instagram",
        external_account_id: "pub-fixture-account",
        account_name: "Fixture Account",
      })
      .select()
      .single();
    if (accountError || !account) throw new Error(`Failed to create social_account fixture: ${accountError?.message}`);
    accountId = account.id;

    // Cross-tenant fixtures, owned by outsider in otherWorkspaceId.
    const { data: otherBrand, error: otherBrandError } = await outsider.client
      .from("brands")
      .insert({ workspace_id: otherWorkspaceId, name: "Other Brand" })
      .select()
      .single();
    if (otherBrandError || !otherBrand) throw new Error(`Failed to create other brand: ${otherBrandError?.message}`);

    const { data: otherContent, error: otherContentError } = await outsider.client
      .from("content")
      .insert({ workspace_id: otherWorkspaceId, brand_id: otherBrand.id, title: "Other Content" })
      .select()
      .single();
    if (otherContentError || !otherContent) throw new Error(`Failed to create other content: ${otherContentError?.message}`);

    const { data: otherVersion, error: otherVersionError } = await outsider.client
      .from("content_versions")
      .insert({
        content_id: otherContent.id,
        workspace_id: otherWorkspaceId,
        version_number: 1,
        generation_method: "human",
        content_payload: { text: "other" },
      })
      .select()
      .single();
    if (otherVersionError || !otherVersion) throw new Error(`Failed to create other version: ${otherVersionError?.message}`);

    const { data: otherVariant, error: otherVariantError } = await outsider.client
      .from("content_variants")
      .insert({ content_version_id: otherVersion.id, workspace_id: otherWorkspaceId })
      .select()
      .single();
    if (otherVariantError || !otherVariant) throw new Error(`Failed to create other variant: ${otherVariantError?.message}`);
    otherVariantId = otherVariant.id;

    const { data: otherAccount, error: otherAccountError } = await outsider.client
      .from("social_accounts")
      .insert({
        workspace_id: otherWorkspaceId,
        platform: "tiktok",
        external_account_id: "pub-fixture-other-account",
        account_name: "Other Fixture Account",
      })
      .select()
      .single();
    if (otherAccountError || !otherAccount) throw new Error(`Failed to create other social_account: ${otherAccountError?.message}`);
    otherAccountId = otherAccount.id;
  });

  afterAll(async () => {
    if (createdPublicationIds.length > 0) {
      await admin.from("publications").delete().in("id", createdPublicationIds);
    }
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, viewer?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  function track(id: string | undefined) {
    if (id) createdPublicationIds.push(id);
    return id;
  }

  describe("read access", () => {
    let publicationId: string;

    it("6. allows an editor to insert a draft publication", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe("draft");
      publicationId = data!.id;
      track(publicationId);
    });

    it("1. allows a workspace member (editor) to SELECT publications", async () => {
      const { data, error } = await editor.client.from("publications").select("*").eq("id", publicationId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(publicationId);
    });

    it("2. allows a workspace viewer to SELECT publications", async () => {
      const { data, error } = await viewer.client.from("publications").select("*").eq("id", publicationId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(publicationId);
    });

    it("3. hides publications from a non-member", async () => {
      const { data, error } = await outsider.client.from("publications").select("*").eq("id", publicationId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });
  });

  describe("write authorization", () => {
    it("4. denies a viewer from inserting a publication", async () => {
      const { data, error } = await viewer.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("5. denies a viewer from updating a publication", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data, error } = await viewer.client
        .from("publications")
        .update({ error_message: "hijacked" })
        .eq("id", created!.id)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe("composite tenant FKs", () => {
    it("7. rejects a cross-workspace content_variant_id", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: otherVariantId, // belongs to otherWorkspaceId
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("8. rejects a cross-workspace social_account_id", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: otherAccountId, // belongs to otherWorkspaceId
          idempotency_key: crypto.randomUUID(),
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("24. rejects a mixed valid-variant/cross-tenant-account combination via the account-side composite FK independently", async () => {
      // content_variant_id is valid for workspaceId, but social_account_id
      // belongs to otherWorkspaceId — proves the two composite FKs are
      // each independently enforced, not just the pairing as a whole.
      const { data, error } = await outsider.client
        .from("publications")
        .insert({
          workspace_id: otherWorkspaceId,
          content_variant_id: otherVariantId,
          social_account_id: accountId, // belongs to workspaceId, not otherWorkspaceId
          idempotency_key: crypto.randomUUID(),
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("idempotency", () => {
    it("9. rejects an insert with idempotency_key omitted (NOT NULL)", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
        } as never)
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("10. rejects a duplicate (workspace_id, social_account_id, idempotency_key)", async () => {
      const key = crypto.randomUUID();
      const { data: first, error: firstError } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: key,
        })
        .select()
        .single();
      expect(firstError).toBeNull();
      track(first?.id);

      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: key,
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("approval gate", () => {
    it("11. denies transition to scheduled when the content version has no approval at all", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id)
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("12. allows transition to scheduled when the latest approval decision is approved", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe("scheduled");
    });

    it("13. denies transition to scheduled when the latest decision is changes_requested, even though an older approval exists", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantSupersededId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id)
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("14. CRITICAL: rejects a direct service-role (elevated, RLS-bypassing) attempt to force status='published' without a valid latest approval", async () => {
      // admin is the service-role client — it bypasses every RLS policy on
      // `publications` entirely. If this insert succeeded, the approval
      // gate would only be an application/RLS-layer convention, not a
      // database-authoritative constraint. The trigger must still fire.
      const { data, error } = await admin
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          status: "published",
          idempotency_key: crypto.randomUUID(),
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("15. allows a fresh publication to be INSERTed directly at status='scheduled' when the content version is approved", async () => {
      // Complements test 12 (which schedules via UPDATE on an existing
      // draft row) by proving the gate also protects a same-statement
      // INSERT, not only a subsequent UPDATE.
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          status: "scheduled",
          scheduled_at: new Date().toISOString(),
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe("scheduled");
      track(data?.id);
    });
  });

  describe("cancellation gate (database-enforced, enforce_publication_cancellation_gate)", () => {
    // MVP-2.2 stabilization: cancellation source-state is now enforced by
    // the database trigger enforce_publication_cancellation_gate
    // (20260916140000_publications.sql), not application code alone. The
    // service-layer check in cancelPublication (src/server/services/
    // publications.ts) remains as defense in depth on top of this trigger,
    // mirroring the approval gate's "both layers required" principle
    // (Database Architecture §17).
    it("rejects a direct INSERT with status='cancelled' — every publication must begin at draft", async () => {
      const { data, error } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          status: "cancelled",
          idempotency_key: crypto.randomUUID(),
        })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("16. allows a transition to cancelled from draft", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "cancelled" })
        .eq("id", created!.id)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe("cancelled");
    });

    it("17. allows a transition to cancelled from approved", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      // publication_status = 'approved' is NOT gated by the approval-gate
      // trigger (only scheduled/publishing/published are), so a direct
      // editor update is sufficient to reach it.
      await editor.client.from("publications").update({ status: "approved" }).eq("id", created!.id);

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "cancelled" })
        .eq("id", created!.id)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe("cancelled");
    });

    it("18. allows a transition to cancelled from scheduled", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id);

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "cancelled" })
        .eq("id", created!.id)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe("cancelled");
    });

    it("19. rejects a transition to cancelled from publishing", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      // MVP-2.3 requires publishing to be entered only from scheduled
      // (enforce_publication_lifecycle_transitions) — traverse that state
      // first. variantApprovedId satisfies the (still-independent)
      // approval gate at both steps.
      await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id);

      const { error: toPublishingError } = await editor.client
        .from("publications")
        .update({ status: "publishing" })
        .eq("id", created!.id);
      expect(toPublishingError).toBeNull();

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "cancelled" })
        .eq("id", created!.id)
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("20. rejects a transition to cancelled from published", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      // MVP-2.3 requires published to be entered only from publishing,
      // which itself requires scheduled first — traverse both.
      await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id);
      await editor.client.from("publications").update({ status: "publishing" }).eq("id", created!.id);

      const { error: toPublishedError } = await editor.client
        .from("publications")
        .update({ status: "published", published_at: new Date().toISOString() })
        .eq("id", created!.id);
      expect(toPublishedError).toBeNull();

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "cancelled" })
        .eq("id", created!.id)
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a transition to cancelled from failed", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      // 'failed' is not gated by the approval trigger itself, but MVP-2.3
      // requires it to be entered only from publishing, which requires
      // scheduled first and IS approval-gated — variantApprovedId
      // satisfies that intermediate requirement.
      await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id);
      await editor.client.from("publications").update({ status: "publishing" }).eq("id", created!.id);

      const { error: toFailedError } = await editor.client
        .from("publications")
        .update({ status: "failed", error_code: "test_fixture", error_message: "fixture" })
        .eq("id", created!.id);
      expect(toFailedError).toBeNull();

      const { data, error } = await editor.client
        .from("publications")
        .update({ status: "cancelled" })
        .eq("id", created!.id)
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("CRITICAL: rejects a direct service-role (elevated, RLS-bypassing) attempt to cancel a publishing publication", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantApprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      await editor.client
        .from("publications")
        .update({ status: "scheduled", scheduled_at: new Date().toISOString() })
        .eq("id", created!.id);
      await editor.client.from("publications").update({ status: "publishing" }).eq("id", created!.id);

      // admin is the service-role client — bypasses RLS entirely. The
      // cancellation gate trigger must still fire regardless of role.
      const { data, error } = await admin.from("publications").update({ status: "cancelled" }).eq("id", created!.id).select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("historical preservation", () => {
    it("21. has no DELETE grant/policy: even an editor cannot hard-delete a publication", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { error } = await editor.client.from("publications").delete().eq("id", created!.id).select();
      expect(error).not.toBeNull();

      const { data: stillThere } = await admin.from("publications").select("id").eq("id", created!.id).single();
      expect(stillThere?.id).toBe(created!.id);
    });

    it("22. a publication survives its social account being disconnected", async () => {
      const { data: tempAccount, error: tempAccountError } = await editor.client
        .from("social_accounts")
        .insert({
          workspace_id: workspaceId,
          platform: "youtube",
          external_account_id: "pub-disconnect-fixture",
          account_name: "Disconnect Fixture",
        })
        .select()
        .single();
      expect(tempAccountError).toBeNull();

      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: tempAccount!.id,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { error: disconnectError } = await editor.client
        .from("social_accounts")
        .update({ status: "disconnected", vault_secret_id: null })
        .eq("id", tempAccount!.id);
      expect(disconnectError).toBeNull();

      const { data: stillThere, error } = await editor.client
        .from("publications")
        .select("id, social_account_id")
        .eq("id", created!.id)
        .single();

      expect(error).toBeNull();
      expect(stillThere?.social_account_id).toBe(tempAccount!.id);
    });
  });

  describe("cross-workspace publication isolation", () => {
    it("23. outsider cannot read or write into workspaceId's publications at all", async () => {
      const { data: created } = await editor.client
        .from("publications")
        .insert({
          workspace_id: workspaceId,
          content_variant_id: variantUnapprovedId,
          social_account_id: accountId,
          idempotency_key: crypto.randomUUID(),
        })
        .select()
        .single();
      track(created?.id);

      const { data: readAttempt } = await outsider.client
        .from("publications")
        .select("*")
        .eq("id", created!.id)
        .maybeSingle();
      expect(readAttempt).toBeNull();

      const { data: writeAttempt, error: writeError } = await outsider.client
        .from("publications")
        .update({ error_message: "outsider" })
        .eq("id", created!.id)
        .select();
      expect(writeError).toBeNull();
      expect(writeAttempt).toEqual([]);

      const { data: stillOriginal } = await admin.from("publications").select("error_message").eq("id", created!.id).single();
      expect(stillOriginal?.error_message).toBeNull();
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping publications-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
