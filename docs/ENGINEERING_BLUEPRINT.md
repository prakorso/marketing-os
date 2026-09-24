# Marketing Operating System — Engineering Blueprint

**Version:** 1.1
**Status:** Canonical specification — pending explicit approval
**Date:** 2026-09-15

## 1. Architecture Goal

Build a maintainable multi-tenant web application where:
- Next.js provides the application/UI layer.
- Supabase provides PostgreSQL, Auth, Storage, and RLS.
- GitHub is the source of truth for code and migrations.
- Netlify hosts the web application.
- OpenAI is integrated behind an AI provider abstraction.
- Social platforms are integrated behind provider adapters.
- Background/long-running work is modeled as observable jobs.

The architecture must allow evolution without coupling the core domain to one AI provider or social platform.

## 2. Proposed Technology Stack

Application: Next.js, TypeScript, React, Tailwind CSS, and an appropriate component system.

Backend/Data: Supabase PostgreSQL, Supabase Auth, Supabase Storage, Supabase RLS, and server-side application services.

AI: OpenAI initially, behind a provider abstraction from day one.

Deployment: GitHub, Netlify, preview deployments, production deployment after validation.

Testing: TypeScript type checking, unit tests, integration tests, database/RLS tests, provider adapter tests, and end-to-end tests for critical flows.

## 3. High-Level Architecture

```text
USER
  ↓
NEXT.JS APP
  ↓
APPLICATION SERVICES
  ├── Intelligence
  ├── Content
  ├── Distribution
  ├── Analytics
  ├── AI
  └── Automation
  ↓
Supabase / AI Provider Adapters / Social Provider Adapters
```

## 4. Architectural Layers

### Presentation
Rendering UI, collecting input, displaying state, and safe client interaction. It must not contain authoritative business rules.

### Application
Use cases, orchestration, authorization checks, domain services, transaction boundaries, and job creation.

Examples: CreateContent, GenerateContent, ApproveContent, SchedulePublication, SyncPublicationMetrics, CreateInsight.

### Domain
Stable concepts: Workspace, Brand, Signal, Topic, Opportunity, Content, Publication, Metrics, Insight. Domain logic must not depend directly on OpenAI or a specific social platform.

### Infrastructure
Supabase queries, storage, AI provider clients, social provider clients, external API calls, job execution, and logging.

## 5. Suggested Repository Structure

```text
marketing-os/
├── docs/
├── src/
│   ├── app/
│   ├── components/
│   ├── features/
│   │   ├── intelligence/
│   │   ├── content/
│   │   ├── distribution/
│   │   ├── analytics/
│   │   ├── ai/
│   │   └── automation/
│   ├── lib/
│   │   ├── supabase/
│   │   ├── auth/
│   │   ├── ai/
│   │   ├── social/
│   │   └── storage/
│   ├── server/
│   │   ├── services/
│   │   ├── repositories/
│   │   └── jobs/
│   └── types/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   └── seed.sql
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── database/
│   └── e2e/
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## 6. Authentication

Supabase Auth is authoritative for identity. Application profile data lives in `profiles`. Users are associated with workspaces through `workspace_members`. Password/authentication state is never duplicated in application tables.

## 7. Multi-Tenancy

Workspace is the primary tenant boundary.

Most workspace-scoped business tables should carry `workspace_id` directly where this simplifies RLS, querying, indexing, and tenant isolation. This applies in particular to high-traffic and FK-central tables that previously relied on multi-hop joins: `content_versions`, `content_variants`, `brand_identity`, `brand_voice`, `audience_profiles`, `content_pillars`, and relationship/junction tables where direct tenant filtering materially improves RLS (`signal_topics`, `content_assets`).

Redundant `workspace_id` values are not left to application-code discipline alone: they are enforced with composite foreign keys against the parent's `(id, workspace_id)`, per Database Architecture §16. A denormalized `workspace_id` that could silently diverge from its parent is treated as a data-integrity defect, not an acceptable tradeoff.

Every request must resolve an authenticated user and authorized workspace membership before workspace-scoped operations.

## 8. Authorization

Roles: owner, admin, marketer, viewer.

Application authorization is used for UX/business checks. Database authorization through Supabase RLS is authoritative for tenant isolation.

## 9. Content Architecture

```text
Content Concept
      ↓
Content Version
      ↓
Content Variant
      ↓
Publication
```

Content is the conceptual marketing asset. Content Version is an immutable creative state. Content Variant is a platform/context adaptation. Publication is an actual distribution instance.

Content Version and Content Variant are historical records: once created they are never hard-deleted (Database Architecture §19), and a Content Version is optionally traceable to the AI job that generated it via a nullable `ai_job_id` (`NULL` for human-authored versions). A publication may only move into `scheduled`/`publishing`/`published` once its content variant's version has an explicit approved `content_approvals` record — see §17, Publication Lifecycle.

## 10. AI Architecture

```text
Application Service
       ↓
