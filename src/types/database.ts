/**
 * Hand-authored types for the MVP-0 Foundation, MVP-1.1 Brand, and MVP-1.2
 * Content schema.
 *
 * These cover only the tables/enums/functions introduced by
 * `supabase/migrations/20260915063156_foundation.sql`,
 * `20260915063158_storage_foundation.sql`,
 * `20260915153033_brand.sql`, and `20260915154503_content.sql`. Once a live
 * Supabase project exists, prefer replacing this file with the output of
 * `supabase gen types typescript` and extending it per-migration.
 *
 * content_versions.ai_job_id and assets.ai_job_id are intentionally absent
 * (deferred until the AI domain exists — see 20260915154503_content.sql's
 * header comment). Add them here when that migration lands.
 *
 * Shape follows @supabase/postgrest-js's `GenericSchema` contract
 * (Tables need Row/Insert/Update/Relationships, Functions need
 * Args/Returns) — deviating from it silently degrades every `.from()`/
 * `.rpc()` call on this client to `never`, with no type error at the
 * `createClient<Database>()` call site itself.
 *
 * Row/Insert/Update types below are declared with `type`, not
 * `interface`: TypeScript's structural `extends Record<string, unknown>`
 * check (which `GenericTable` relies on) only succeeds for object type
 * aliases, not for `interface` declarations, even though both describe
 * the same shape.
 */

export type WorkspaceRole = "owner" | "admin" | "marketer" | "viewer";

export type Profile = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkspaceMember = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
};

export type AuditLog = {
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type BrandStatus = "active" | "archived";

export type Brand = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  website_url: string | null;
  status: BrandStatus;
  created_at: string;
  updated_at: string;
};

