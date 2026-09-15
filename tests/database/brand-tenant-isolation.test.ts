import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTestData,
  createSignedInTestUser,
  hasLocalSupabase,
  serviceRoleClient,
} from "./helpers";

/**
 * RLS / tenant isolation tests for the MVP-1.1 Brand domain migration
 * (brands, brand_identity, brand_voice, audience_profiles, content_pillars),
 * per Engineering Blueprint §24 and Database Architecture §20: every
 * exposed workspace-scoped table must prove (a) an authenticated member of
 * the owning workspace can perform the operations their role permits, and
 * (b) an authenticated non-member is denied access entirely.
 *
 * Also covers the write-role split introduced by this migration
 * (owner/admin/marketer may write, viewer is read-only — the one explicit
 * rule in Database Architecture §20) and the composite tenant-consistency
 * foreign keys from Database Architecture §16, which must reject a
 * cross-workspace (brand_id, workspace_id) pairing independently of RLS.
 *
 * Requires a running local Supabase stack (`npm run db:start`). Skipped
 * automatically otherwise, with a console warning, so `npm test` stays
 * green in environments without Docker.
 */
describe.skipIf(!hasLocalSupabase)("Brand domain RLS — tenant isolation", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let owner: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let viewer: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let brandId: string;

  beforeAll(async () => {
    owner = await createSignedInTestUser(admin);
    viewer = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: workspace, error } = await owner.client.rpc("create_workspace", {
      p_name: "Brand Tenant A",
      p_slug: `brand-tenant-a-${Date.now()}`,
    });
    if (error || !workspace) {
      throw new Error(`Failed to create workspace fixture: ${error?.message}`);
    }
    workspaceId = workspace.id;

    // outsider owns a second, unrelated workspace — used both as a plain
    // non-member of workspace A and as the "editor of a different
    // workspace" actor for the composite-FK cross-tenant test.
    const { data: otherWorkspace, error: otherError } = await outsider.client.rpc(
      "create_workspace",
      { p_name: "Brand Tenant B", p_slug: `brand-tenant-b-${Date.now()}` },
    );
    if (otherError || !otherWorkspace) {
      throw new Error(`Failed to create second workspace fixture: ${otherError?.message}`);
    }
    otherWorkspaceId = otherWorkspace.id;

    // viewer joins workspace A with role = 'viewer' (read-only). Direct
    // membership insert requires admin+, so this goes through the service
    // role rather than a client RPC — there is no self-service "join as
    // viewer" path, by design (Foundation).
    const { error: memberError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: viewer.userId, role: "viewer" });
    if (memberError) {
      throw new Error(`Failed to add viewer to workspace: ${memberError.message}`);
    }

    // Seed one brand as the owner (an editor) for the read/cross-tenant
    // fixtures used across the describe blocks below.
    const { data: brand, error: brandError } = await owner.client
      .from("brands")
      .insert({ workspace_id: workspaceId, name: "Fixture Brand" })
      .select()
      .single();
    if (brandError || !brand) {
      throw new Error(`Failed to create brand fixture: ${brandError?.message}`);
    }
    brandId = brand.id;
  });

  afterAll(async () => {
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [owner?.userId, viewer?.userId, outsider?.userId].filter((id): id is string =>
        Boolean(id),
      ),
    });
  });

  describe("brands", () => {
    it("allows a member (any role) to read a brand in their workspace", async () => {
      const { data, error } = await viewer.client
        .from("brands")
        .select("*")
        .eq("id", brandId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.id).toBe(brandId);
    });

    it("hides the brand from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("brands")
        .select("*")
        .eq("id", brandId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("allows an editor (owner/admin/marketer) to insert a brand", async () => {
      const { data, error } = await owner.client
        .from("brands")
        .insert({ workspace_id: workspaceId, name: "Editor-created Brand" })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.name).toBe("Editor-created Brand");
    });

    it("denies a viewer from inserting a brand", async () => {
      const { data, error } = await viewer.client
        .from("brands")
        .insert({ workspace_id: workspaceId, name: "Viewer-attempted Brand" })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("denies a non-member from inserting a brand into someone else's workspace", async () => {
      const { data, error } = await outsider.client
        .from("brands")
        .insert({ workspace_id: workspaceId, name: "Outsider-attempted Brand" })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to update a brand's status (archive)", async () => {
      const { data, error } = await owner.client
        .from("brands")
        .update({ status: "archived" })
        .eq("id", brandId)
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.status).toBe("archived");

      // restore for subsequent tests/fixtures
      await owner.client.from("brands").update({ status: "active" }).eq("id", brandId);
    });

    it("denies a viewer from updating a brand", async () => {
      const { data, error } = await viewer.client
        .from("brands")
        .update({ name: "Hijacked" })
        .eq("id", brandId)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("has no DELETE grant/policy: even an editor cannot hard-delete a brand", async () => {
      const { error } = await owner.client.from("brands").delete().eq("id", brandId).select();

      // No DELETE grant for `authenticated` on brands (and no DELETE
      // policy either) — the operation is rejected outright, not merely
      // filtered to zero rows. Archive via status update is the supported
      // path (Database Architecture §19, mirroring the workspaces
      // precedent).
      expect(error).not.toBeNull();

      const { data: stillThere } = await admin.from("brands").select("id").eq("id", brandId).single();
      expect(stillThere?.id).toBe(brandId);
    });
  });

  describe("brand_identity", () => {
    let identityId: string;

    it("allows an editor to insert brand_identity for their brand", async () => {
      const { data, error } = await owner.client
        .from("brand_identity")
        .insert({
          brand_id: brandId,
          workspace_id: workspaceId,
          primary_colors: { hex: "#000000" },
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.brand_id).toBe(brandId);
      identityId = data!.id;
    });

    it("allows a member to read brand_identity in their workspace", async () => {
      const { data, error } = await viewer.client
        .from("brand_identity")
        .select("*")
        .eq("id", identityId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.id).toBe(identityId);
    });

    it("hides brand_identity from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("brand_identity")
        .select("*")
        .eq("id", identityId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting brand_identity", async () => {
      const { data, error } = await viewer.client
        .from("brand_identity")
        .insert({ brand_id: brandId, workspace_id: workspaceId })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace (brand_id, workspace_id) pairing via composite FK, even for an editor of the pairing's workspace", async () => {
      // outsider is an editor (owner) of otherWorkspaceId, so the RLS
      // insert-check `is_workspace_editor(workspace_id)` passes — but
      // brandId only exists paired with workspaceId in `brands`, so the
      // composite FK (brand_id, workspace_id) -> brands(id, workspace_id)
      // must reject this independently of RLS (Database Architecture §16).
      const { data, error } = await outsider.client
        .from("brand_identity")
        .insert({ brand_id: brandId, workspace_id: otherWorkspaceId })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("denies a non-member from writing brand_identity even with a valid (brand_id, workspace_id) pairing", async () => {
      const { data, error } = await outsider.client
        .from("brand_identity")
        .insert({ brand_id: brandId, workspace_id: workspaceId })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to delete brand_identity", async () => {
      const { data, error } = await owner.client
        .from("brand_identity")
        .delete()
        .eq("id", identityId)
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });
  });

  describe("brand_voice", () => {
    let voiceId: string;

    it("allows an editor to insert brand_voice for their brand", async () => {
      const { data, error } = await owner.client
        .from("brand_voice")
        .insert({ brand_id: brandId, workspace_id: workspaceId, tone: "confident" })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.tone).toBe("confident");
      voiceId = data!.id;
    });

    it("allows a member to read brand_voice in their workspace", async () => {
      const { data, error } = await viewer.client
        .from("brand_voice")
        .select("*")
        .eq("id", voiceId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.id).toBe(voiceId);
    });

    it("hides brand_voice from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("brand_voice")
        .select("*")
        .eq("id", voiceId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from updating brand_voice", async () => {
      const { data, error } = await viewer.client
        .from("brand_voice")
        .update({ tone: "hijacked" })
        .eq("id", voiceId)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("rejects a cross-workspace (brand_id, workspace_id) pairing via composite FK", async () => {
      const { data, error } = await outsider.client
        .from("brand_voice")
        .insert({ brand_id: brandId, workspace_id: otherWorkspaceId })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to delete brand_voice", async () => {
      const { data, error } = await owner.client.from("brand_voice").delete().eq("id", voiceId).select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });
  });

  describe("audience_profiles", () => {
    let profileId: string;

    it("allows an editor to insert an audience_profile", async () => {
      const { data, error } = await owner.client
        .from("audience_profiles")
        .insert({ brand_id: brandId, workspace_id: workspaceId, name: "Early adopters" })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.name).toBe("Early adopters");
      profileId = data!.id;
    });

    it("allows a member to read audience_profiles in their workspace", async () => {
      const { data, error } = await viewer.client
        .from("audience_profiles")
        .select("*")
        .eq("id", profileId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.id).toBe(profileId);
    });

    it("hides audience_profiles from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("audience_profiles")
        .select("*")
        .eq("id", profileId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from inserting an audience_profile", async () => {
      const { data, error } = await viewer.client
        .from("audience_profiles")
        .insert({ brand_id: brandId, workspace_id: workspaceId, name: "Viewer-attempted" })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("rejects a cross-workspace (brand_id, workspace_id) pairing via composite FK", async () => {
      const { data, error } = await outsider.client
        .from("audience_profiles")
        .insert({ brand_id: brandId, workspace_id: otherWorkspaceId, name: "Cross-tenant" })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("denies a non-member from deleting an audience_profile", async () => {
      const { data, error } = await outsider.client
        .from("audience_profiles")
        .delete()
        .eq("id", profileId)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("allows an editor to delete an audience_profile", async () => {
      const { data, error } = await owner.client
        .from("audience_profiles")
        .delete()
        .eq("id", profileId)
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });
  });

  describe("content_pillars", () => {
    let pillarId: string;

    it("allows an editor to insert a content_pillar", async () => {
      const { data, error } = await owner.client
        .from("content_pillars")
        .insert({ brand_id: brandId, workspace_id: workspaceId, name: "Product education", priority: 1 })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data?.name).toBe("Product education");
      pillarId = data!.id;
    });

    it("allows a member to read content_pillars in their workspace", async () => {
      const { data, error } = await viewer.client
        .from("content_pillars")
        .select("*")
        .eq("id", pillarId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data?.id).toBe(pillarId);
    });

    it("hides content_pillars from a non-member", async () => {
      const { data, error } = await outsider.client
        .from("content_pillars")
        .select("*")
        .eq("id", pillarId)
        .maybeSingle();

      expect(error).toBeNull();
      expect(data).toBeNull();
    });

    it("denies a viewer from updating a content_pillar", async () => {
      const { data, error } = await viewer.client
        .from("content_pillars")
        .update({ priority: 99 })
        .eq("id", pillarId)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("rejects a cross-workspace (brand_id, workspace_id) pairing via composite FK, even for an editor of the pairing's workspace", async () => {
      const { data, error } = await outsider.client
        .from("content_pillars")
        .insert({ brand_id: brandId, workspace_id: otherWorkspaceId, name: "Cross-tenant pillar" })
        .select();

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it("allows an editor to delete a content_pillar", async () => {
      const { data, error } = await owner.client
        .from("content_pillars")
        .delete()
        .eq("id", pillarId)
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });
  });
});

if (!hasLocalSupabase) {
  console.warn(
    "[tests/database] Skipping brand-tenant-isolation.test.ts: local Supabase env vars not set. Run `npm run db:start` and populate .env.local first.",
  );
}
