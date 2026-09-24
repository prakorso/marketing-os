import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTestData,
  createSignedInTestUser,
  hasLocalSupabase,
  serviceRoleClient,
} from "./helpers";

/**
 * RLS / tenant isolation tests for the MVP-1.2 Content domain migration
 * (content_briefs, content, content_versions, content_variants, assets,
 * content_assets, content_approvals), per Engineering Blueprint §24 and
 * Database Architecture §20.
 *
 * Beyond the standard member-read-allowed / non-member-denied /
 * editor-write-allowed / viewer-write-denied / composite-cross-tenant-FK
 * matrix (established in foundation-tenant-isolation.test.ts and
 * brand-tenant-isolation.test.ts), this file also proves the
 * content-domain-specific invariants: content_versions immutability,
 * content_approvals append-only + owner/admin-only INSERT (separation of
 * duties from content authorship), and the archive-only /
 * never-hard-deleted semantics for content_briefs, content, content_variants
 * and assets.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning.
 */
describe.skipIf(!hasLocalSupabase)("Content domain RLS — tenant isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let owner: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let marketer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let brandId: string;
  let briefId: string;
  let contentId: string;
  let versionId: string;
  let variantId: string;
  let assetId: string;

  beforeAll(async () => {
    owner = await createSignedInTestUser(admin);
    marketer = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await owner.client.rpc("create_workspace", {
      p_name: "Content Tenant A",
      p_slug: `content-tenant-a-${Date.now()}`,
    });
    if (error || !workspace) throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    workspaceId = workspace.id;

    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Content Tenant B",
      p_slug: `content-tenant-b-${Date.now()}`,
    });
    if (otherError || !otherWorkspace)
      throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    otherWorkspaceId = otherWorkspace.id;

    const { error: marketerError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: marketer.userId, role: "marketer" });
    if (marketerError) throw new Error(`Failed to add marketer: ${marketerError.message}`);

    const { error: viewerError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (viewerError) throw new Error(`Failed to add viewer: ${viewerError.message}`);

    const { data: brand, error: brandError } = await owner.client
      .from("brands")
      .insert({ workspace_id: workspaceId, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) throw new Error(`Failed to create brand fixture: ${brandError?.message}`);
    brandId = brand.id;

    const { data: brief, error: briefError } = await marketer.client
      .from("content_briefs")
      .insert({ workspace_id: workspaceId, brand_id: brandId, title: "Fixture Brief" })
      .select()
      .single();
    if (briefError || !brief) throw new Error(`Failed to create brief fixture: ${briefError?.message}`);
    briefId = brief.id;

    const { data: content, error: contentError } = await marketer.client
      .from("content")
      .insert({ workspace_id: workspaceId, brand_id: brandId, brief_id: briefId, title: "Fixture Content" })
      .select()
      .single();
    if (contentError || !content) throw new Error(`Failed to create content fixture: ${contentError?.message}`);
    contentId = content.id;

    const { data: version, error: versionError } = await marketer.client
      .from("content_versions")
      .insert({
        content_id: contentId,
        workspace_id: workspaceId,
        version_number: 1,
        generation_method: "human",
        content_payload: { text: "Fixture copy" },
      })
      .select()
      .single();
    if (versionError || !version) throw new Error(`Failed to create version fixture: ${versionError?.message}`);
    versionId = version.id;

    const { data: variant, error: variantError } = await marketer.client
      .from("content_variants")
      .insert({ content_version_id: versionId, workspace_id: workspaceId, platform: "instagram" })
      .select()
      .single();
    if (variantError || !variant) throw new Error(`Failed to create variant fixture: ${variantError?.message}`);
    variantId = variant.id;

    const { data: asset, error: assetError } = await marketer.client
      .from("marqos_assets")
      .insert({
        workspace_id: workspaceId,
        storage_path: `${workspaceId}/fixture.txt`,
        file_name: "fixture.txt",
        mime_type: "text/plain",
        asset_type: "document",
        file_size: 5,
      })
      .select()
      .single();
    if (assetError || !asset) throw new Error(`Failed to create asset fixture: ${assetError?.message}`);
    assetId = asset.id;
  });

  afterAll(async () => {
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [owner?.userId, marketer?.userId, viewer?.userId, outsider?.userId].filter(
        (id): id is string => Boolean(id),
      ),
    });
  });

  describe("content_briefs", () => {
    it("allows a member (any role) to read a brief", async () => {
      const { data, error } = await viewer.client.from("content_briefs").select("*").eq("id", briefId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(briefId);
    });

    it("hides the brief from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("content_briefs")
        .select("*")
        .eq("id", briefId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting a brief", async () => {
      const { data, error } = await viewer.client
        .from("content_briefs")
        .insert({ workspace_id: workspaceId, brand_id: brandId, title: "Viewer-attempted" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor (marketer) to update a brief", async () => {
      const { data, error } = await marketer.client
        .from("content_briefs")
        .update({ status: "ready" })
        .eq("id", briefId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("ready");
    });

    it("denies a viewer from updating a brief", async () => {
      const { data, error } = await viewer.client
        .from("content_briefs")
        .update({ title: "Hijacked" })
        .eq("id", briefId)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("has no DELETE grant/policy: cannot hard-delete a brief (archive-only)", async () => {
      const { error } = await owner.client.from("content_briefs").delete().eq("id", briefId).select();
      expect(error).not.toBeNull();

      const { data: stillThere } = await admin
        .from("content_briefs")
        .select("id")
        .eq("id", briefId)
        .single();
      expect(stillThere?.id).toBe(briefId);
    });

    it("rejects a cross-workspace brand_id via composite FK, even for an editor of the pairing's workspace", async () => {
      const { data, error } = await outsider.client
        .from("content_briefs")
        .insert({ workspace_id: otherWorkspaceId, brand_id: brandId, title: "Cross-tenant brief" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("content", () => {
    it("allows a member to read content", async () => {
      const { data, error } = await viewer.client.from("content").select("*").eq("id", contentId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(contentId);
    });

    it("hides content from a non-member", async () => {
      const { data, error } = await outsider.client.from("content").select("*").eq("id", contentId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting content", async () => {
      const { data, error } = await viewer.client
        .from("content")
        .insert({ workspace_id: workspaceId, brand_id: brandId, title: "Viewer-attempted" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to update content status", async () => {
      const { data, error } = await marketer.client
        .from("content")
        .update({ status: "in_review" })
        .eq("id", contentId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("in_review");
    });

    it("denies a viewer from updating content", async () => {
      const { data, error } = await viewer.client
        .from("content")
        .update({ title: "Hijacked" })
        .eq("id", contentId)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("has no DELETE grant/policy: cannot hard-delete content (archive-only)", async () => {
      const { error } = await owner.client.from("content").delete().eq("id", contentId).select();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace brand_id via composite FK", async () => {
      const { data, error } = await outsider.client
        .from("content")
        .insert({ workspace_id: otherWorkspaceId, brand_id: brandId, title: "Cross-tenant content" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("content_versions (immutable)", () => {
    it("allows a member to read a version", async () => {
      const { data, error } = await viewer.client
        .from("content_versions")
        .select("*")
        .eq("id", versionId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(versionId);
    });

    it("hides versions from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("content_versions")
        .select("*")
        .eq("id", versionId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting a version", async () => {
      const { data, error } = await viewer.client
        .from("content_versions")
        .insert({
          content_id: contentId,
          workspace_id: workspaceId,
          version_number: 99,
          generation_method: "human",
          content_payload: {},
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("has no UPDATE grant/policy: not even an editor can modify a version", async () => {
      const { error } = await marketer.client
        .from("content_versions")
        .update({ generation_method: "hijacked" } as never)
        .eq("id", versionId)
        .select();
      expect(error).not.toBeNull();
    });

    it("has no DELETE grant/policy: not even the owner can delete a version", async () => {
      const { error } = await owner.client.from("content_versions").delete().eq("id", versionId).select();
      expect(error).not.toBeNull();
    });

    it("enforces unique (content_id, version_number)", async () => {
      const { data, error } = await marketer.client
        .from("content_versions")
        .insert({
          content_id: contentId,
          workspace_id: workspaceId,
          version_number: 1,
          generation_method: "human",
          content_payload: {},
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace content_id via composite FK", async () => {
      const { data, error } = await outsider.client
        .from("content_versions")
        .insert({
          content_id: contentId,
          workspace_id: otherWorkspaceId,
          version_number: 1,
          generation_method: "human",
          content_payload: {},
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("content_variants (never hard-deleted)", () => {
    it("allows a member to read a variant", async () => {
      const { data, error } = await viewer.client
        .from("content_variants")
        .select("*")
        .eq("id", variantId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(variantId);
    });

    it("hides variants from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("content_variants")
        .select("*")
        .eq("id", variantId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("allows an editor to update a variant's status", async () => {
      const { data, error } = await marketer.client
        .from("content_variants")
        .update({ status: "ready" })
        .eq("id", variantId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("ready");
    });

    it("denies a viewer from updating a variant", async () => {
      const { data, error } = await viewer.client
        .from("content_variants")
        .update({ status: "approved" })
        .eq("id", variantId)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("has no DELETE grant/policy: variants are never hard-deleted", async () => {
      const { error } = await owner.client.from("content_variants").delete().eq("id", variantId).select();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace content_version_id via composite FK", async () => {
      const { data, error } = await outsider.client
        .from("content_variants")
        .insert({ content_version_id: versionId, workspace_id: otherWorkspaceId, platform: "tiktok" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("assets (archive semantics)", () => {
    it("allows a member to read an asset", async () => {
      const { data, error } = await viewer.client.from("marqos_assets").select("*").eq("id", assetId).maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(assetId);
    });

    it("hides assets from a non-member", async () => {
      const { data, error } = await outsider.client.from("marqos_assets").select("*").eq("id", assetId).maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting an asset", async () => {
      const { data, error } = await viewer.client
        .from("marqos_assets")
        .insert({
          workspace_id: workspaceId,
          storage_path: `${workspaceId}/viewer.txt`,
          file_name: "viewer.txt",
          mime_type: "text/plain",
          asset_type: "document",
          file_size: 1,
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to archive an asset via archived_at, not deletion", async () => {
      const now = new Date().toISOString();
      const { data, error } = await marketer.client
        .from("marqos_assets")
        .update({ archived_at: now })
        .eq("id", assetId)
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.archived_at).toBeTruthy();

      const { data: stillThere } = await admin.from("marqos_assets").select("id").eq("id", assetId).single();
      expect(stillThere?.id).toBe(assetId);
    });

    it("denies a viewer from updating an asset", async () => {
      const { data, error } = await viewer.client
        .from("marqos_assets")
        .update({ file_name: "hijacked.txt" })
        .eq("id", assetId)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("has no DELETE grant/policy: assets are archive-only", async () => {
      const { error } = await owner.client.from("marqos_assets").delete().eq("id", assetId).select();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace brand_id via composite FK", async () => {
      const { data, error } = await outsider.client
        .from("marqos_assets")
        .insert({
          workspace_id: otherWorkspaceId,
          brand_id: brandId,
          storage_path: `${otherWorkspaceId}/cross.txt`,
          file_name: "cross.txt",
          mime_type: "text/plain",
          asset_type: "document",
          file_size: 1,
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });

  describe("content_assets (junction — tenant isolation)", () => {
    it("allows an editor to link an asset to content", async () => {
      const { data, error } = await marketer.client
        .from("marqos_content_assets")
        .insert({ content_id: contentId, asset_id: assetId, workspace_id: workspaceId, sort_order: 1 })
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.content_id).toBe(contentId);
    });

    it("allows a member to read the link", async () => {
      const { data, error } = await viewer.client
        .from("marqos_content_assets")
        .select("*")
        .eq("content_id", contentId)
        .eq("asset_id", assetId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.asset_id).toBe(assetId);
    });

    it("hides the link from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("marqos_content_assets")
        .select("*")
        .eq("content_id", contentId)
        .eq("asset_id", assetId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from linking an asset", async () => {
      const { data, error } = await viewer.client
        .from("marqos_content_assets")
        .insert({ content_id: contentId, asset_id: assetId, workspace_id: workspaceId, sort_order: 2 })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace pairing via composite FK on both content_id and asset_id", async () => {
      const { data, error } = await outsider.client
        .from("marqos_content_assets")
        .insert({ content_id: contentId, asset_id: assetId, workspace_id: otherWorkspaceId })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("denies a non-member from unlinking an asset", async () => {
      const { data, error } = await outsider.client
        .from("marqos_content_assets")
        .delete()
        .eq("content_id", contentId)
        .eq("asset_id", assetId)
        .select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("allows an editor to unlink an asset (removes the association, not the asset)", async () => {
      const { data, error } = await marketer.client
        .from("marqos_content_assets")
        .delete()
        .eq("content_id", contentId)
        .eq("asset_id", assetId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(1);

      const { data: assetStillThere } = await admin.from("marqos_assets").select("id").eq("id", assetId).single();
      expect(assetStillThere?.id).toBe(assetId);
    });
  });

  describe("content_approvals (append-only, owner/admin-only INSERT)", () => {
    let approvalId: string;

    it("denies a marketer (editor, but not admin) from creating an approval — separation of duties", async () => {
      const { data, error } = await marketer.client
        .from("content_approvals")
        .insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: versionId, status: "pending" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("denies a viewer from creating an approval", async () => {
      const { data, error } = await viewer.client
        .from("content_approvals")
        .insert({ workspace_id: workspaceId, content_id: contentId, content_version_id: versionId, status: "pending" })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows the owner (admin) to create an approval", async () => {
      const { data, error } = await owner.client
        .from("content_approvals")
        .insert({
          workspace_id: workspaceId,
          content_id: contentId,
          content_version_id: versionId,
          status: "approved",
          reviewed_by: owner.userId,
          reviewed_at: new Date().toISOString(),
        })
        .select()
        .single();
      expect(error).toBeNull();
      expect(data?.status).toBe("approved");
      approvalId = data!.id;
    });

    it("allows a member (including the marketer who couldn't create it) to read the approval", async () => {
      const { data, error } = await marketer.client
        .from("content_approvals")
        .select("*")
        .eq("id", approvalId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data?.id).toBe(approvalId);
    });

    it("hides the approval from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("content_approvals")
        .select("*")
        .eq("id", approvalId)
        .maybeSingle();
      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("has no UPDATE grant/policy: append-only, not even the owner can modify an approval", async () => {
      const { error } = await owner.client
        .from("content_approvals")
        .update({ status: "rejected" } as never)
        .eq("id", approvalId)
        .select();
      expect(error).not.toBeNull();
    });

    it("has no DELETE grant/policy: not even the owner can delete an approval", async () => {
      const { error } = await owner.client.from("content_approvals").delete().eq("id", approvalId).select();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace content_id/content_version_id via composite FK, even for an admin of the pairing's workspace", async () => {
      const { data, error } = await outsider.client
        .from("content_approvals")
        .insert({
          workspace_id: otherWorkspaceId,
          content_id: contentId,
          content_version_id: versionId,
          status: "approved",
        })
        .select();
      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping content-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