export type BrandIdentity = {
  id: string;
  brand_id: string;
  workspace_id: string;
  primary_colors: Record<string, unknown> | null;
  secondary_colors: Record<string, unknown> | null;
  typography: Record<string, unknown> | null;
  visual_guidelines: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type BrandVoice = {
  id: string;
  brand_id: string;
  workspace_id: string;
  tone: string | null;
  personality: string | null;
  preferred_terms: Record<string, unknown> | null;
  avoid_terms: Record<string, unknown> | null;
  writing_guidelines: string | null;
  example_copy: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type AudienceProfile = {
  id: string;
  brand_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  demographics: Record<string, unknown> | null;
  needs: Record<string, unknown> | null;
  pain_points: Record<string, unknown> | null;
  motivations: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type ContentPillar = {
  id: string;
  brand_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  priority: number | null;
  created_at: string;
  updated_at: string;
};

export type ContentBriefStatus = "draft" | "ready" | "in_progress" | "fulfilled" | "archived";

export type ContentBrief = {
  id: string;
  workspace_id: string;
  brand_id: string;
  audience_profile_id: string | null;
  content_pillar_id: string | null;
  title: string;
  objective: string | null;
  angle: string | null;
  core_message: string | null;
  cta: string | null;
  format: string | null;
  platform_intent: Record<string, unknown> | null;
  creative_direction: Record<string, unknown> | null;
  status: ContentBriefStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ContentStatus = "draft" | "in_review" | "approved" | "changes_requested" | "archived";

export type Content = {
  id: string;
  workspace_id: string;
  brand_id: string;
  brief_id: string | null;
  title: string;
  content_type: string | null;
  status: ContentStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type ContentVersion = {
  id: string;
  content_id: string;
  workspace_id: string;
  version_number: number;
  source_version_id: string | null;
  generation_method: string;
  content_payload: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
};

export type ContentVariantStatus = "draft" | "ready" | "approved" | "archived";

export type ContentVariant = {
  id: string;
  content_version_id: string;
  workspace_id: string;
  platform: string | null;
  format: string | null;
  caption: string | null;
  copy_payload: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  status: ContentVariantStatus;
  created_at: string;
  updated_at: string;
};

export type AssetType = "image" | "video" | "audio" | "document" | "other";

export type Asset = {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  asset_type: AssetType;
  file_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  checksum: string | null;
  metadata: Record<string, unknown> | null;
  source_asset_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type ContentAsset = {
  content_id: string;
  asset_id: string;
  workspace_id: string;
  role: string | null;
  sort_order: number | null;
  created_at: string;
};

export type ContentApprovalStatus = "pending" | "approved" | "changes_requested" | "rejected";

export type ContentApproval = {
  id: string;
  workspace_id: string;
  content_id: string;
  content_version_id: string | null;
  status: ContentApprovalStatus;
  comment: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
};

export type SocialPlatform = "instagram" | "tiktok" | "youtube" | "threads";

export type SocialAccountStatus = "connected" | "disconnected" | "expired" | "revoked" | "error";

export type SocialAccount = {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  platform: SocialPlatform;
  external_account_id: string;
  account_name: string;
  account_handle: string | null;
  status: SocialAccountStatus;
  vault_secret_id: string | null;
  metadata: Record<string, unknown>;
  connected_at: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & Pick<Profile, "id">;
        Update: Partial<Pick<Profile, "display_name" | "avatar_url">>;
        Relationships: [];
      };
      workspaces: {
        Row: Workspace;
        Insert: Partial<Workspace> & Pick<Workspace, "name" | "slug" | "owner_id">;
        Update: Partial<Pick<Workspace, "name" | "archived_at">>;
        Relationships: [];
      };
      workspace_members: {
        Row: WorkspaceMember;
        Insert: Partial<WorkspaceMember> &
          Pick<WorkspaceMember, "workspace_id" | "user_id" | "role">;
        Update: Partial<Pick<WorkspaceMember, "role">>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Partial<AuditLog> & Pick<AuditLog, "workspace_id" | "action" | "entity_type">;
        Update: Partial<AuditLog>;
        Relationships: [];
      };
      brands: {
        Row: Brand;
        Insert: Partial<Brand> & Pick<Brand, "workspace_id" | "name">;
        Update: Partial<Pick<Brand, "name" | "description" | "website_url" | "status">>;
        Relationships: [];
      };
      brand_identity: {
        Row: BrandIdentity;
        Insert: Partial<BrandIdentity> & Pick<BrandIdentity, "brand_id" | "workspace_id">;
        Update: Partial<
          Pick<BrandIdentity, "primary_colors" | "secondary_colors" | "typography" | "visual_guidelines">
        >;
        Relationships: [];
      };
      brand_voice: {
        Row: BrandVoice;
        Insert: Partial<BrandVoice> & Pick<BrandVoice, "brand_id" | "workspace_id">;
        Update: Partial<
          Pick<
            BrandVoice,
            | "tone"
            | "personality"
            | "preferred_terms"
            | "avoid_terms"
            | "writing_guidelines"
            | "example_copy"
          >
        >;
        Relationships: [];
      };
      audience_profiles: {
        Row: AudienceProfile;
        Insert: Partial<AudienceProfile> &
          Pick<AudienceProfile, "brand_id" | "workspace_id" | "name">;
        Update: Partial<
          Pick<AudienceProfile, "name" | "description" | "demographics" | "needs" | "pain_points" | "motivations">
        >;
        Relationships: [];
      };
      content_pillars: {
        Row: ContentPillar;
        Insert: Partial<ContentPillar> & Pick<ContentPillar, "brand_id" | "workspace_id" | "name">;
        Update: Partial<Pick<ContentPillar, "name" | "description" | "priority">>;
        Relationships: [];
      };
      content_briefs: {
        Row: ContentBrief;
        Insert: Partial<ContentBrief> & Pick<ContentBrief, "workspace_id" | "brand_id" | "title">;
        Update: Partial<
          Pick<
            ContentBrief,
            | "title"
            | "objective"
            | "angle"
            | "core_message"
            | "cta"
            | "format"
            | "platform_intent"
            | "creative_direction"
            | "status"
            | "audience_profile_id"
            | "content_pillar_id"
          >
        >;
        Relationships: [];
      };
      content: {
        Row: Content;
        Insert: Partial<Content> & Pick<Content, "workspace_id" | "brand_id" | "title">;
        Update: Partial<Pick<Content, "title" | "content_type" | "status" | "brief_id" | "archived_at">>;
        Relationships: [];
      };
      content_versions: {
        Row: ContentVersion;
        Insert: Partial<ContentVersion> &
          Pick<ContentVersion, "content_id" | "workspace_id" | "version_number" | "generation_method" | "content_payload">;
        // Immutable — no UPDATE policy/grant exists (Database Architecture §5/§20).
        Update: Record<string, never>;
        Relationships: [];
      };
      content_variants: {
        Row: ContentVariant;
        Insert: Partial<ContentVariant> & Pick<ContentVariant, "content_version_id" | "workspace_id">;
        Update: Partial<
          Pick<ContentVariant, "platform" | "format" | "caption" | "copy_payload" | "metadata" | "status">
        >;
        Relationships: [];
      };
      assets: {
        Row: Asset;
        Insert: Partial<Asset> &
          Pick<Asset, "workspace_id" | "storage_path" | "file_name" | "mime_type" | "asset_type" | "file_size">;
        Update: Partial<
          Pick<Asset, "brand_id" | "file_name" | "metadata" | "archived_at" | "width" | "height" | "duration_ms" | "checksum">
        >;
        Relationships: [];
      };
      content_assets: {
        Row: ContentAsset;
        Insert: Partial<ContentAsset> & Pick<ContentAsset, "content_id" | "asset_id" | "workspace_id">;
        Update: Partial<Pick<ContentAsset, "role" | "sort_order">>;
        Relationships: [];
      };
      content_approvals: {
        Row: ContentApproval;
        Insert: Partial<ContentApproval> & Pick<ContentApproval, "workspace_id" | "content_id">;
        // Append-only — no UPDATE policy/grant exists (Database Architecture §7/§19).
        Update: Record<string, never>;
        Relationships: [];
      };
      social_accounts: {
        Row: SocialAccount;
        Insert: Partial<SocialAccount> &
          Pick<SocialAccount, "workspace_id" | "platform" | "external_account_id" | "account_name">;
        Update: Partial<
          Pick<
            SocialAccount,
            | "account_name"
            | "account_handle"
            | "status"
            | "vault_secret_id"
            | "metadata"
            | "last_synced_at"
            | "brand_id"
            | "connected_at"
          >
        >;
        // No DELETE policy/grant exists — disconnect is a status change (Database Architecture §19).
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_workspace: {
        Args: { p_name: string; p_slug: string };
        Returns: Workspace;
      };
      log_audit_event: {
        Args: {
          p_workspace_id: string;
          p_action: string;
          p_entity_type: string;
          p_entity_id?: string | null;
          p_metadata?: Record<string, unknown>;
        };
        Returns: AuditLog;
      };
      is_workspace_member: {
        Args: { p_workspace_id: string };
        Returns: boolean;
      };
      is_workspace_admin: {
        Args: { p_workspace_id: string };
        Returns: boolean;
      };
      get_workspace_role: {
        Args: { p_workspace_id: string };
        Returns: WorkspaceRole;
      };
      is_workspace_editor: {
        Args: { p_workspace_id: string };
        Returns: boolean;
      };
    };
  };
}
