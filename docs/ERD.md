# MARQOS — Marketing Operating System — Entity Relationship Diagram

**Version:** 1.2
**Status:** Approved — v1.2, Owner approval 2026-09-25 (Track 0, PR #5).
Supersedes the unapproved v1.1 draft (2026-09-15).
**Date:** 2026-09-25

**Reality markers.** EXISTS NOW = migrated; DESIGNED — NOT MIGRATED =
specified but no table exists; PLANNED FUTURE = direction only (Database
Architecture §24). Unmarked entities exist.

## 1. ERD Purpose

This document defines the canonical logical relationships between
Marketing OS entities. It is independent of UI layout and serves as the
relationship contract from which PostgreSQL foreign keys and constraints
are derived, including the tenant-consistency composite foreign keys
defined in Database Architecture §16.

## 2. Identity ERD

```text
auth.users
    │ 1:1
    ▼
profiles
    │
    ▼
workspace_members
    ▲
    │
workspaces
```

More precisely: `profiles N:M workspaces` through `workspace_members`.

## 3. Workspace / Brand ERD

```text
workspaces
    │ 1:N
    ▼
brands
    ├── 1:1 → brand_identity      (+ workspace_id direct, composite FK)
    ├── 1:1 → brand_voice         (+ workspace_id direct, composite FK)
    ├── 1:N → audience_profiles   (+ workspace_id direct, composite FK)
    └── 1:N → content_pillars     (+ workspace_id direct, composite FK)
```

`brand_identity`, `brand_voice`, `audience_profiles`, and `content_pillars`
each carry `workspace_id` directly for RLS/query performance, in addition
to `brand_id`. A composite foreign key `(brand_id, workspace_id) →
brands (id, workspace_id)` guarantees the denormalized value can never
diverge from the parent brand's workspace.

## 4. Intelligence ERD

```text
workspaces
    ├── 1:N → marqos_signal_sources → 1:N → marqos_signals
    ├── 1:N → topics
    └── 1:N → opportunities

marqos_signals N:M topics through signal_topics (workspace_id direct on the junction)

topics 1:N opportunities
brands 1:N opportunities
```

`marqos_signal_sources`/`marqos_signals` are prefixed, not named
`signal_sources`/`signals` (MVP-5.24/MVP-5.25 owner decision): the hosted
Supabase project also contains a differently-shaped, pre-existing table
pair of those names belonging to a separate application sharing the
project. `topics`/`signal_topics`/`opportunities` do not collide and keep
their original names.

Topic grouping (signal → topic) is achieved via AI/provider classification
plus the relational `signal_topics` junction. No vector/embedding entity
is part of the MVP Intelligence ERD; it is a documented future extension
point (Database Architecture §23).

## 5. Content Planning ERD

```text
opportunities
      │ 1:N
      ▼
content_briefs ──── brands (N:1, composite-FK tenant-checked)
      ├── N:1 optional → audience_profiles
      └── N:1 optional → content_pillars
```

A content brief may exist without an opportunity. `content_briefs.brand_id`
is composite-FK-checked against `brands (id, workspace_id)`.

## 6. Core Content ERD

```text
content_briefs
      │ 1:N
      ▼
content ──── brands (N:1, composite-FK tenant-checked)
      │ 1:N
      ▼
content_versions ──── ai_jobs (N:1 optional, composite-FK tenant-checked)
      │ 1:N
      ▼
content_variants
```

Content = conceptual creative object.

Content Version = immutable creative state. Never hard-deleted. Optionally
traceable to the AI job that generated it via `content_versions.ai_job_id`
(`NULL` for human-authored versions).

Content Variant = platform/context adaptation. Never hard-deleted once a
publication references it.

Both `content_versions` and `content_variants` carry `workspace_id`
directly (denormalized from `content`), each composite-FK-checked against
its immediate parent (Database Architecture §16).

## 7. Content / Asset ERD

```text
content ──── brands (N:1, composite-FK tenant-checked)
   │ N:M
   ▼
marqos_content_assets (workspace_id direct on the junction)
   ▲
   │ N:M
marqos_assets ──── ai_jobs (N:1 optional, composite-FK tenant-checked)
   │
   └── brands (N:1 optional, composite-FK tenant-checked)
```

`marqos_assets`/`marqos_content_assets` are prefixed, not named
`assets`/`content_assets` (MVP-5.24/MVP-5.25 owner decision): the hosted
Supabase project also contains a differently-shaped, pre-existing table
pair of those names belonging to a separate application sharing the
project. The `assets` Storage bucket (Foundation) is unaffected and keeps
its original name — it is a different namespace from the database table.

`marqos_content_assets` is the content-level asset library. The exact,
ordered media a *publication* of a variant publishes is selected at variant
level (MVP-5.35B, Decision #43):

```text
content_variants
      ↓
marqos_content_variant_assets (workspace_id direct on the junction)
      ↓
marqos_assets
```

`marqos_content_variant_assets.sort_order` is the publish order (carousel
slide order when carousels are implemented; `0` for a single image) and is
unique per variant; the same asset appears at most once per variant.
Composite FKs to `content_variants (id, workspace_id)` and
`marqos_assets (id, workspace_id)`. Content-level bindings are unaffected.
`marqos_assets.ai_job_id` traces AI-generated assets (e.g. AI image
generation output) back to the producing job; `NULL` for uploaded/
human-sourced assets.

## 8. Approval ERD

```text
content
   │ 1:N
   ▼
content_approvals
```

Approval history is append-oriented and may reference a particular content
version via `content_approvals.content_version_id`. An approval intended
to authorize publishing **must** reference a `content_version_id` — see
§9a, the Publication Approval Gate.

## 9. Distribution ERD

```text
social_accounts
      │ 1:N
      ▼
publications
      ▲
      │ N:1
content_variants
```

A content variant can have multiple publications across connected
accounts. `publications` carries `workspace_id` directly and is
composite-FK-checked against both `content_variants (id, workspace_id)`
and `social_accounts (id, workspace_id)`. `publications` rows are never
hard-deleted.

`social_accounts.vault_secret_id` references a Supabase Vault secret; no
raw credential is stored in the relational schema (Database Architecture
§8).

### 9c. Runtime Publishing Controls (EXISTS NOW; Decisions #44, #45)

```text
publishing_runtime_control      (singleton, key 'instagram_scheduled_publishing')
publishing_runtime_allowlist ──── social_accounts (1:1 optional, composite FK (id, workspace_id))
publishing_runtime_slot_lease   (one row per DB-clock 5-minute slot; run_id unique)
publication_attempts.last_run_id ··· slot_lease.run_id (logical reference, no FK)
```

All three are service-role only (RLS enabled, no policies) and
Instagram-keyed. See Database Architecture §8.

### 9b. Publication Attempts (provider checkpoint)

```text
publications
      ↓
publication_attempts
```

One `publications` row has 0..N `publication_attempts` (MVP-5.35B,
Decision #43), numbered 1, 2, 3… per publication, with at most one
non-terminal attempt at a time. Provider progress (container ids, remote
media id) lives here; the MARQOS lifecycle stays in `publications.status`.
Composite FK to `publications (id, workspace_id)`. Attempts are an
append/audit record (no hard delete; terminal attempts immutable).

### 9a. Publication Approval Gate

```text
content_versions
      │
      ▼ (content_version_id)
content_approvals (status = 'approved')
      │
      ▼ authorizes
content_variants → publications (status ∈ {scheduled, publishing, published})
```

A publication may not enter `scheduled`, `publishing`, or `published`
unless an approved `content_approvals` row exists for the
`content_version_id` behind its `content_variant`. This is enforced both
server-side and by a database trigger (Database Architecture §17), not by
`content.status` alone.

## 10. Calendar ERD

There is no `calendar` entity.

Calendar is a projection over:

```text
publications
  ├── scheduled_at
  ├── status
  ├── social_account
  └── content_variant
```

## 11. Analytics ERD

```text
publications
      │ 1:N
      ▼
publication_metric_snapshots
      │
      ▼
content_performance_scores (score_scope: publication | content)
```

`content_performance_scores` references exactly one of `publication_id` /
`content_id`, matching `score_scope` (CHECK constraint, Database
Architecture §9). Historical snapshots are preserved and never
overwritten.

## 12. Optimization ERD

**DESIGNED — NOT MIGRATED** (Track 7). The relationships below are the
design; no table exists yet.

```text
insights ──── brands (N:1 optional, composite-FK tenant-checked)
   ├── 1:N → insight_evidence
   └── 1:N → recommendations
```

`insight_evidence` no longer uses an unrestricted polymorphic reference.
It carries six nullable typed foreign keys, exactly one of which is
populated per row (CHECK constraint):

```text
insight_evidence → exactly one of:
    marqos_signals
    topics
    opportunities
    content
    publications
    publication_metric_snapshots
```

Each populated FK is composite-FK-checked against its target's
`(id, workspace_id)`, so evidence can never cross a workspace boundary.

## 13. AI ERD

```text
workspaces
    │ 1:N
    ▼
ai_jobs ──── automation_runs (N:1 optional, composite-FK tenant-checked)
    ├── 1:N
    │   ▼
    │   ai_usage
    └── N:1 optional → prompt_versions (plain FK, not composite-FK-checked —
        prompt_versions.workspace_id is nullable for global prompts;
        resolution: workspace-specific active > global active)

content_versions ◄── ai_jobs (N:1 optional)
marqos_assets     ◄── ai_jobs (N:1 optional)
```

`ai_jobs.trigger_type` (`user` | `automation` | `system`) identifies the
origin of every execution. `requested_by` is populated for `user`;
`automation_run_id` is populated for `automation`. Structured, closed
foreign keys are used in place of an unrestricted polymorphic graph:
`ai_jobs` links forward to `content_versions`/`marqos_assets` via those
tables' `ai_job_id` columns, not via a generic reference on `ai_jobs`
itself.

`ai_jobs.prompt_version_id` is a plain, optional forward link to the
`prompt_versions` row that produced the job's request (Database
Architecture §10, DECISIONS #26). It is deliberately excluded from the
composite tenant-consistency FK pattern (§16) because a global prompt
(`prompt_versions.workspace_id IS NULL`) has no single workspace to check
against.

## 14. Automation ERD

**DESIGNED — NOT MIGRATED.** The relationships below are the design; no
table exists yet.

```text
workspaces
    │ 1:N
    ▼
automations
    │ 1:N
    ▼
automation_runs
    │ 1:N (optional)
    ▼
ai_jobs
```

`automation_runs.output` carries a structured `created_entities` list
identifying every row the run created or modified; each such
creation/modification also produces an `audit_logs` row referencing the
`automation_run_id`, so automation-originated changes remain auditable
through two independent paths.

**MVP staging:** this schema may exist from MVP-0 Foundation for
system-defined jobs; end-user-configurable automation product
functionality is deferred until the core operating loop (MVP-0–MVP-4) is
stable.

## 15. Audit ERD

```text
workspaces 1:N audit_logs
profiles   1:N audit_logs
```

An audit log may have a nullable actor for system-generated actions, and
carries `automation_run_id`/`ai_job_id` in `metadata` when relevant.
Audit logging is part of MVP-0 Foundation (Database Architecture §13).

## 16. Notification ERD

```text
workspaces 1:N notifications
profiles   1:N notifications
```

Introduced as a used feature around Distribution/Analytics (MVP-2/MVP-3),
not required at Foundation.

## 17. Complete Logical Flow

```text
SIGNAL_SOURCE
     ↓
SIGNAL
     ↓ N:M
TOPIC
     ↓
OPPORTUNITY
     ↓
CONTENT IDEA  [PLANNED FUTURE — Track 3; operator approve/edit/reject]
     ↓
CONTENT BRIEF  (may also be authored directly; optional opportunity link EXISTS NOW)
     ↓
CONTENT ──── brand
     ↓
CONTENT VERSION ──── ai_job (optional)
     ↓
CONTENT VARIANT
     ↓
[ Publication Approval Gate: content_approvals(status=approved) ]
     ↓
PUBLICATION
     ↓
METRIC SNAPSHOT
     ↓
PERFORMANCE SCORE (scope: publication | content)
     ↓
INSIGHT  [DESIGNED — NOT MIGRATED]
     ├── EVIDENCE (typed: signal | topic | opportunity | content | publication | metric_snapshot)
     └── RECOMMENDATION  [DESIGNED — NOT MIGRATED]
              ↓
          NEXT ACTION / NEW CONTENT (new content idea or brief)
```

The loop matches PRD §1 and Decision #49. Marq (Decision #52) is a
horizontal layer, not a stage in this flow.

## 18. Complete Entity List

### Identity
profiles, workspaces, workspace_members

### Brand
brands, brand_identity, brand_voice, audience_profiles, content_pillars

### Intelligence
marqos_signal_sources, marqos_signals, topics, signal_topics, opportunities

### Content
content_briefs, content, content_versions, content_variants, marqos_assets,
marqos_content_assets, marqos_content_variant_assets, content_approvals

### Distribution
social_accounts, publications, publication_attempts,
publishing_runtime_control, publishing_runtime_allowlist,
publishing_runtime_slot_lease

### Analytics
publication_metric_snapshots, content_performance_scores

### AI
ai_jobs, ai_usage, prompt_versions

### Optimization — DESIGNED — NOT MIGRATED
insights, insight_evidence, recommendations

### Automation — DESIGNED — NOT MIGRATED
automations, automation_runs

### System
audit_logs, notifications

No new entities were introduced while resolving the specification gaps —
all changes are new columns/constraints on existing entities.

### Planned future — NOT MIGRATED (Database Architecture §24)
Content Idea; structured creative plans; Trend Signal pipeline records;
integration credential metadata and webhooks; Marq conversations and
messages; `social_platform` value `facebook`; generalized provider
checkpoint. None exists and none is authorized for migration.

## 19. Cardinality Lock

Rows involving `insights`, `insight_evidence`, `recommendations`,
`automations` and `automation_runs` describe DESIGNED — NOT MIGRATED
entities.

| Relationship | Cardinality |
|---|---|
| auth.users → profiles | 1:1 |
| profiles ↔ workspaces | N:M via workspace_members |
| workspaces → brands | 1:N |
| brands → brand_identity | 1:1 (+ workspace_id composite FK) |
| brands → brand_voice | 1:1 (+ workspace_id composite FK) |
| brands → audience_profiles | 1:N (+ workspace_id composite FK) |
| brands → content_pillars | 1:N (+ workspace_id composite FK) |
| workspaces → marqos_signal_sources | 1:N |
| marqos_signal_sources → marqos_signals | 1:N |
| marqos_signals ↔ topics | N:M via signal_topics (workspace_id direct on junction) |
| topics → opportunities | 1:N |
| brands → opportunities | 1:N |
| opportunities → content_briefs | 1:N |
| brands → content_briefs | 1:N (composite-FK tenant-checked) |
| content_briefs → content | 1:N |
| brands → content | 1:N (composite-FK tenant-checked) |
| content → content_versions | 1:N |
| ai_jobs → content_versions | 1:N optional (composite-FK tenant-checked) |
| content_versions → content_variants | 1:N |
| content ↔ marqos_assets | N:M via marqos_content_assets (workspace_id direct on junction) |
| content_variants ↔ marqos_assets | N:M ordered via marqos_content_variant_assets (workspace_id direct on junction; publish selection) |
| brands → marqos_assets | 1:N optional (composite-FK tenant-checked) |
| ai_jobs → marqos_assets | 1:N optional (composite-FK tenant-checked) |
| content → content_approvals | 1:N |
| content_versions → content_approvals | 1:N optional |
| brands → social_accounts | 1:N |
| content_variants → publications | 1:N |
| publications → publication_attempts | 1:N (≤1 non-terminal) |
| social_accounts → publications | 1:N |
| publications → publication_metric_snapshots | 1:N |
| publications → content_performance_scores | 1:N optional (score_scope = publication) |
| content → content_performance_scores | 1:N optional (score_scope = content) |
| insights → insight_evidence | 1:N |
| brands → insights | 1:N optional (composite-FK tenant-checked) |
| marqos_signals → insight_evidence | 1:N optional (exactly-one-of-six CHECK) |
| topics → insight_evidence | 1:N optional (exactly-one-of-six CHECK) |
| opportunities → insight_evidence | 1:N optional (exactly-one-of-six CHECK) |
| content → insight_evidence | 1:N optional (exactly-one-of-six CHECK) |
| publications → insight_evidence | 1:N optional (exactly-one-of-six CHECK) |
| publication_metric_snapshots → insight_evidence | 1:N optional (exactly-one-of-six CHECK) |
| insights → recommendations | 1:N |
| workspaces → ai_jobs | 1:N |
| ai_jobs → ai_usage | 1:N |
| prompt_versions → ai_jobs | 1:N optional (plain FK, not composite — prompt_versions may be global) |
| automation_runs → ai_jobs | 1:N optional (composite-FK tenant-checked) |
| workspaces → automations | 1:N |
| automations → automation_runs | 1:N |
| workspaces → audit_logs | 1:N |
| profiles → audit_logs | 1:N |
| workspaces → notifications | 1:N |
| profiles → notifications | 1:N |

## 20. Architectural Constraints

1. Do not create a calendar table.
2. Do not create separate core content tables for Instagram/TikTok/YouTube.
3. Do not merge content with publication.
4. Do not merge raw metrics with derived scores.
5. Do not overwrite content versions.
6. Do not allow cross-workspace foreign relationships — enforced via
   composite foreign keys against parent `(id, workspace_id)` pairs
   (Database Architecture §16), not application code alone.
7. Do not use unrestricted polymorphic relations as the primary relational
   design — `insight_evidence` uses a closed set of typed nullable foreign
   keys with an exactly-one-target CHECK constraint instead.
8. Do not cascade-delete historical analytics/publication/audit data —
   `content_versions`, `content_variants`, and `publications` are never
   hard-deleted; dependent foreign keys use `RESTRICT`/`NO ACTION`.
9. Keep future paid-media entities separate from organic content entities.
10. Do not enable RLS after the fact — every table is created with RLS
    enabled and its policies defined in the same migration.
11. Do not authorize publishing from `content.status` alone — the
    Publication Approval Gate always checks `content_approvals` directly
    (§9a).
12. Do not store raw social platform credentials in relational columns —
    only a Supabase Vault secret reference is stored; Vault access is
    server-side only.
