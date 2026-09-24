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
  /** MVP-4.1: completes the deferral documented in 20260915154503_content.sql. Nullable — PRD §5. */
  opportunity_id: string | null;
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
  /** MVP-5.3: completes the MVP-1.2 deferral. NULL for human-authored versions. */
  ai_job_id: string | null;
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
  /** MVP-5.3: completes the MVP-1.2 deferral. NULL for human/uploaded assets. */
  ai_job_id: string | null;
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

// publication_status is independent of ContentApprovalStatus — both
// happen to include an "approved" value but represent different concepts
// (Database Architecture §17; see also the publications migration header
// comment). Do not conflate them.
export type PublicationStatus =
  | "draft"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled";

export type Publication = {
  id: string;
  workspace_id: string;
  content_variant_id: string;
  social_account_id: string;
  status: PublicationStatus;
  scheduled_at: string | null;
  published_at: string | null;
  external_publication_id: string | null;
  external_url: string | null;
  provider_response: Record<string, unknown>;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * MVP-5.35B (20260923120000_publishing_foundation.sql): the ordered,
 * explicit set of assets a publication of this variant publishes (Q1).
 * Distinct from ContentAsset, which is the content-level library.
 */
export type ContentVariantAsset = {
  content_variant_id: string;
  asset_id: string;
  workspace_id: string;
  sort_order: number;
  created_by: string | null;
  created_at: string;
};

/** Terminal stages: published, failed, outcome_unknown. */
export type PublicationAttemptStage =
  | "validating"
  | "container_created"
  | "container_ready"
  | "publish_requested"
  | "published"
  | "failed"
  | "outcome_unknown";

export const TERMINAL_PUBLICATION_ATTEMPT_STAGES: readonly PublicationAttemptStage[] = [
  "published",
  "failed",
  "outcome_unknown",
];

/**
 * MVP-5.35B provider checkpoint/audit record, one row per publish attempt.
 * attempt_number and completed_at are assigned by database triggers; rows
 * are written only by the execution path (service_role) and read by members.
 * container_ids holds provider container ids only — never tokens or URLs.
 */
/** MVP-5.36 (Decision #44): Level-6 runtime control. A missing row means OFF. */
export type PublishingRuntimeMode = "dry_run" | "publish";
export type PublishingRuntimeControl = {
  key: "instagram_scheduled_publishing";
  enabled: boolean;
  mode: PublishingRuntimeMode;
  note: string | null;
  updated_at: string;
};

/** MVP-5.36: social accounts the Level-6 runtime may act on. */
export type PublishingRuntimeAllowlistEntry = {
  social_account_id: string;
  workspace_id: string;
  created_at: string;
};

/** MVP-5.36: one row per publication inspected by reconcile_stale_runtime_publications. */
export type RuntimeReconciliationRow = {
  publication_id: string;
  workspace_id: string;
  attempt_id: string | null;
  action: string;
};

export type PublicationAttempt = {
  id: string;
  workspace_id: string;
  publication_id: string;
  attempt_number: number;
  provider: string;
  stage: PublicationAttemptStage;
  container_ids: string[];
  media_asset_ids: string[];
  external_media_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

/**
 * MVP-2.6 Notifications (Database Architecture §14). `type` is
 * deliberately `string`, not a union — the canonical schema specifies no
 * enum for this column, unlike every other controlled status field in this
 * database. `data` carries only safe, non-secret references (e.g. a
 * publication id) — never provider credentials, Vault secrets, tokens,
 * idempotency keys, or raw provider_response.
 */
export type Notification = {
  id: string;
  workspace_id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

/**
 * MVP-5.10E (Decisions #29, #33). The eight canonical, provider-aware
 * (not cross-provider-comparable) normalized metrics on
 * `publication_metric_snapshots`.
 */
export const CANONICAL_METRICS = [
  "impressions",
  "reach",
  "views",
  "likes",
  "comments",
  "shares",
  "saves",
  "clicks",
] as const;

export type CanonicalMetric = (typeof CANONICAL_METRICS)[number];

/**
 * MVP-5.10E (Decisions #33/#37). "reported" (including a legitimate zero)
 * always pairs with a non-null value in the metric's own normalized
 * column; "unsupported"/"unavailable" always pair with null there —
 * enforced by `validate_publication_metric_states` (see
 * 20260917100000_analytics_metric_state.sql), not merely by convention.
 */
export type MetricObservationState = "reported" | "unsupported" | "unavailable";

export type MetricStates = Record<CanonicalMetric, { state: MetricObservationState }>;

/**
 * MVP-5.10E (Decisions #34/#38). Whether `captured_at` is the provider's
 * own reported observation time or a Marqos collection/sync-time
 * fallback used because the provider did not expose one.
 */
export type MetricTimestampProvenance = "provider" | "marqos_fallback";

/**
 * MVP-3.1 Analytics (Database Architecture §9). Historical, provider-
 * reported metrics for one publication — never overwritten or deleted;
 * every sync writes a new row. `provider_metrics` is the raw provider
 * response, kept separate from the normalized columns above (Engineering
 * Blueprint §18). Never contains credentials, tokens, or Vault secrets.
 *
 * `metric_states`/`captured_at_provenance` added MVP-5.10E (Decisions
 * #37/#38) — additive to, not a replacement for, the normalized columns.
 */
export type PublicationMetricSnapshot = {
  id: string;
  workspace_id: string;
  publication_id: string;
  captured_at: string;
  impressions: number | null;
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  engagement_rate: number | null;
  provider_metrics: Record<string, unknown>;
  metric_states: MetricStates;
  captured_at_provenance: MetricTimestampProvenance;
  created_at: string;
};

export type PerformanceScoreScope = "publication" | "content";

/**
 * MVP-3.1 Analytics (Database Architecture §9). Exactly one of
 * publication_id/content_id is set, consistent with score_scope — enforced
 * by a database CHECK constraint, not only by this type. `score_type` and
 * `calculation_version` are deliberately `string`, not a union — the
 * canonical schema specifies no enum for either column (same approved
 * deviation pattern as Notification.type). MVP-3.1's calculation service
 * writes only score_scope='publication' rows (score_type="engagement_rate",
 * calculation_version="v1") — content-scoped scoring is deferred, not
 * unsupported: the schema/type already allow it.
 */
export type ContentPerformanceScore = {
  id: string;
  workspace_id: string;
  score_scope: PerformanceScoreScope;
  publication_id: string | null;
  content_id: string | null;
  score_type: string;
  score: number;
  calculation_version: string;
  calculated_at: string;
  inputs: Record<string, unknown>;
  created_at: string;
};

/**
 * MVP-4.1 Intelligence Foundation (Database Architecture §4). No
 * composite-FK target — never referenced by a composite tenant-consistency
 * FK (§16), so no UNIQUE(id, workspace_id) exists for this table.
 * `configuration` must never contain credentials/secrets (§4).
 */
export type SignalSource = {
  id: string;
  workspace_id: string;
  provider: string;
  source_type: string;
  name: string;
  status: SignalSourceStatus;
  configuration: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type SignalSourceStatus = "active" | "paused" | "disabled" | "error";

/**
 * MVP-4.1 Intelligence Foundation (Database Architecture §4, DECISIONS
 * #11: "Signal = observed information"). `source_id` is a plain FK only —
 * not composite-FK-checked (§16's explicit list does not name this
 * relationship).
 */
export type Signal = {
  id: string;
  workspace_id: string;
  source_id: string;
  external_id: string | null;
  source_url: string | null;
  title: string | null;
  content_text: string | null;
  author_name: string | null;
  published_at: string | null;
  captured_at: string;
  engagement_data: Record<string, unknown>;
  raw_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** MVP-4.1 Intelligence Foundation (Database Architecture §4, DECISIONS #11: "Topic = grouped subject"). */
export type Topic = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: TopicStatus;
  created_at: string;
  updated_at: string;
};

export type TopicStatus = "active" | "archived";

/**
 * MVP-4.1 Intelligence Foundation (Database Architecture §4). Junction
 * table — no surrogate id, mirroring ContentAsset's shape. MVP-4.1: rows
 * are created only through explicit/manual service operations — no AI
 * classification exists in this slice.
 */
export type SignalTopic = {
  signal_id: string;
  topic_id: string;
  workspace_id: string;
  relevance_score: number | null;
  created_at: string;
};

/**
 * MVP-4.1 Intelligence Foundation (Database Architecture §4, DECISIONS
 * #11: "Opportunity = strategic marketing opportunity"). `topic_id` is a
 * plain FK only; `brand_id` is composite-FK-checked (nullable). `score` is
 * the canonical column only — never populated by any function in this
 * slice; no scoring formula exists in canonical text.
 */
export type Opportunity = {
  id: string;
  workspace_id: string;
  topic_id: string;
  brand_id: string | null;
  title: string;
  description: string | null;
  rationale: string | null;
  score: number | null;
  status: OpportunityStatus;
  detected_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OpportunityStatus = "open" | "in_progress" | "actioned" | "expired" | "dismissed";

/**
 * MVP-5.3 AI Foundation (Database Architecture §10, Engineering Blueprint
 * §10/§11/§12, DECISIONS #21-#28). automation_run_id is intentionally
 * absent — deferred until the `automation_runs` table exists (see
 * 20260917090000_ai.sql's header). `prompt_version_id` is a plain FK only,
 * not composite-FK-checked (prompt_versions.workspace_id is nullable for
 * global prompts — see the same migration).
 */
export type AiJobTriggerType = "user" | "automation" | "system";
export type AiJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type AiJob = {
  id: string;
  workspace_id: string;
  requested_by: string | null;
  trigger_type: AiJobTriggerType;
  job_type: string;
  provider: string;
  model: string;
  status: AiJobStatus;
  input_reference: Record<string, unknown>;
  output_reference: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  prompt_version_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AiUsage = {
  id: string;
  workspace_id: string;
  ai_job_id: string;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  image_count: number | null;
  estimated_cost: number | null;
  currency: string | null;
  created_at: string;
};

/**
 * Immutable except for `is_active` (20260917090000_ai.sql's header
 * explains why a narrow UPDATE exception exists here, unlike
 * content_versions). `workspace_id` NULL means a global/default prompt.
 */
export type PromptVersion = {
  id: string;
  workspace_id: string | null;
  name: string;
  purpose: string;
  version: number;
  template: string;
  configuration: Record<string, unknown>;
  is_active: boolean;
  created_by: string | null;
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
            | "opportunity_id"
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
      // Named marqos_assets/marqos_content_assets (not assets/content_assets):
      // the hosted Supabase project also contains a differently-shaped,
      // pre-existing assets/content_assets table pair belonging to a
      // separate application sharing the project (MVP-5.24 forensic audit;
      // MVP-5.25 remediation, Strategy C). The TypeScript type names below
      // (Asset, ContentAsset) are unchanged — only the relation identifiers are.
      marqos_assets: {
        Row: Asset;
        Insert: Partial<Asset> &
          Pick<Asset, "workspace_id" | "storage_path" | "file_name" | "mime_type" | "asset_type" | "file_size">;
        Update: Partial<
          Pick<Asset, "brand_id" | "file_name" | "metadata" | "archived_at" | "width" | "height" | "duration_ms" | "checksum">
        >;
        Relationships: [];
      };
      marqos_content_assets: {
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
            | "external_account_id"
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
      publications: {
        Row: Publication;
        Insert: Partial<Publication> &
          Pick<Publication, "workspace_id" | "content_variant_id" | "social_account_id" | "idempotency_key">;
        Update: Partial<
          Pick<
            Publication,
            | "status"
            | "scheduled_at"
            | "published_at"
            | "external_publication_id"
            | "external_url"
            | "provider_response"
            | "error_code"
            | "error_message"
          >
        >;
        // No DELETE policy/grant exists — publications are historical records, never hard-deleted (Database Architecture §19).
        Relationships: [];
      };
      marqos_content_variant_assets: {
        Row: ContentVariantAsset;
        Insert: Partial<ContentVariantAsset> &
          Pick<ContentVariantAsset, "content_variant_id" | "asset_id" | "workspace_id" | "sort_order">;
        Update: Partial<Pick<ContentVariantAsset, "sort_order">>;
        Relationships: [];
      };
      publication_attempts: {
        Row: PublicationAttempt;
        // attempt_number is trigger-assigned; any supplied value is overwritten.
        Insert: Partial<PublicationAttempt> & Pick<PublicationAttempt, "workspace_id" | "publication_id" | "provider">;
        Update: Partial<
          Pick<
            PublicationAttempt,
            "stage" | "container_ids" | "media_asset_ids" | "external_media_id" | "error_code" | "error_message"
          >
        >;
        // No DELETE grant for any API role (append/audit record).
        Relationships: [];
      };
      // MVP-5.36: service-role only (no anon/authenticated grants, no RLS policies).
      publishing_runtime_control: {
        Row: PublishingRuntimeControl;
        Insert: Partial<PublishingRuntimeControl> & Pick<PublishingRuntimeControl, "key">;
        Update: Partial<Pick<PublishingRuntimeControl, "enabled" | "mode" | "note">>;
        Relationships: [];
      };
      publishing_runtime_allowlist: {
        Row: PublishingRuntimeAllowlistEntry;
        Insert: Pick<PublishingRuntimeAllowlistEntry, "social_account_id" | "workspace_id">;
        Update: Record<string, never>;
        Relationships: [];
      };
      notifications: {
        Row: Notification;
        Insert: Partial<Notification> & Pick<Notification, "workspace_id" | "user_id" | "type" | "title" | "message">;
        // Only read_at is ever written by the service layer (markNotificationRead) —
        // no authenticated INSERT policy exists, and no column-level DB restriction
        // is introduced this phase (MVP-2.6 approved decision).
        Update: Partial<Pick<Notification, "read_at">>;
        // No DELETE policy/grant exists for `authenticated` — not part of MVP-2.6 scope.
        Relationships: [];
      };
      publication_metric_snapshots: {
        Row: PublicationMetricSnapshot;
        // metric_states/captured_at_provenance are NOT NULL with no DEFAULT
        // (20260917100000_analytics_metric_state.sql) — always supplied
        // explicitly by the Analytics Normalizer, never left to a default.
        Insert: Partial<PublicationMetricSnapshot> &
          Pick<PublicationMetricSnapshot, "workspace_id" | "publication_id" | "metric_states" | "captured_at_provenance">;
        // No UPDATE policy/grant exists for `authenticated` — historical, append-only (Database Architecture §9/§19).
        Update: Record<string, never>;
        // No DELETE policy/grant exists for `authenticated` — never hard-deleted (Database Architecture §19).
        Relationships: [];
      };
      content_performance_scores: {
        Row: ContentPerformanceScore;
        Insert: Partial<ContentPerformanceScore> &
          Pick<ContentPerformanceScore, "workspace_id" | "score_scope" | "score_type" | "score" | "calculation_version">;
        // No UPDATE policy/grant exists for `authenticated` — historical, append-only (Database Architecture §9/§19).
        Update: Record<string, never>;
        // No DELETE policy/grant exists for `authenticated` — never hard-deleted (Database Architecture §19).
        Relationships: [];
      };
      // Named marqos_signal_sources/marqos_signals (not signal_sources/
      // signals): same rationale as marqos_assets above — a differently-
      // shaped, pre-existing table pair of those names already exists in
      // the hosted project (MVP-5.24/MVP-5.25). topics/signal_topics/
      // opportunities do not collide and keep their original names.
      marqos_signal_sources: {
        Row: SignalSource;
        Insert: Partial<SignalSource> & Pick<SignalSource, "workspace_id" | "provider" | "source_type" | "name">;
        Update: Partial<Pick<SignalSource, "provider" | "source_type" | "name" | "status" | "configuration">>;
        // No DELETE policy/grant exists for `authenticated` (MVP-4.1 approved decision).
        Relationships: [];
      };
      marqos_signals: {
        Row: Signal;
        Insert: Partial<Signal> & Pick<Signal, "workspace_id" | "source_id">;
        Update: Partial<
          Pick<
            Signal,
            "external_id" | "source_url" | "title" | "content_text" | "author_name" | "published_at" | "engagement_data" | "raw_data"
          >
        >;
        // No DELETE policy/grant exists for `authenticated` (MVP-4.1 approved decision).
        Relationships: [];
      };
      topics: {
        Row: Topic;
        Insert: Partial<Topic> & Pick<Topic, "workspace_id" | "name">;
        Update: Partial<Pick<Topic, "name" | "description" | "status">>;
        // No DELETE policy/grant exists for `authenticated` (MVP-4.1 approved decision).
        Relationships: [];
      };
      signal_topics: {
        Row: SignalTopic;
        Insert: Partial<SignalTopic> & Pick<SignalTopic, "signal_id" | "topic_id" | "workspace_id">;
        // No UPDATE policy/grant exists for `authenticated` — see migration header (re-link via delete+insert, not update).
        Update: Record<string, never>;
        // No DELETE policy/grant exists for `authenticated` (MVP-4.1 approved decision).
        Relationships: [];
      };
      opportunities: {
        Row: Opportunity;
        Insert: Partial<Opportunity> & Pick<Opportunity, "workspace_id" | "topic_id" | "title">;
        Update: Partial<
          Pick<Opportunity, "title" | "description" | "rationale" | "score" | "status" | "brand_id" | "expires_at">
        >;
        // No DELETE policy/grant exists for `authenticated` (MVP-4.1 approved decision).
        Relationships: [];
      };
      prompt_versions: {
        Row: PromptVersion;
        // No `authenticated` INSERT policy exists (DECISIONS #24) — enforced
        // by RLS/grants, not by this type; service_role legitimately
        // constructs a full insert (createPromptVersion).
        Insert: Partial<PromptVersion> & Pick<PromptVersion, "name" | "purpose" | "version" | "template">;
        // Immutable except is_active (see 20260917090000_ai.sql) — only
        // field ever updated by application code (createPromptVersion).
        // No `authenticated` UPDATE policy exists either way (DECISIONS #24).
        Update: Partial<Pick<PromptVersion, "is_active">>;
        Relationships: [];
      };
      ai_jobs: {
        Row: AiJob;
        // No `authenticated` INSERT policy exists (DECISIONS #24) — enforced
        // by RLS/grants, not by this type; service_role legitimately
        // constructs a full insert (createAiJob).
        Insert: Partial<AiJob> & Pick<AiJob, "workspace_id" | "trigger_type" | "job_type" | "provider" | "model">;
        // Only the lifecycle-transition fields are ever updated by
        // application code (markAiJobRunning/Completed/Failed). No
        // `authenticated` UPDATE policy exists either way (DECISIONS #24).
        Update: Partial<Pick<AiJob, "status" | "output_reference" | "error_code" | "error_message" | "started_at" | "completed_at">>;
        Relationships: [];
      };
      ai_usage: {
        Row: AiUsage;
        // No `authenticated` INSERT policy exists (DECISIONS #24) — enforced
        // by RLS/grants, not by this type; service_role legitimately
        // constructs a full insert (recordAiUsage).
        Insert: Partial<AiUsage> & Pick<AiUsage, "workspace_id" | "ai_job_id" | "provider" | "model">;
        // No UPDATE policy/grant exists for `authenticated` — historical, append-only, never updated by any role (Database Architecture §10).
        Update: Record<string, never>;
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
      // MVP-5.36 (Decision #44): service_role only.
      claim_runtime_publications: {
        Args: { p_cap: number };
        Returns: Publication[];
      };
      reconcile_stale_runtime_publications: {
        Args: { p_stale_seconds: number };
        Returns: RuntimeReconciliationRow[];
      };
    };
  };
}
