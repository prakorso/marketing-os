# MARQOS — Marketing Operating System — Database Architecture

**Version:** 1.2
**Status:** DRAFT — pending Owner approval (Track 0). Supersedes the
unapproved v1.1 draft (2026-09-15) once approved.
**Date:** 2026-09-25

**Reality markers used in this document.**

- **EXISTS NOW** — migrated in `supabase/migrations`.
- **DESIGNED — NOT MIGRATED** — specified here but no table exists.
- **PLANNED FUTURE** — direction only; no columns are final.

Sections without a marker describe tables that exist. No planned or
designed entity may be assumed to exist, and none is authorized for
migration by this document.

## 1. Database Principles

1. PostgreSQL is the system of record.
2. UUID primary keys are preferred for application entities.
3. Use `timestamptz` for timestamps.
4. Use foreign keys for relational integrity.
5. Use PostgreSQL enums or CHECK-constrained controlled value sets for every
   genuinely controlled state field. No load-bearing status field is left
   undefined (see §9 domain sections and the value sets specified there).
6. Use JSONB for provider-specific/flexible metadata, not as a substitute
   for relational design.
7. Every workspace-scoped business entity must be tenant-isolated.
   High-traffic or FK-central tables carry `workspace_id` directly rather
   than relying on multi-hop joins for RLS, querying, and indexing.
8. RLS is mandatory and is enabled in the same migration that creates the
   table. A table is never created, even transiently, without RLS enabled
   and its policies defined.
9. Historical records must be preserved. `content_versions`,
   `content_variants`, and `publications` are historical records and must
   never be hard-deleted. Archive/status mechanisms are used instead.
10. Content versions are immutable (no UPDATE after creation).
11. Raw metrics remain separate from derived scores.
12. Database changes must be migration-driven.
13. Destructive changes require explicit approval.
14. Redundant `workspace_id` values introduced under principle 7 are
    enforced with composite foreign keys against their parent's
    `(id, workspace_id)`, not solely by application code (see §16).
15. Unrestricted polymorphic relations are not used. Where a record may
    reference one of several source types (e.g. evidence), the design uses
    a closed set of typed nullable foreign keys plus a CHECK constraint
    guaranteeing exactly one target is populated.

## 2. Identity Domain

### `profiles`
- `id` UUID PK, references `auth.users.id`
- `display_name`
- `avatar_url`
- `created_at`
- `updated_at`

No passwords/auth credentials here.

### `workspaces`
- `id` UUID PK
- `name`
- `slug`
- `owner_id` FK → `profiles.id`
- `created_at`
- `updated_at`
- optional archive/deletion timestamp

### `workspace_members`
- `id` UUID PK
- `workspace_id` FK → `workspaces.id`
- `user_id` FK → `profiles.id`
- `role` — enum `workspace_role`: `owner`, `admin`, `marketer`, `viewer`
- `created_at`
- `updated_at`

Unique: `(workspace_id, user_id)`

## 3. Brand Domain

### `brands`
- `id`
- `workspace_id`
- `name`
- `description`
- `website_url`
- `status` — enum `brand_status`: `active`, `archived`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs from child tables (§16).

### `brand_identity`
- `id`
- `brand_id` unique FK
- `workspace_id` — direct (denormalized; composite FK, §16)
- `logo_asset_id` nullable FK → `marqos_assets.id` where dependency order permits
- `primary_colors` JSONB
- `secondary_colors` JSONB
- `typography` JSONB
- `visual_guidelines` JSONB
- `created_at`
- `updated_at`

### `brand_voice`
- `id`
- `brand_id` unique FK
- `workspace_id` — direct (denormalized; composite FK, §16)
- `tone`
- `personality`
- `preferred_terms` JSONB
- `avoid_terms` JSONB
- `writing_guidelines`
- `example_copy` JSONB
- `created_at`
- `updated_at`

### `audience_profiles`
- `id`
- `brand_id`
- `workspace_id` — direct (denormalized; composite FK, §16)
- `name`
- `description`
- `demographics` JSONB
- `needs` JSONB
- `pain_points` JSONB
- `motivations` JSONB
- `created_at`
- `updated_at`

### `content_pillars`
- `id`
- `brand_id`
- `workspace_id` — direct (denormalized; composite FK, §16)
- `name`
- `description`
- `priority`
- `created_at`
- `updated_at`

## 4. Intelligence Domain

Tables named `marqos_signal_sources`/`marqos_signals`, not
`signal_sources`/`signals` (MVP-5.24/MVP-5.25 owner decision): the hosted
Supabase project also contains a differently-shaped, pre-existing table
pair of those names belonging to a separate application sharing the
project. `topics`/`signal_topics`/`opportunities` do not collide and keep
their original names.

### `marqos_signal_sources`
- `id`
- `workspace_id`
- `provider`
- `source_type`
- `name`
- `status` — enum `signal_source_status`: `active`, `paused`, `disabled`, `error`
- `configuration` JSONB
- `created_at`
- `updated_at`

Secrets are not stored in ordinary configuration JSONB (see §8 for the
credential pattern used for third-party access; the same principle applies
to any source-level credentials).

### `marqos_signals`
- `id`
- `workspace_id`
- `source_id`
- `external_id` nullable
- `source_url`
- `title`
- `content_text`
- `author_name`
- `published_at`
- `captured_at`
- `engagement_data` JSONB
- `raw_data` JSONB
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

Recommended uniqueness: `(source_id, external_id)` where provider permits.

### `topics`
- `id`
- `workspace_id`
- `name`
- `description`
- `status` — enum `topic_status`: `active`, `archived`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

### `signal_topics`
- `signal_id` FK
- `topic_id` FK
- `workspace_id` — direct (junction table; composite FKs, §16)
- optional relevance score
- `created_at`

Primary/unique: `(signal_id, topic_id)`.