AI Provider Interface
       ├── OpenAI
       ├── Future Provider A
       └── Future Provider B
```

Potential capabilities: `generate_text()`, `generate_image()`, `analyze_content()`, `analyze_signal()`, `generate_variants()`, `generate_insight()`.

UI components must not call OpenAI SDKs directly.

## 11. AI Job Model

Long-running or external AI work is represented by `ai_jobs`.

Lifecycle:

```text
queued → running → completed
                 → failed
                 → cancelled
```

Jobs record request, workspace, requester, provider, model, status, timestamps, errors, usage metadata, and output/reference.

Every job also records its **origin** via `trigger_type` (`user` | `automation` | `system`), so autonomous AI actions (PRD §11) remain distinguishable from human-initiated ones. `trigger_type = 'user'` requires `requested_by`; `trigger_type = 'automation'` requires `automation_run_id`, linking the job back to the automation run that triggered it.

Secrets are never exposed to the browser.

## 12. Prompt Management

Production prompts should be versioned using `prompt_versions`, allowing identification of purpose, version, template/configuration, active status, and metadata.

**Resolution precedence is deterministic:** a workspace-specific active prompt (`workspace_id` = current workspace, `is_active = true`) takes precedence over a global active prompt (`workspace_id IS NULL`, `is_active = true`) for the same `purpose`. A partial unique index guarantees at most one active prompt per scope per purpose, so resolution never has to arbitrate between two active candidates.

## 13. Image Generation Architecture

```text
Content Brief
  ↓
Creative Direction
  ↓
AI Image Job
  ↓
Generated Asset
  ↓
Asset Storage
  ↓
Content Asset Link
```

Reference images are input assets and are never overwritten. Generated outputs become new assets.

## 14. Carousel Architecture

A carousel is a content variant with ordered assets/content elements:

```text
Slide 1
Slide 2
Slide 3
...
Slide N
```

Ordering is deterministic and should not require platform-specific core models. The ordered assets are bound to the variant explicitly (`marqos_content_variant_assets`, Decision #43); content-level assets (`marqos_content_assets`) are a library and are never implicitly published. Carousel publishing itself is deferred until after the image-first slice.

## 15. Asset Storage

Supabase Storage is the media storage foundation. PostgreSQL stores metadata such as storage path, MIME type, dimensions, size, asset type, checksum where useful, metadata, ownership/workspace, and creation time. Binary files are not stored directly in PostgreSQL.

## 16. Social Integration Architecture

```text
Publication Service
        ↓
Social Provider Interface
        ├── Instagram Adapter
        ├── TikTok Adapter
        ├── YouTube Adapter
        ├── Threads Adapter
        └── Future Providers
```

Each adapter handles authentication/credential handling, publishing, scheduling capabilities where supported, metric retrieval, provider error normalization, and provider identifiers.

**Credential storage:** social platform OAuth access/refresh tokens and API keys are stored exclusively in **Supabase Vault**, never in an ordinary application table or column. `social_accounts` stores only a `vault_secret_id` reference plus non-secret metadata. Vault is read and written only from server-side code (server components, route handlers, job workers) using the service role; adapters resolve the live credential immediately before a provider call and never return it to client/browser code. This is the concrete mechanism behind "secrets are never exposed to the browser" (§11) as applied to third-party credentials, not just first-party API keys.

**Publishing idempotency and provider progress (Decision #43):** providers such as Instagram expose a multi-step publish (container → readiness → publish) with no provider-side idempotency key, so MARQOS owns idempotency: single-flight via the lifecycle triggers and the scheduler claim, a per-attempt provider checkpoint (`publication_attempts`) separate from the MARQOS lifecycle, and an explicit *unknown outcome* (`publish_outcome_unknown`) when a publish request may have succeeded remotely without confirmation — such a publication is never automatically retried or rescheduled until reconciled. Provider container states never become `publication_status` values. The first Instagram publishing slice supports a single eligible JPEG image per publication; carousel and Reel publishing, media conversion, and background video polling are deferred.

## 17. Publication Lifecycle

```text
draft → approved → scheduled → publishing → published
                                      └────→ failed
