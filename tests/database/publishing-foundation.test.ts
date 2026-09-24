import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PUBLISH_OUTCOME_UNKNOWN_ERROR_CODE, schedulePublication } from "@/server/services/publications";
import type { Database } from "@/types/database";

import { cleanupTestData, createSignedInTestUser, hasLocalSupabase, serviceRoleClient } from "./helpers";
import { setTestAccessToken } from "../mocks/session-context";

/**
 * MVP-5.35B — Publishing Domain + Idempotency Foundation
 * (20260923120000_publishing_foundation.sql):
 *   - marqos_content_variant_assets: ordered, tenant-safe variant → asset selection
 *   - publication_attempts: provider checkpoint/audit record
 *   - enforce_publication_scheduling_transitions (+ schedulePublication parity): H2 guard
 *
 * Requires a running local Supabase stack. Skipped automatically otherwise.
 */
describe.skipIf(!hasLocalSupabase)("Publishing foundation (MVP-5.35B)", () => {
  const admin = hasLocalSupabase ? serviceRoleClient() : null!;

  let editor: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let outsider: Awaited<ReturnType<typeof createSignedInTestUser>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let contentId: string;
  let variantId: string;
  let accountId: string;
  let otherAssetId: string;

  async function createAsset(wsId: string, client = editor.client, mime = "image/jpeg"): Promise<string> {
    const { data, error } = await client
      .from("marqos_assets")
      .insert({
        workspace_id: wsId,
        storage_path: `${wsId}/${crypto.randomUUID()}.jpg`,
        file_name: "fixture.jpg",
        mime_type: mime,
        asset_type: "image",
        file_size: 1024,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to create asset fixture: ${error?.message}`);
    return data.id;
  }

  async function createApprovedVariant(): Promise<string> {
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
    if (versionError || !version) throw new Error(`Failed to create version: ${versionError?.message}`);
    const { data: variant, error: variantError } = await editor.client
      .from("content_variants")
      .insert({ content_version_id: version.id, workspace_id: workspaceId, platform: "instagram", format: "image" })
      .select()
      .single();
    if (variantError || !variant) throw new Error(`Failed to create variant: ${variantError?.message}`);
    const { error: approvalError } = await admin.from("content_approvals").insert({
      workspace_id: workspaceId,
      content_id: contentId,
      content_version_id: version.id,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });
    if (approvalError) throw new Error(`Failed to approve: ${approvalError.message}`);
    return variant.id;
  }

  async function scheduledPublication(): Promise<string> {
    const { data, error } = await admin
      .from("publications")
      .insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: accountId,
        status: "scheduled",
        scheduled_at: new Date().toISOString(),
        idempotency_key: crypto.randomUUID(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`Failed to create publication: ${error?.message}`);
    return data.id;
  }

  async function setStatus(id: string, fields: Database["public"]["Tables"]["publications"]["Update"]) {
    return admin.from("publications").update(fields).eq("id", id).select().single();
  }

  async function publishingPublication(): Promise<string> {
    const id = await scheduledPublication();
    const { error } = await setStatus(id, { status: "publishing" });
    if (error) throw new Error(`Failed to move to publishing: ${error.message}`);
    return id;
  }

  async function signInAs(user: Awaited<ReturnType<typeof createSignedInTestUser>>) {
    const {
      data: { session },
    } = await user.client.auth.getSession();
    setTestAccessToken(session!.access_token);
  }

  beforeAll(async () => {
    editor = await createSignedInTestUser(admin);
    outsider = await createSignedInTestUser(admin);

    const { data: ws, error } = await editor.client.rpc("create_workspace", {
      p_name: "Publishing Foundation A",
      p_slug: `pub-foundation-a-${Date.now()}`,
    });
    if (error || !ws) throw new Error(`workspace A: ${error?.message}`);
    workspaceId = ws.id;

    const { data: other, error: otherError } = await outsider.client.rpc("create_workspace", {
      p_name: "Publishing Foundation B",
      p_slug: `pub-foundation-b-${Date.now()}`,
    });
    if (otherError || !other) throw new Error(`workspace B: ${otherError?.message}`);
    otherWorkspaceId = other.id;

    const { data: brand } = await editor.client.from("brands").insert({ workspace_id: workspaceId, name: "B" }).select().single();
    const { data: content, error: contentError } = await editor.client
      .from("content")
      .insert({ workspace_id: workspaceId, brand_id: brand!.id, title: "Publishing foundation content" })
      .select()
      .single();
    if (contentError || !content) throw new Error(`content: ${contentError?.message}`);
    contentId = content.id;

    variantId = await createApprovedVariant();

    const { data: account, error: accountError } = await editor.client
      .from("social_accounts")
      .insert({ workspace_id: workspaceId, platform: "instagram", external_account_id: `pf-${Date.now()}`, account_name: "PF" })
      .select()
      .single();
    if (accountError || !account) throw new Error(`account: ${accountError?.message}`);
    accountId = account.id;

    otherAssetId = await createAsset(otherWorkspaceId, outsider.client);
  });

  afterEach(() => setTestAccessToken(null));

  afterAll(async () => {
    await cleanupTestData(admin, {
      workspaceIds: [workspaceId, otherWorkspaceId].filter(Boolean),
      userIds: [editor?.userId, outsider?.userId].filter((id): id is string => Boolean(id)),
    });
  });

  // ---------------------------------------------------------------------------
  // marqos_content_variant_assets
  // ---------------------------------------------------------------------------

  describe("marqos_content_variant_assets", () => {
    it("binds same-workspace assets to a variant and returns them in explicit order", async () => {
      const a = await createAsset(workspaceId);
      const b = await createAsset(workspaceId);
      const c = await createAsset(workspaceId);
      const v = await createApprovedVariant();
      const { error } = await editor.client.from("marqos_content_variant_assets").insert([
        { content_variant_id: v, asset_id: b, workspace_id: workspaceId, sort_order: 2 },
        { content_variant_id: v, asset_id: c, workspace_id: workspaceId, sort_order: 0 },
        { content_variant_id: v, asset_id: a, workspace_id: workspaceId, sort_order: 1 },
      ]);
      expect(error).toBeNull();

      const { data } = await editor.client
        .from("marqos_content_variant_assets")
        .select("asset_id, sort_order")
        .eq("content_variant_id", v)
        .order("sort_order");
      expect(data!.map((row) => row.asset_id)).toEqual([c, a, b]);
    });

    it("rejects the same asset twice and two assets at the same position", async () => {
      const a = await createAsset(workspaceId);
      const b = await createAsset(workspaceId);
      const v = await createApprovedVariant();
      await editor.client.from("marqos_content_variant_assets").insert({ content_variant_id: v, asset_id: a, workspace_id: workspaceId, sort_order: 0 });

      const dupAsset = await editor.client
        .from("marqos_content_variant_assets")
        .insert({ content_variant_id: v, asset_id: a, workspace_id: workspaceId, sort_order: 1 });
      expect(dupAsset.error?.code).toBe("23505");

      const dupOrder = await editor.client
        .from("marqos_content_variant_assets")
        .insert({ content_variant_id: v, asset_id: b, workspace_id: workspaceId, sort_order: 0 });
      expect(dupOrder.error?.code).toBe("23505");

      const negative = await editor.client
        .from("marqos_content_variant_assets")
        .insert({ content_variant_id: v, asset_id: b, workspace_id: workspaceId, sort_order: -1 });
      expect(negative.error?.code).toBe("23514");
    });

    it("rejects a cross-workspace asset even through the privileged service role", async () => {
      const { error } = await admin
        .from("marqos_content_variant_assets")
        .insert({ content_variant_id: variantId, asset_id: otherAssetId, workspace_id: workspaceId, sort_order: 9 });
      expect(error?.code).toBe("23503");
    });

    it("tenant isolation: outsiders can neither read nor write another workspace's bindings", async () => {
      const a = await createAsset(workspaceId);
      const v = await createApprovedVariant();
      await editor.client.from("marqos_content_variant_assets").insert({ content_variant_id: v, asset_id: a, workspace_id: workspaceId, sort_order: 0 });

      const { data: seen } = await outsider.client.from("marqos_content_variant_assets").select("asset_id").eq("content_variant_id", v);
      expect(seen).toEqual([]);

      const write = await outsider.client
        .from("marqos_content_variant_assets")
        .insert({ content_variant_id: v, asset_id: a, workspace_id: workspaceId, sort_order: 1 });
      expect(write.error).not.toBeNull();
    });

    it("leaves content-level bindings (marqos_content_assets) untouched and independent", async () => {
      const a = await createAsset(workspaceId);
      const v = await createApprovedVariant();
      const { error: contentLevelError } = await editor.client
        .from("marqos_content_assets")
        .insert({ content_id: contentId, asset_id: a, workspace_id: workspaceId, role: "library", sort_order: 0 });
      expect(contentLevelError).toBeNull();

      await editor.client.from("marqos_content_variant_assets").insert({ content_variant_id: v, asset_id: a, workspace_id: workspaceId, sort_order: 0 });
      await editor.client.from("marqos_content_variant_assets").delete().eq("content_variant_id", v).eq("asset_id", a);

      const { data } = await editor.client.from("marqos_content_assets").select("asset_id, role").eq("content_id", contentId).eq("asset_id", a);
      expect(data).toEqual([{ asset_id: a, role: "library" }]);
    });
  });

  // ---------------------------------------------------------------------------
  // publication_attempts
  // ---------------------------------------------------------------------------

  describe("publication_attempts", () => {
    it("creates an attempt for a publishing publication with a trigger-assigned number", async () => {
      const publicationId = await publishingPublication();
      const { data, error } = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram", attempt_number: 99 })
        .select()
        .single();
      expect(error).toBeNull();
      expect(data!.attempt_number).toBe(1);
      expect(data!.stage).toBe("validating");
      expect(data!.completed_at).toBeNull();
    });

    it("refuses to start an attempt unless the publication is publishing", async () => {
      const publicationId = await scheduledPublication();
      const { error } = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram" });
      expect(error?.message).toMatch(/expected publishing/);
    });

    it("allows only one non-terminal attempt, numbers attempts deterministically, and keeps terminal history", async () => {
      const publicationId = await publishingPublication();
      const first = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram" })
        .select()
        .single();
      expect(first.error).toBeNull();

      const concurrent = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram" });
      expect(concurrent.error?.code).toBe("23505");

      const failed = await admin
        .from("publication_attempts")
        .update({ stage: "failed", error_code: "container_create", error_message: "fixture" })
        .eq("id", first.data!.id)
        .select()
        .single();
      expect(failed.error).toBeNull();
      expect(failed.data!.completed_at).not.toBeNull();

      const second = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram" })
        .select()
        .single();
      expect(second.error).toBeNull();
      expect(second.data!.attempt_number).toBe(2);

      const { data: history } = await admin
        .from("publication_attempts")
        .select("attempt_number, stage")
        .eq("publication_id", publicationId)
        .order("attempt_number");
      expect(history).toEqual([
        { attempt_number: 1, stage: "failed" },
        { attempt_number: 2, stage: "validating" },
      ]);
    });

    it("terminal attempts are immutable, published requires a media id, and nothing can hard-delete an attempt", async () => {
      const publicationId = await publishingPublication();
      const { data: attempt } = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram" })
        .select()
        .single();

      const noMediaId = await admin.from("publication_attempts").update({ stage: "published" }).eq("id", attempt!.id);
      expect(noMediaId.error?.code).toBe("23514");

      const published = await admin
        .from("publication_attempts")
        .update({ stage: "published", external_media_id: "fixture-media-1", container_ids: ["c-1"] })
        .eq("id", attempt!.id)
        .select()
        .single();
      expect(published.error).toBeNull();

      const rewrite = await admin.from("publication_attempts").update({ external_media_id: "tampered" }).eq("id", attempt!.id);
      expect(rewrite.error?.message).toMatch(/terminal/);

      const serviceDelete = await admin.from("publication_attempts").delete().eq("id", attempt!.id);
      expect(serviceDelete.error).not.toBeNull();

      const { data: still } = await admin.from("publication_attempts").select("external_media_id").eq("id", attempt!.id).single();
      expect(still!.external_media_id).toBe("fixture-media-1");
    });

    it("members can read attempts; members cannot write them; outsiders see nothing", async () => {
      const publicationId = await publishingPublication();
      const { data: attempt } = await admin
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram" })
        .select()
        .single();

      const { data: memberView } = await editor.client.from("publication_attempts").select("id").eq("id", attempt!.id);
      expect(memberView).toEqual([{ id: attempt!.id }]);

      const memberInsert = await editor.client
        .from("publication_attempts")
        .insert({ workspace_id: workspaceId, publication_id: publicationId, provider: "instagram" });
      expect(memberInsert.error).not.toBeNull();

      const memberUpdate = await editor.client.from("publication_attempts").update({ stage: "failed" }).eq("id", attempt!.id).select();
      expect(memberUpdate.error ?? (memberUpdate.data?.length === 0 ? "no rows" : null)).not.toBeNull();

      const memberDelete = await editor.client.from("publication_attempts").delete().eq("id", attempt!.id).select();
      expect(memberDelete.error ?? (memberDelete.data?.length === 0 ? "no rows" : null)).not.toBeNull();

      const { data: outsiderView } = await outsider.client.from("publication_attempts").select("id").eq("id", attempt!.id);
      expect(outsiderView).toEqual([]);

      const { data: unchanged } = await admin.from("publication_attempts").select("stage").eq("id", attempt!.id).single();
      expect(unchanged!.stage).toBe("validating");
    });

    it("leaves enforce_publication_lifecycle_transitions unchanged", async () => {
      const publicationId = await publishingPublication();
      const samePublishing = await setStatus(publicationId, { status: "publishing" });
      expect(samePublishing.error?.message).toMatch(/only scheduled -> publishing/);
      const updateWhilePublishing = await setStatus(publicationId, { provider_response: { note: "checkpoint" } });
      expect(updateWhilePublishing.error?.message).toMatch(/only scheduled -> publishing/);

      const directPublished = await admin.from("publications").insert({
        workspace_id: workspaceId,
        content_variant_id: variantId,
        social_account_id: accountId,
        status: "published",
        idempotency_key: crypto.randomUUID(),
      });
      expect(directPublished.error?.message).toMatch(/must transition from publishing/);
    });
  });

  // ---------------------------------------------------------------------------
  // Scheduling guard (H2) — DB layer, privileged path
  // ---------------------------------------------------------------------------

  describe("enforce_publication_scheduling_transitions (service-role path)", () => {
    it("rejects published → scheduled", async () => {
      const id = await publishingPublication();
      await setStatus(id, { status: "published", external_publication_id: "fixture-media", published_at: new Date().toISOString() });
      const { error } = await setStatus(id, { status: "scheduled" });
      expect(error?.message).toMatch(/Cannot transition publication .* to scheduled from published/);
    });

    it("rejects publishing → scheduled", async () => {
      const id = await publishingPublication();
      const { error } = await setStatus(id, { status: "scheduled" });
      expect(error?.message).toMatch(/to scheduled from publishing/);
    });

    it("rejects cancelled → scheduled", async () => {
      const id = await scheduledPublication();
      await setStatus(id, { status: "cancelled" });
      const { error } = await setStatus(id, { status: "scheduled" });
      expect(error?.message).toMatch(/to scheduled from cancelled/);
    });

    it("rejects failed(publish_outcome_unknown) → scheduled but allows failed(certain) → scheduled", async () => {
      const unknown = await publishingPublication();
      await setStatus(unknown, { status: "failed", error_code: PUBLISH_OUTCOME_UNKNOWN_ERROR_CODE, error_message: "timeout" });
      const blocked = await setStatus(unknown, { status: "scheduled" });
      expect(blocked.error?.message).toMatch(/outcome is unknown/);

      const certain = await publishingPublication();
      await setStatus(certain, { status: "failed", error_code: "container_create", error_message: "bad image" });
      const allowed = await setStatus(certain, { status: "scheduled", scheduled_at: new Date().toISOString() });
      expect(allowed.error).toBeNull();
      expect(allowed.data!.status).toBe("scheduled");
    });

    it("rejects rescheduling while a publish attempt is still open", async () => {
      const id = await publishingPublication();
      await admin.from("publication_attempts").insert({ workspace_id: workspaceId, publication_id: id, provider: "instagram" });
      await setStatus(id, { status: "failed", error_code: "container_create", error_message: "fixture" });
      const { error } = await setStatus(id, { status: "scheduled" });
      expect(error?.message).toMatch(/attempt is still open/);
    });

    it("still allows scheduled → scheduled (reschedule) and draft → scheduled", async () => {
      const id = await scheduledPublication();
      const reschedule = await setStatus(id, { status: "scheduled", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() });
      expect(reschedule.error).toBeNull();

      const { data: draft } = await admin
        .from("publications")
        .insert({ workspace_id: workspaceId, content_variant_id: variantId, social_account_id: accountId, idempotency_key: crypto.randomUUID() })
        .select()
        .single();
      const fromDraft = await setStatus(draft!.id, { status: "scheduled", scheduled_at: new Date().toISOString() });
      expect(fromDraft.error).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Scheduling guard (H2) — service layer parity
  // ---------------------------------------------------------------------------

  describe("schedulePublication service guard", () => {
    it("rejects scheduling a published publication before reaching the database", async () => {
      const id = await publishingPublication();
      await setStatus(id, { status: "published", external_publication_id: "fixture-media-2", published_at: new Date().toISOString() });
      await signInAs(editor);
      await expect(schedulePublication(workspaceId, id, new Date().toISOString())).rejects.toThrow(
        /status 'published' cannot be scheduled/,
      );
    });

    it("rejects scheduling a failed publication whose outcome is unknown", async () => {
      const id = await publishingPublication();
      await setStatus(id, { status: "failed", error_code: PUBLISH_OUTCOME_UNKNOWN_ERROR_CODE, error_message: "timeout" });
      await signInAs(editor);
      await expect(schedulePublication(workspaceId, id, new Date().toISOString())).rejects.toThrow(/must be reconciled/);
    });

    it("allows retry-scheduling a failed publication whose outcome is certain", async () => {
      const id = await publishingPublication();
      await setStatus(id, { status: "failed", error_code: "container_create", error_message: "bad image" });
      await signInAs(editor);
      const result = await schedulePublication(workspaceId, id, new Date().toISOString());
      expect(result.status).toBe("scheduled");
    });
  });
});