### `opportunities`
- `id`
- `workspace_id`
- `topic_id`
- `brand_id`
- `title`
- `description`
- `rationale`
- `score`
- `status` — enum `opportunity_status`: `open`, `in_progress`, `actioned`, `expired`, `dismissed`
- `detected_at`
- `expires_at`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

### Intelligence method note

Current state (factual correction): the delivered MVP-4 associates
signals with topics manually through `signal_topics` (Decision #22).
An earlier version of this note said MVP grouping used AI/provider
classification; that was the design intent, not what was delivered.

Trend Signal V1 (Decision #48) may add AI classification/clustering, brand
relevance and interpretation, and may add a vector similarity
column/index where justified (§23). None of these exists today, and none
is required until the Trend Signal V1 contract specifies it.

## 5. Content Domain

### `content_briefs`
- `id`
- `workspace_id`
- `brand_id`
- `opportunity_id` nullable
- `audience_profile_id` nullable
- `content_pillar_id` nullable
- `title`
- `objective`
- `angle`
- `core_message`
- `cta`
- `format`
- `platform_intent` JSONB
- `creative_direction` JSONB
- `status` — enum `content_brief_status`: `draft`, `ready`, `in_progress`, `fulfilled`, `archived`
- `created_by`
- `created_at`
- `updated_at`

A brief may exist without an opportunity. When `brand_id` is set it is
composite-FK-checked against `brands (id, workspace_id)` (§16).

### `content`
- `id`
- `workspace_id`
- `brand_id`
- `brief_id` nullable
- `title`
- `content_type`
- `status` — enum `content_status`: `draft`, `in_review`, `approved`, `changes_requested`, `archived`
- `created_by`
- `created_at`
- `updated_at`
- `archived_at` nullable

Content is not a publication and is not platform-specific.

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

`content.status` is a rollup convenience field for UI/listing. It is
**not** the authoritative record of approval — see §17, Content Approval →
Publication Gate.

### `content_versions`
- `id`
- `content_id`
- `workspace_id` — direct (denormalized; composite FK to `content`, §16)
- `version_number`
- `source_version_id` nullable
- `generation_method`
- `ai_job_id` nullable FK → `ai_jobs.id`
- `content_payload` JSONB
- `created_by`
- `created_at`

Unique: `(content_id, version_number)`.

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

Versions are immutable: no `updated_at` column, and no UPDATE statement is
permitted against this table after insert (enforced by omitting UPDATE from
the RLS policy set — see §20). Versions are also never hard-deleted — see
§19.

`ai_job_id` is nullable. When `generation_method` indicates AI generation,
`ai_job_id` must be populated so the version is traceable to the AI
execution that produced it; when content is human-authored, `ai_job_id` is
`NULL`.

### `content_variants`
- `id`
- `content_version_id`
- `workspace_id` — direct (denormalized; composite FK to `content_versions`, §16)
- `platform`
- `format`
- `caption`
- `copy_payload` JSONB
- `metadata` JSONB
- `status` — enum `content_variant_status`: `draft`, `ready`, `approved`, `archived`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16). Variants are
never hard-deleted once a `publication` references them — see §19.

## 6. Asset Domain

Tables named `marqos_assets`/`marqos_content_assets`, not `assets`/
`content_assets` (MVP-5.24/MVP-5.25 owner decision): the hosted Supabase
project also contains a differently-shaped, pre-existing table pair of
those names belonging to a separate application sharing the project. The
`assets` Storage bucket (Foundation) is unaffected and keeps its original
name — it is a different namespace from the database table.

### `marqos_assets`
- `id`
- `workspace_id`
- `brand_id` nullable
- `storage_bucket`
- `storage_path`
- `file_name`
- `mime_type`
- `asset_type`
- `file_size`
- `width` nullable
- `height` nullable
- `duration_ms` nullable
- `checksum` nullable
- `ai_job_id` nullable FK → `ai_jobs.id`
- `metadata` JSONB
- `source_asset_id` nullable self-FK
- `created_by`
- `created_at`
- `updated_at`
- `archived_at`

Asset types: image, video, audio, document, other.

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

`ai_job_id` is nullable and, like `content_versions.ai_job_id`, must be
populated for AI-generated assets (e.g. AI image generation output) and
left `NULL` for uploaded/human-sourced assets. When `brand_id` is set it is
composite-FK-checked against `brands (id, workspace_id)`.

### `marqos_content_assets`
- `content_id`
- `asset_id`
- `workspace_id` — direct (junction table; composite FKs, §16)
- `role`
- `sort_order`
- `created_at`

Content-level asset library: allows asset reuse and organization at the
content (concept) level. It does not determine what a publication publishes.

### `marqos_content_variant_assets`
- `content_variant_id`
- `asset_id`
- `workspace_id` — direct (junction table; composite FKs, §16)
- `sort_order` — required, `>= 0`
- `created_by`
- `created_at`

Primary key `(content_variant_id, asset_id)`; `UNIQUE (content_variant_id,
sort_order)`. The explicit, ordered selection of media that a publication of
this variant publishes (MVP-5.35B, Decision #43) — deterministic at variant
level because the publication target is the variant. Composite FKs to
`content_variants (id, workspace_id)` and `marqos_assets (id, workspace_id)`
reject cross-workspace bindings. RLS: members read, editors write (same as
`marqos_content_assets`). A junction, not a historical record; what an
attempt actually submitted is snapshotted in
`publication_attempts.media_asset_ids`.

## 7. Approval Domain

### `content_approvals`
- `id`
- `workspace_id`
- `content_id`
- `content_version_id` nullable
- `status` — enum `content_approval_status`: `pending`, `approved`, `changes_requested`, `rejected`
- `comment`
- `reviewed_by`
- `reviewed_at`
- `created_at`

Approval history is append-oriented; rows are never updated or deleted.

`content_version_id` is nullable to allow brief/concept-level sign-off
before versions exist, but **must** be populated for any approval intended
to satisfy the Publication Approval Gate (§17). An approval without a
`content_version_id` does not authorize publishing.

## 8. Distribution Domain

### `social_accounts`
- `id`
- `workspace_id`
- `brand_id` nullable
- `platform`
- `external_account_id`
- `account_name`
- `account_handle`
- `status` — enum `social_account_status`: `connected`, `disconnected`, `expired`, `revoked`, `error`
- `vault_secret_id` — reference to a Supabase Vault secret (UUID); the
  Vault entry holds the OAuth access/refresh token or API key
- `metadata` JSONB
- `connected_at`
- `last_synced_at`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

**`external_account_id` semantics (Model B, MVP-5.35B.3):** the
provider-native identifier of the account MARQOS acts on — the id used in
that provider's API paths and the natural key `(workspace_id, platform,
external_account_id)`. For Instagram it is the professional account ID
(`<IG_ID>`, `GET /me?fields=user_id`), obtained by a profile lookup that is
part of establishing an Instagram connection (no account is written unless
it succeeds). The OAuth token-exchange "Instagram-scoped user ID" and the
`/me` app-scoped `id` are non-secret provenance only
(`metadata.instagramScopedUserId`, `metadata.instagramAppScopedId`), never
the natural key or a publishing target. `account_handle` holds the `/me`
username. Rows connected before Model B (keyed by a rounded token-scoped
id) are migrated in place on their next reconnect by a
compatibility-only legacy reconciliation (same workspace, `instagram`,
`credentialKind = real`, no provenance yet; exactly one match or the
connection fails closed; never merges on a professional-id collision) —
not part of normal identity behavior.

**Provider identifiers are opaque strings:** `external_account_id` (and
every other provider-native identifier, e.g. `publications.external_publication_id`)
is `text` and is an opaque provider identifier, never a number. It must be
preserved losslessly end-to-end — from the provider's raw response through
parsing, application types and persistence — with no numeric conversion,
arithmetic, or JavaScript-number round trip (MVP-5.35B.1: Instagram returns
some ids as JSON numbers above `Number.MAX_SAFE_INTEGER`).

**Credential storage:** raw access tokens, refresh tokens, and API secrets
are never stored in `social_accounts` or in `metadata` JSONB. They are
stored exclusively in **Supabase Vault**, referenced by `vault_secret_id`.
Vault reads/writes happen only in server-side application code (server
components, route handlers, or job workers) using the service role; the
browser/client never receives a Vault secret or raw token. Adapter code
resolves `vault_secret_id` → live credential immediately before making a
provider API call and does not persist the resolved value outside memory
for the duration of that call. Credential rotation replaces the Vault
secret content; `vault_secret_id` itself does not need to change.

### `publications`
- `id`
- `workspace_id`
- `content_variant_id`
- `social_account_id`
- `status` — enum `publication_status`: `draft`, `approved`, `scheduled`, `publishing`, `published`, `failed`, `cancelled`
- `scheduled_at`
- `published_at`
- `external_publication_id`
- `external_url`
- `provider_response` JSONB
- `error_code`
- `error_message`
- `idempotency_key`
- `created_by`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).
`idempotency_key` is unique per `(workspace_id, social_account_id)`.

`publications` are historical records and are never hard-deleted;
cancellation and failure are represented by `status`, not deletion (§19).

Transition into `scheduled`, `publishing`, or `published` is gated — see
§17, Content Approval → Publication Gate.

**Lifecycle transitions** (database triggers, all roles):
`publishing` only from `scheduled`; `published`/`failed` only from
`publishing` (MVP-2.3). Re-entering `scheduled` (MVP-5.35B,
`enforce_publication_scheduling_transitions`, with service-layer parity in
`schedulePublication`) is allowed only from `draft`, `approved`,
`scheduled` (reschedule), or `failed` — and never from `failed` when
`error_code = 'publish_outcome_unknown'`, nor while a
`publication_attempts` row for the publication is still non-terminal.
`published`, `publishing` and `cancelled` can never be rescheduled (a
re-execution could post the same content twice).

`published_at` is the MARQOS time the publication was marked published
(provider timestamps may later be recorded as provenance, not substituted).

### `publication_attempts`
- `id`
- `workspace_id`
- `publication_id` — composite FK to `publications (id, workspace_id)`
- `attempt_number` — assigned by trigger: 1, 2, 3… per publication
- `provider`
- `stage` — enum `publication_attempt_stage`: `validating`,
  `container_created`, `container_ready`, `publish_requested` (non-terminal);
  `published`, `failed`, `outcome_unknown` (terminal)
- `container_ids` JSONB array — provider container ids only
- `media_asset_ids` uuid[] — assets actually submitted
- `external_media_id` — required when `stage = 'published'`
- `error_code`, `error_message`
- `started_at`, `updated_at`, `completed_at` (set exactly when terminal)

**Execution semantics (MVP-5.35C-B, Decision #43):** the attempt is the
source of truth for remote execution progress; `publications.status` is the
MARQOS lifecycle. `publish_requested` is committed BEFORE the irreversible
provider publish request is invoked (if that write fails, the request is
never sent). On success the attempt is written `published` with
`external_media_id` before the publication moves to `published`. An
ambiguous publish result sets the attempt to `outcome_unknown` while the
publication STAYS `publishing` until reconciled; no new attempt may start
while any earlier attempt is not a known failure. `publish_requested` is only
written after a deadline check proves the publish request and the final writes
still fit the execution budget (otherwise the attempt fails with
`insufficient_publish_time_budget`). An internal dry run ends an attempt as
`failed` with `error_code = 'dry_run_container_ready'` after `container_ready`
(MVP-5.35C-D).
Terminal attempts are immutable (trigger), so an operator-confirmed resolution
of an `outcome_unknown` attempt marks only the publication `published` (with
reconciliation provenance in `provider_response`); a `publish_requested`
attempt whose provider success is known is written `published` first
(MVP-5.35C-I, Decision #43).

`UNIQUE (publication_id, attempt_number)`; partial unique index: at most one
non-terminal attempt per publication. An attempt can only be started while
the publication is `publishing`. Provider checkpoint and audit record
(MVP-5.35B, Decision #43): provider progress is recorded here because a
`publications` row cannot be updated while it stays `publishing`; the
MARQOS lifecycle remains in `publications.status`. Append/audit oriented:
no DELETE grant for any API role, identity columns immutable, terminal
attempts immutable. RLS: members read; only the execution path
(`service_role`) writes.

Runtime hardening columns (EXISTS NOW; migration
`20260926120000_runtime_hardening_lease_resume.sql`, Decision #45):

- `container_create_requested_at` — committed before the
  container-creation request (G1). Set with no recorded container means
  the G1 outcome is unknown; it is never re-dispatched.
- `container_created_at` — when the container id was recorded;
  READINESS_MAX (15 min) is measured from it.
- `status_poll_count` — integer, ≥ 0, observability only.
- `last_run_id` — the lease holder that last worked the attempt.

### Runtime publishing controls (EXISTS NOW; Decisions #44, #45)

Migrations `20260925120000_runtime_publishing_controls.sql` and
`20260926120000_runtime_hardening_lease_resume.sql`. All of these are
service-role only: RLS enabled, no policies, browser roles revoked.

- `publishing_runtime_control` — the singleton runtime control:
  - `key` — CHECK `= 'instagram_scheduled_publishing'`;
  - `enabled` — default false;
  - `mode` — `dry_run` | `publish`, default `dry_run`;
  - `note`, `updated_at`.
  A missing row means OFF.
- `publishing_runtime_allowlist` — rows of `social_account_id`
  (PK) and `workspace_id`, with a composite FK to
  `social_accounts (id, workspace_id)`.
- `publishing_runtime_slot_lease` — one row per database-clock 5-minute
  slot:
  - `runtime_key`, `slot_start` (PK together);
  - `run_id` (unique), `acquired_at`;
  - `completed_at` and `outcome`, set together;
  - `duplicate_count`.
  Rows are evidence and are never deleted by the runtime.
- RPCs (SECURITY DEFINER, `service_role` execute only):
  - `acquire_runtime_slot_lease(p_run_id)`;
  - `complete_runtime_slot_lease(p_run_id, p_outcome)`;
  - `select_runtime_resume(p_run_id)`;
  - `claim_runtime_publications(p_cap, p_run_id)` (v3);
  - `reconcile_stale_runtime_publications(p_stale_seconds, p_run_id)`
    (v2).
  The v1 overloads `claim_runtime_publications(p_cap)` and
  `reconcile_stale_runtime_publications(p_stale_seconds)` still exist;
  their retirement needs a separately authorized migration.
- Owner-only helpers (no API role execute): `runtime_slot_lease_lock()`,
  `runtime_lease_is_valid_holder(uuid)`,
  `runtime_control_enabled_mode()`.

These structures are Instagram-keyed; their generalization to other
providers is Track 5 work (Decision #50).

The calendar is a projection of publications.

## 9. Analytics Domain

### `publication_metric_snapshots`
- `id`
- `workspace_id`
- `publication_id`
- `captured_at`
- `impressions`
- `reach`
- `views`
- `likes`
- `comments`
- `shares`
- `saves`
- `clicks`
- `engagement_rate`
- `provider_metrics` JSONB
- `metric_states` JSONB
- `captured_at_provenance` — enum `metric_timestamp_provenance`: `provider`, `marqos_fallback`
- `created_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

Historical snapshots are never overwritten or deleted.

`metric_states`/`captured_at_provenance` are implemented
(`20260917100000_analytics_metric_state.sql`, MVP-5.10E), additive to the
original `20260916200000_analytics.sql` schema above them.

Per-metric state (whether each normalized metric above is reported —
including a legitimate zero — unsupported, or unavailable) is carried in
`metric_states`, an additive JSONB structure alongside the normalized
columns, not a relational table (Decision #37). A `CHECK` constraint
(`validate_publication_metric_states`) enforces, at the database level,
that a metric is "reported" if and only if its own column is non-null —
this is not merely an application-layer convention.

`captured_at` represents the best available metric observation time: the
provider's own reported observation time when available, falling back to
Marqos's collection/sync time otherwise (Decision #38).
`captured_at_provenance` records, explicitly and non-inferably, which of
the two produced a given row's `captured_at`.

`provider_metrics` stores the untouched provider-native payload only
(Decision #39's raw-response envelope's `payload`). The envelope's other
two parts are not duplicated into `provider_metrics`: provider identity
is already recoverable via `publication_id → publications.social_account_id
→ social_accounts.platform`, and the envelope's observation timestamp is
represented by the structured `captured_at`/`captured_at_provenance` pair
above, not stored a second time as raw text. This is a deliberate
boundary, not an omission — duplicating envelope metadata into the JSONB
column would not improve raw fidelity, only duplicate data already held
in typed, queryable form elsewhere on the same row.

`social_accounts.last_synced_at` (§8) is updated, monotonically, inside
the successful path of the service function that persists a
`publication_metric_snapshots` row — covering both a direct single-
publication call and a batch sync — never on a failed collection attempt
(Decision #40). This requires no schema change; the column already
exists.

### `content_performance_scores`
- `id`
- `workspace_id`
- `score_scope` — enum `performance_score_scope`: `publication`, `content`
- `publication_id` nullable
- `content_id` nullable
- `score_type`
- `score`
- `calculation_version`
- `calculated_at`
- `inputs` JSONB
- `created_at`

CHECK constraint: exactly one of `publication_id` / `content_id` is set,
consistent with `score_scope`:

```text
(score_scope = 'publication' AND publication_id IS NOT NULL AND content_id IS NULL)
OR
(score_scope = 'content' AND content_id IS NOT NULL AND publication_id IS NULL)
```

A `publication`-scoped score evaluates a single publication's metrics. A
`content`-scoped score aggregates across that content's variants and
publications as of `calculated_at`; the aggregation method is identified by
`calculation_version` so historical scores remain interpretable even as the
aggregation formula evolves.

Raw metric snapshots remain authoritative; scores are always re-derivable
from them.

The MVP-3 calculation (`score_type = "engagement_rate"`) is a provisional
passthrough of `publication_metric_snapshots.engagement_rate`, not a
genuinely derived calculation — no aggregation, weighting, or
transformation is applied (Decision #31). "Re-derivable from raw
snapshots" describes this table's traceability guarantee (a score can
always be recomputed/audited against the snapshot it came from), not a
claim that the current MVP-3 `score_type` is itself a sophisticated
derived formula.

## 10. AI Domain

### `ai_jobs`
- `id`
- `workspace_id`
- `requested_by` nullable (user id; null when `trigger_type` is not `user`)
- `trigger_type` — enum `ai_job_trigger_type`: `user`, `automation`, `system`
- `automation_run_id` nullable FK → `automation_runs.id` (set when `trigger_type = 'automation'`)
- `job_type`
- `provider`
- `model`
- `status` — enum `ai_job_status`: `queued`, `running`, `completed`, `failed`, `cancelled`
- `input_reference` JSONB
- `output_reference` JSONB
- `error_code`
- `error_message`
- `prompt_version_id` nullable FK → `prompt_versions.id`
- `started_at`
- `completed_at`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

Every AI execution is attributable: `trigger_type = 'user'` requires
`requested_by`; `trigger_type = 'automation'` requires `automation_run_id`;
`trigger_type = 'system'` covers internal, non-automation-run system jobs
(e.g. a maintenance re-embedding job) and requires neither. This closes the
traceability gap where an AI job's origin (a human action vs. an autonomous
automation policy) was previously unrecorded.

`content_versions.ai_job_id` and `marqos_assets.ai_job_id` are the forward
links from generated artifacts back to the job that produced them (§5, §6).

`prompt_version_id` records which `prompt_versions` row (if any) produced
this job's request (DECISIONS #26). It is a **plain** foreign key only —
unlike the other FKs listed in §16 — because `prompt_versions.workspace_id`
is nullable (`NULL` denotes a global prompt shared across every workspace),
so a global prompt has no single workspace to composite-FK-check
`ai_jobs.workspace_id` against. Tenant safety for prompt resolution is
guaranteed instead by the resolution precedence itself (a workspace only
ever resolves its own active prompt or an explicitly global one, never
another workspace's private prompt — see `prompt_versions` below), not by a
composite FK. `prompt_versions` is therefore not added to §16's composite-FK
target list.

### `ai_usage`
- `id`
- `workspace_id`
- `ai_job_id`
- `provider`
- `model`
- `input_tokens` nullable
- `output_tokens` nullable
- `image_count` nullable
- `estimated_cost` nullable
- `currency`
- `created_at`

### `prompt_versions`
- `id`
- `workspace_id` nullable — `NULL` means a global/default prompt
- `name`
- `purpose`
- `version`
- `template`
- `configuration` JSONB
- `is_active`
- `created_by`
- `created_at`
- `updated_at`

**Resolution precedence (deterministic):** for a given `purpose`, the
application resolves the active prompt by first looking for a row with
`workspace_id = <current workspace>` and `is_active = true`; if none
exists, it falls back to the row with `workspace_id IS NULL` and
`is_active = true`. If neither exists, resolution fails explicitly (no
silent default).

Uniqueness: a partial unique index on `(workspace_id, purpose)` where
`is_active = true` ensures at most one active prompt per scope per
purpose, so resolution is never ambiguous.

## 11. Optimization Domain

**DESIGNED — NOT MIGRATED.** No table in this section exists yet. Track 7
(Learning Loop V1) operationalizes them under its own contract.

### `insights`
- `id`
- `workspace_id`
- `brand_id` nullable
- `title`
- `description`
- `insight_type`
- `confidence`
- `status` — enum `insight_status`: `new`, `reviewed`, `actioned`, `dismissed`, `archived`
- `generated_at`
- `created_at`
- `updated_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16). When `brand_id`
is set it is composite-FK-checked against `brands (id, workspace_id)`.

### `insight_evidence`
- `id`
- `workspace_id`
- `insight_id`
- `evidence_type` — descriptive label only (e.g. `metric`, `signal_cluster`); no longer a discriminator for an untyped reference
- `signal_id` nullable FK → `marqos_signals.id`
- `topic_id` nullable FK → `topics.id`
- `opportunity_id` nullable FK → `opportunities.id`
- `content_id` nullable FK → `content.id`
- `publication_id` nullable FK → `publications.id`
- `publication_metric_snapshot_id` nullable FK → `publication_metric_snapshots.id`
- `summary`
- `data` JSONB
- `created_at`

CHECK constraint: **exactly one** of `signal_id`, `topic_id`,
`opportunity_id`, `content_id`, `publication_id`,
`publication_metric_snapshot_id` is non-null.

This replaces the previous unrestricted `reference_id` design. It is a
closed set of typed foreign keys, consistent with ERD constraint #7 ("do
not use unrestricted polymorphic relations"). Adding a new evidence source
type requires a migration that adds a new nullable FK column and updates
the CHECK constraint — a deliberate, reviewable change, not a schema-free
extension point.

Each of the six FK columns is additionally composite-FK-checked against its
target's `(id, workspace_id)` (§16), so evidence can never reference a
record from a different workspace.

### `recommendations`
- `id`
- `workspace_id`
- `insight_id` nullable
- `title`
- `description`
- `recommendation_type`
- `priority`
- `status` — enum `recommendation_status`: `proposed`, `accepted`, `in_progress`, `completed`, `dismissed`
- `action_type`
- `action_payload` JSONB
- `created_at`
- `updated_at`

## 12. Automation Domain

**DESIGNED — NOT MIGRATED.** `automations` and `automation_runs` do not
exist yet. The only production scheduler today is the Instagram runtime
(§8, runtime publishing controls).

### `automations`
- `id`
- `workspace_id`
- `name`
- `description`
- `automation_type`
- `trigger_config` JSONB
- `action_config` JSONB
- `status` — enum `automation_status`: `draft`, `active`, `paused`, `disabled`
- `created_by`
- `created_at`
- `updated_at`

**MVP staging:** the `automations`/`automation_runs` schema is
infrastructure that may exist from MVP-0 Foundation to support
system-defined internal jobs (e.g. a scheduled metric-sync run). End-user
configurable automation *product functionality* (marketer-authored
workflows, triggers, and approval-bypassing policies referenced in PRD §11)
is deferred until the core operating loop (MVP-0 through MVP-4) is stable,
per DECISIONS #20. This table existing early does not imply the automation
product surface ships early.

### `automation_runs`
- `id`
- `workspace_id`
- `automation_id`
- `status` — enum `automation_run_status`: `queued`, `running`, `completed`, `failed`, `cancelled`
- `triggered_at`
- `started_at`
- `completed_at`
- `output` JSONB
- `error_code`
- `error_message`
- `created_at`

`UNIQUE (id, workspace_id)` — supports composite FKs (§16).

**Traceability convention:** `output` JSONB must contain a structured
`created_entities` array of `{ "entity_type": "...", "entity_id": "..." }`
objects for every row (content, content_version, publication, ai_job,
insight, recommendation, etc.) the run created or modified, in addition to
any free-form summary. Every such creation/modification also produces a
corresponding `audit_logs` row whose `metadata` JSONB includes
`automation_run_id`, so automation-originated changes are auditable through
both the `automation_runs` record and the general audit trail. AI jobs
triggered by a run are additionally linked directly via
`ai_jobs.automation_run_id` (§10).

## 13. Audit Domain

### `audit_logs`
- `id`
- `workspace_id`
- `actor_user_id` nullable
- `action`
- `entity_type`
- `entity_id`
- `metadata` JSONB
- `created_at`

Audit history must not be casually deleted.

**MVP staging:** audit logging is part of **MVP-0 Foundation**. The table
and its write path must exist before Content (MVP-1) begins, so that every
subsequent domain (Content, Distribution, Analytics, Intelligence) is
auditable from its first write, not retrofitted later.

`metadata` JSONB carries cross-references such as `automation_run_id` or
`ai_job_id` when the action was not directly initiated by a human actor.

## 14. Notification Domain

### `notifications`
- `id`
- `workspace_id`
- `user_id`
- `type`
- `title`
- `message`
- `data` JSONB
- `read_at`
- `created_at`

**MVP staging:** the schema may exist earlier, but notifications are
introduced as a used feature around Distribution/Analytics (MVP-2/MVP-3) —
e.g. publication failure, metric sync completion — rather than being a
Foundation requirement.

## 15. Relationships

Core content flow:

```text
opportunity
  ↓ 1:N
content_brief
  ↓ 1:N
content ──── brand (N:1, composite-FK tenant-checked)
  ↓ 1:N
content_version ──── ai_job (N:1 optional, composite-FK tenant-checked)
  ↓ 1:N
content_variant
  ↓ 1:N
publication
  ↓ 1:N
publication_metric_snapshot
  ↓
content_performance_score
  ↓
insight
  ↓
recommendation
```

Intelligence flow:

```text
marqos_signal_source → marqos_signals ↔ topics → opportunities
```

Brand flow:

```text
workspace → brands → brand_identity   (workspace_id direct + composite FK)
                    → brand_voice     (workspace_id direct + composite FK)
                    → audience_profiles (workspace_id direct + composite FK)
                    → content_pillars   (workspace_id direct + composite FK)
```

Evidence flow (closed typed-FK design, §11):

```text
insight_evidence → exactly one of:
  signal | topic | opportunity | content | publication | publication_metric_snapshot
```

AI/automation flow:

```text
automation_run → ai_job → content_version | asset
automation_run → output.created_entities[] (content, publications, ...)
```

## 16. Tenant Consistency Enforcement

Redundant `workspace_id` columns introduced under Principle 7 must never be
allowed to drift from their parent's `workspace_id`. This is enforced with
composite foreign keys, not application code alone.

**Pattern:**

1. Every parent table used as a composite-FK target carries
   `UNIQUE (id, workspace_id)` (trivially satisfiable, since `id` is
   already a primary key).
2. Every child table that carries a denormalized `workspace_id` also
   carries a composite foreign key `(parent_id, workspace_id) REFERENCES
   parent (id, workspace_id)`, in addition to the plain `parent_id` foreign
   key. PostgreSQL composite foreign keys use `MATCH SIMPLE` by default, so
   a composite FK built on a nullable reference column (e.g. an optional
   `brand_id`) is only checked when that column is non-null — it does not
   force the column to be set.

**Tables carrying a composite tenant-consistency FK:**

- `content_versions (content_id, workspace_id)` → `content (id, workspace_id)`
- `content_variants (content_version_id, workspace_id)` → `content_versions (id, workspace_id)`
- `brand_identity (brand_id, workspace_id)`, `brand_voice (brand_id, workspace_id)`,
  `audience_profiles (brand_id, workspace_id)`, `content_pillars (brand_id, workspace_id)`
  → `brands (id, workspace_id)`
- `marqos_content_assets (content_id, workspace_id)` → `content (id, workspace_id)`;
  `marqos_content_assets (asset_id, workspace_id)` → `marqos_assets (id, workspace_id)`
- `signal_topics (signal_id, workspace_id)` → `marqos_signals (id, workspace_id)`;
  `signal_topics (topic_id, workspace_id)` → `topics (id, workspace_id)`
- `publications (content_variant_id, workspace_id)` → `content_variants (id, workspace_id)`;
  `publications (social_account_id, workspace_id)` → `social_accounts (id, workspace_id)`
- `content_versions (ai_job_id, workspace_id)` → `ai_jobs (id, workspace_id)` (nullable)
- `marqos_assets (ai_job_id, workspace_id)` → `ai_jobs (id, workspace_id)` (nullable)
- `ai_jobs (automation_run_id, workspace_id)` → `automation_runs (id, workspace_id)` (nullable)
- Every optional `brand_id` alongside `workspace_id`
  (`content_briefs`, `content`, `opportunities`, `social_accounts`,
  `marqos_assets`, `insights`) → `brands (id, workspace_id)` (nullable)
- `insight_evidence`'s six evidence columns, each paired with `workspace_id`,
  against their respective target tables (§11)

This makes the data-integrity rules in §21 ("publication workspace must
match content variant workspace," "asset workspace must match content
association workspace," "insight evidence must belong to the same
workspace") database-enforced, not only application-layer conventions,
consistent with ERD constraint #6 (no cross-workspace foreign
relationships).

## 17. Content Approval → Publication Gate

This section defines the authoritative relationship between
`content.status`, `content_approvals`, `content_variants.status`, and
`publications.status`.

**Status responsibilities:**

- `content.status` — a rollup convenience field reflecting overall creative
  production stage, for UI/listing. Not authoritative for publishing
  authorization.
- `content_approvals` — the append-only, auditable record of approval
  decisions. This is the sole source of truth for "has this been
  approved," and specifically, for which `content_version_id`.
- `content_variants.status` — whether a specific platform adaptation is
  ready for distribution.
- `publications.status` — the distribution lifecycle of a specific variant
  to a specific social account.

**The gate:** a `publications` row must not transition into `scheduled`,
`publishing`, or `published` unless a `content_approvals` row exists with
`status = 'approved'` and `content_version_id` equal to the
`content_version_id` of the publication's `content_variant`
(`publications.content_variant_id → content_variants.content_version_id`).

**Enforcement (both layers required, not either/or):**

- *Server-side:* the application service that transitions publication
  status (e.g. `SchedulePublication`) queries for a matching approved
  `content_approvals` row before performing the transition, and rejects
  the operation with an explicit error otherwise.
- *Database-level:* a `BEFORE INSERT OR UPDATE` trigger on `publications`
  (`enforce_publication_approval_gate`) raises an exception if `NEW.status`
  is `scheduled`, `publishing`, or `published` and no matching approved
  `content_approvals` row exists. This makes the gate authoritative even
  against direct database access — mirroring how RLS is authoritative for
  tenant isolation regardless of application-layer checks.

`content.status` may be kept in sync as a rollup (e.g. set to `approved`
when the relevant `content_approvals` row is recorded as `approved`), but
the gate above never reads `content.status` — it always checks
`content_approvals` directly, so approval remains a separate, auditable
process as required.

## 18. Indexing Strategy

Prioritize:

- `workspace_id` on every table that carries it (including the
  newly-direct `content_versions`, `content_variants`, `brand_identity`,
  `brand_voice`, `audience_profiles`, `content_pillars`, `signal_topics`,
  `marqos_content_assets`)
- All foreign keys, including the new `ai_job_id`, `automation_run_id`,
  and the six `insight_evidence` evidence columns
- `(workspace_id, scheduled_at)`, `(workspace_id, status)` on `publications`
- `publication_attempts (publication_id, attempt_number)` unique and the
  partial "one non-terminal attempt" unique index
- `(publication_id, captured_at)` on `publication_metric_snapshots`
- `(workspace_id, captured_at)`
- `(content_id, version_number)` unique index on `content_versions`
- Partial unique index `(workspace_id, purpose) WHERE is_active` on
  `prompt_versions`
- Composite unique `(id, workspace_id)` on every table listed as a
  composite-FK target in §16 (required for the FK to be valid in
  PostgreSQL, and useful as a covering index for tenant-scoped lookups)
- Common content/topic/opportunity status filters

Avoid indiscriminate indexing; add indexes based on observed query
patterns.

## 19. Delete / Archive Policy

Soft/archive preferred for workspaces, brands, content, marqos_assets,
social accounts, and automations — archival sets a status/`archived_at`
value and never removes the row.

**Never hard-deleted, under any circumstance:** `content_versions`,
`content_variants`, `publications`, `publication_metric_snapshots`,
`content_performance_scores`, `content_approvals`, `audit_logs`,
`ai_jobs`, `ai_usage`, and `automation_runs`. These are historical/audit
records; DECISIONS #7 and #14 require that archiving or deleting creative
content must not destroy historical publication, analytics, approval, AI
execution, or automation history.

**Foreign key delete semantics:** every foreign key that points *at* a
historical-record table uses `ON DELETE RESTRICT` (or `NO ACTION`), never
`CASCADE`:

- `content_variants.content_version_id` → `content_versions.id`: `RESTRICT`
- `publications.content_variant_id` → `content_variants.id`: `RESTRICT`
- `publication_metric_snapshots.publication_id` → `publications.id`: `RESTRICT`
- `content_performance_scores.publication_id` / `.content_id`: `RESTRICT`
- Any FK into `content`, `content_versions`, `content_variants`,
  `marqos_assets`, or `publications` from `content_approvals`,
  `insight_evidence`, or `marqos_content_assets`: `RESTRICT`

In practice this means a `content` row can be archived (`archived_at` set,
`status = 'archived'`) while its versions, variants, and publications
remain in place permanently and remain queryable for history/analytics —
archiving never cascades into deletion of descendants. There is no
supported path to hard-delete a `content_version`, `content_variant`, or
`publication` through normal application operation; only a manually
approved, explicitly-logged destructive migration (DECISIONS #17) could do
so, and only after every RESTRICT-protected dependent has itself been
resolved.

No generic `ON DELETE CASCADE` is used without explicit consideration of
historical implications, and cascades are never used across the boundary
into a historical-record table.

## 20. RLS Strategy

All workspace-scoped tables have RLS enabled **at creation time**, in the
same migration that creates the table (Principle 8). A migration that
creates a table without also enabling RLS and defining its policies is
non-conforming and must be rejected in review.

Conceptually:

```text
authenticated user
      ↓
workspace membership
      ↓
authorized role
      ↓
row access
```

Policies cover SELECT/INSERT/UPDATE/DELETE as appropriate. Viewers must not
receive write access simply because they can read. `content_versions` has
no UPDATE policy at all (immutability is enforced at the RLS layer, not
just by convention) and no DELETE policy for any role (historical
protection, §19).

**RLS testing requirement:** every exposed workspace-scoped table must have
automated tests verifying (a) an authenticated member of the owning
workspace can perform the operations their role permits, and (b) an
authenticated user who is *not* a member of that workspace is denied
access entirely (not merely filtered to zero rows via a bug, but denied by
policy). This is a Definition-of-Done requirement, not optional hardening
(see Engineering Blueprint §24, §31).

## 21. Data Integrity Rules

- Content version numbers unique per content.
- Workspace membership unique per user/workspace.
- Provider external IDs protected against duplicates.
- Scheduled publication requires a valid social account.
- Publication workspace must match content variant workspace — enforced by
  composite FK (§16), not only convention.
- Asset workspace must match content association workspace — enforced by
  composite FK (§16).
- Insight evidence must belong to the same workspace as the insight and as
  whichever single evidence target it references — enforced by composite
  FK (§16) plus the exactly-one-target CHECK constraint (§11).
- Exactly one of `content_performance_scores.publication_id` /
  `.content_id` is set, consistent with `score_scope` (§9).
- `publications` may not enter `scheduled`/`publishing`/`published`
  without a matching approved `content_approvals` row for the resolved
  `content_version_id` (§17), enforced both server-side and via database
  trigger.
- At most one active `prompt_versions` row per `(workspace_id, purpose)`
  scope (partial unique index, §10).
- `ai_jobs.trigger_type` determines which of `requested_by` /
  `automation_run_id` must be populated (§10).
- `content_versions`, `content_variants`, and `publications` are never
  hard-deleted; dependent FKs use `RESTRICT` (§19).

## 22. Schema Evolution

New tables/columns are introduced through migrations. Avoid premature
normalization of provider-specific fields. Extend the model rather than
repurposing entities with ambiguous meaning. Controlled value sets (enums
/ CHECK constraints) are extended via migration when a genuinely new state
is needed — status vocabularies are not left open-ended to avoid this
discipline.

Adding a new `insight_evidence` source type requires a migration adding a
new nullable FK column and updating the exactly-one-target CHECK
constraint (§11) — this is the intended, reviewable extension path in
place of an unrestricted polymorphic reference.

## 23. Future Domains

Future paid-media entities should be separate: ad accounts, campaigns, ad
sets, ads, ad metrics, attribution, conversion events, and experiments.

A vector/embedding column (e.g. `pgvector` on `marqos_signals` or `topics`) for
semantic similarity search is a documented future extension point for the
Intelligence domain (§4). It is allowed where the Trend Signal V1 contract
justifies it (Decision #48), and is not required.

## 24. Planned Future Entities (PLANNED FUTURE — NOT MIGRATED)

Direction only. No columns, enums or constraints are final, and no
migration is authorized by this section. Each item is specified by the
contract of the track named.

- **Content Idea** (Track 3, Decision #49):
  - Opportunity 1:N Content Idea;
  - operator review state (proposed / approved / edited / rejected) and
    history;
  - a link from an approved idea to a Brief.
  The existing optional `content_briefs.opportunity_id` link (EXISTS NOW)
  remains valid.
- **Structured creative plans** (Track 4, Decision #49):
  - per-format structures (single image; carousel slides; video
    storyboard scenes, script/VO, on-screen text);
  - likely child records of the brief/creative plan rather than JSON
    only — to be decided in Track 4.
- **Trend Signal pipeline records** (Track 2, Decision #48):
  - connector/ingestion runs;
  - normalized signal fields kept separate from `raw_data`;
  - cluster/topic membership provenance;
  - per-brand relevance.
  `marqos_signal_sources`, `marqos_signals`, `topics`, `signal_topics` and
  `opportunities` EXIST NOW and are reused where semantically correct.
- **Integrations** (Decision #51):
  - credential metadata per workspace (secret in Vault by reference,
    write-only);
  - webhook endpoints and signing secrets;
  - audit of create/rotate/delete.
- **Marq** (Decision #52): persisted, workspace-scoped conversations and
  messages with context/provenance references.
- **Provider expansion** (Track 5, Decision #50):
  - `social_platform` + `facebook` (the enum today is `instagram`,
    `tiktok`, `youtube`, `threads`);
  - a generalized provider checkpoint and runtime keys.
- **Credential lifecycle** (Track 1, Decision #47): representation of an
  account requiring reconnection. The existing `social_account_status`
  values `expired`/`error` may suffice — to be decided in Track 1.

Explicitly NOT ready for migration:
- every item in this section until its track contract is approved;
- embedding columns;
- paid-media entities (§23).