```

Cancellation is available from appropriate pre-publication states. Provider limitations are represented explicitly. A publication may re-enter `scheduled` only from `draft`, `approved`, `scheduled` (reschedule) or a `failed` state whose remote outcome is certain — never from `published`, `publishing` or `cancelled`, and never while a publish attempt is open (service check + database trigger, Database Architecture §8). `published_at` records the MARQOS time of the published transition.

**Approval gate:** a publication may not enter `scheduled`, `publishing`, or `published` unless an approved `content_approvals` record exists for the specific `content_version_id` behind its content variant. This is checked both by the application service performing the transition and by a database trigger on `publications` (Database Architecture §17), so the rule holds even against direct database access. `content.status` is a UI rollup only — it is never read as the authorization source for this gate. This resolves the previously undocumented relationship between `content.status`, `content_approvals`, `content_variants.status`, and `publications.status`: each has a distinct responsibility (creative rollup, authoritative approval record, variant readiness, distribution lifecycle, respectively), and only `content_approvals` gates publishing.

## 18. Analytics Architecture

```text
Provider Response
      ↓
Normalization
      ↓
Metric Snapshot
      ↓
Derived Score
      ↓
Insight
```

Raw provider metrics and normalized/derived metrics are conceptually separate. Historical snapshots are preserved. Normalization (translating a provider's raw response into this normalized vocabulary) is a distinct conceptual stage, owned by the Analytics Normalizer (Decisions #29, #32) — not folded silently into the provider adapter.

A Derived Score has an explicit `score_scope` (`publication` or `content`): a publication-scoped score evaluates one publication's metrics, a content-scoped score aggregates across that content's variants/publications. Exactly one of the corresponding foreign keys is set, matching the scope — this is a database constraint, not a convention (Database Architecture §9).

The "Derived Score" stage above is this architecture's target state. The current MVP-3 implementation does not yet occupy it: `content_performance_scores` currently stores a provisional passthrough of the provider-reported `engagement_rate`, not a genuinely derived calculation (Decision #31). This diagram is not weakened by that — a genuinely derived Marqos performance score remains the intended future state of this stage.

The pipeline above is refined, without changing its stages, by Decisions #37–#42: Provider → Provider Adapter → Raw Provider Response → Analytics Normalizer Dispatcher → Provider-specific Normalizer → Normalized Observation → Analytics Service → Metric Snapshot. Provider adapters return an unnormalized, provider-native raw response carrying a provider identity discriminant and an optional provider-reported observation timestamp (Decision #39); provider-specific normalizer modules, not the adapter, perform the translation into Marqos's normalized vocabulary and determine each metric's state, consulting a static, code-level provider capability declaration to distinguish "unsupported" from "unavailable" (Decisions #41, #42) — no per-account capability storage is introduced. A normalizer performs no network I/O and persists nothing; persistence remains the Analytics Service's responsibility.

Per-metric state (reported / unsupported / unavailable, Decision #33) is carried as an additive JSONB structure alongside the existing normalized metric columns, not as a new relational table (Decision #37); the exact column, key, and enum shape remains an implementation detail for a future migration milestone. `captured_at` uses the provider's own observation time when available, falling back to Marqos's sync time only when the provider does not expose one, with knowable provenance distinguishing the two (Decision #38) — the physical provenance representation likewise remains an implementation detail. `social_accounts.last_synced_at` is written inside `recordPublicationMetricSnapshot`'s successful path, monotonically, covering both direct and batch-sync calls (Decision #40); this requires no schema change.

## 19. Intelligence Architecture

```text
External Source
      ↓
Signal
      ↓
Topic
      ↓
Opportunity
      ↓
Content Brief
```

Signal = observed information. Topic = grouped subject. Opportunity = strategic interpretation/actionable opportunity.

MVP grouping of signals into topics uses AI/provider text classification (via the AI Provider Interface, §10) combined with relational grouping (`signal_topics`). `pgvector` or another embedding/similarity mechanism is not required for MVP merely because semantic search may eventually be useful — it remains a documented future extension point (Database Architecture §23), not a current dependency.

## 20. Insight Architecture

```text
Metrics / Signals
      ↓
Analysis
      ↓
Insight
      ↓
Evidence
      ↓
Recommendation
```

The evidence behind a recommendation must be inspectable.

## 21. Automation Architecture

Automation definitions are separate from execution runs:

```text
Automation
  ├── Run 001
  ├── Run 002
  └── Run 003
```

Runs record start, finish, status, trigger, errors, and output/reference.

The `output` reference is structured, not free-form: it must include a `created_entities` list identifying every row (content, publication, ai_job, insight, recommendation, etc.) the run created or modified. Each such creation/modification also writes an `audit_logs` row referencing the run, so automation-originated changes are auditable through both the run record and the general audit trail. AI jobs triggered by a run are linked directly via `ai_jobs.automation_run_id` and `ai_jobs.trigger_type = 'automation'`.

**MVP staging:** the `automations`/`automation_runs` schema may exist from MVP-0 Foundation to support system-defined internal jobs (e.g. scheduled metric sync). End-user-configurable automation product functionality — marketer-authored triggers/workflows and any policy permitting autonomous publishing (PRD §11) — is deferred until the core operating loop (MVP-0 through MVP-4) is stable, per DECISIONS #20.

## 22. Scheduling / Background Work

Asynchronous/recurring work includes AI generation, trend collection, metric synchronization, insight generation, and scheduled publication.

Do not implement long-running work as a blocking browser request. Initial deployment-supported scheduled/server execution is acceptable, while job state remains in the database. A dedicated queue/worker system may be introduced later behind the job abstraction.

## 23. Database Migration Strategy

All schema changes must be migrations.

**RLS is never a separate, later migration.** Each domain migration creates
its tables, indexes, RLS enablement, grants, and policies together, in the
same migration. A table must never exist — even transiently within a
single deployment — without RLS enabled and its policies defined. A
migration that adds a table without also enabling and defining RLS for it
is non-conforming and must be rejected in review, regardless of whether a
"final RLS migration" is planned to follow.

Example sequence (each step is self-contained and RLS-complete for the
tables it introduces):

```text
001_foundation.sql        (profiles, workspaces, workspace_members, audit_logs — tables + indexes + RLS + grants + policies)
002_brand.sql              (brands, brand_identity, brand_voice, audience_profiles, content_pillars — + RLS)
003_content.sql            (content_briefs, content, content_versions, content_variants, assets, content_assets, content_approvals — + RLS)
004_distribution.sql       (social_accounts, publications — + RLS)
005_analytics.sql          (publication_metric_snapshots, content_performance_scores — + RLS)
006_intelligence.sql       (signal_sources, signals, topics, signal_topics, opportunities — + RLS)
007_ai.sql                 (ai_jobs, ai_usage, prompt_versions — + RLS)
008_optimization.sql       (insights, insight_evidence, recommendations — + RLS)
009_automation.sql         (automations, automation_runs — + RLS)
010_notifications.sql      (notifications — + RLS)
```

`audit_logs` moves into `001_foundation.sql` (MVP-0) so every subsequent
domain is auditable from its first write. There is no migration in this
sequence whose purpose is "add RLS" — RLS is a property every table is
born with, not a property added afterward.

Destructive migrations require explicit approval.

## 24. Testing Strategy

Unit: scoring, state transitions, transformations, normalization.

Integration: application services, Supabase queries, provider adapters.

Database: foreign keys, constraints, RLS, tenant isolation. **Every exposed workspace-scoped table must have an RLS test verifying (a) an authenticated member of the owning workspace can perform the operations their role permits, and (b) an authenticated user who is not a member of that workspace is denied access entirely.** This is required before a phase touching that table is considered done (§31), not optional hardening.

E2E: sign in, workspace, brand, brief, AI generation, approval, scheduling, provider publication/simulation, metrics, insight.

## 25. Observability

Record application errors, AI job failures, provider errors, publication failures, metric sync failures, and automation failures. Use correlation identifiers where practical.

## 26. Environment Strategy

Separate development and production. At minimum:

```text
Local Development
Supabase Development
Netlify Preview

Production
Supabase Production
Netlify Production
```

Secrets live in environment configuration, not Git.

## 27. Deployment Strategy

```text
feature branch
    ↓
pull request
    ↓
tests
    ↓
preview deployment
    ↓
review
    ↓
main
    ↓
production
```

Database migrations are reviewed as code and coordinated with application deployment.

## 28. Performance Principles

Prioritize server-side fetching where appropriate, pagination, indexed workspace queries, avoiding N+1 queries, asynchronous AI work, asynchronous metric ingestion, and optimized asset delivery.

## 29. Reliability Principles

Every external API integration must assume timeouts, rate limits, expired tokens, outages, malformed responses, and partial failures. Failures should be observable and retryable where safe. Publishing should use idempotency/provider identifiers where supported.

## 30. Architecture Guardrails

Engineering agents must read canonical docs before changes; must not silently redesign architecture; must not bypass RLS; must not create a table without RLS enabled and policies defined in the same migration; must not store secrets in source control or in ordinary application columns (social/third-party credentials live in Supabase Vault, referenced by ID only); must not overwrite immutable creative history; must not hard-delete `content_versions`, `content_variants`, or `publications`; must not destroy historical analytics, approval, AI execution, or automation history; must not introduce destructive migrations without approval; must not allow a publication to reach `scheduled`/`publishing`/`published` without a matching approved `content_approvals` record; must not introduce an unrestricted polymorphic reference; and must stop when requirements conflict.

## 31. Definition of Done for a Phase

1. Implementation exists.
2. Migration exists where relevant.
3. Tests exist.
4. Type checking passes.
5. Security/RLS behavior is verified, including a passing RLS test for every exposed workspace-scoped table added or touched in the phase (allowed member access, denied non-member access).
6. Documentation reflects implementation.
7. Git working tree is understandable.
8. No unresolved architectural conflict remains.
9. The phase can be reviewed independently.
