# Marketing OS — Engineering Decisions

## Status

This document contains architectural decisions that must not be changed
without explicit approval.

---

## 1. Multi-Tenant Architecture

Marketing OS must support multiple workspaces.

Business data must be isolated by workspace.

---

## 2. Workspace Isolation

Supabase Row Level Security (RLS) is mandatory.

Frontend authorization is not considered sufficient security.

---

## 3. Database

Supabase PostgreSQL is the primary source of truth for application data.

---

## 4. Authentication

Supabase Auth is the authentication system.

---

## 5. Storage

Supabase Storage is used for media assets.

---

## 6. Content Architecture

Content, content versions, content variants, and publications
are separate entities.

---

## 7. Content Versioning

Historical content versions must not be overwritten.

Regeneration creates a new version.

---

## 8. Publication

A publication represents a distribution instance of a content variant
to a specific social platform/account.

---

## 9. Calendar

The content calendar is a projection of scheduled publications.

A dedicated calendar table is not required.

---

## 10. Analytics

Raw platform metrics must remain separate from derived
performance scores and insights.

Historical metric snapshots must be preserved.

---

## 11. Intelligence

The following concepts must remain separate:

Signal = observed information

Topic = grouped subject

Opportunity = strategic marketing opportunity

---

## 12. AI

AI providers must be abstracted from core business logic.

AI execution must be observable and auditable.

---

## 13. Social Platforms

Social platform integrations must use an adapter/provider architecture.

Do not create separate core content models for each social platform.

---

## 14. Historical Data

Deleting or archiving creative content must not destroy
historical publication, analytics, or audit records.

---

## 15. Secrets

API keys and secrets must never be committed to GitHub.

---

## 16. Migrations

Database schema changes must be version controlled through migrations.

---

## 17. Destructive Changes

No destructive database migration may be executed without
explicit approval.

---

## 18. Architecture Changes

Claude must not silently change the product architecture.

If implementation conflicts with documented architecture,
the conflict must be reported before proceeding.

---

## 19. MVP Principle

The first complete operating loop is:

Signal
→ Topic
→ Opportunity
→ Content Brief
→ Content
→ Content Version
→ Content Variant
→ Publication
→ Metrics
→ Insight
→ Recommendation

---

## 20. Current MVP Priority

The first production milestone prioritizes:

1. Foundation
2. Content
3. Distribution
4. Analytics
5. Intelligence

Performance marketing will be implemented after the core
content operating system is stable.

---

## 21. AI Implementation Scope (Content-First)

AI is approved as the next major platform capability, but the initial
implementation is scoped exclusively to closing the MVP-1 Content AI gap:
`generate_text()`, `generate_image()`, `content_versions.ai_job_id`, and
`assets.ai_job_id`.

This decision does not authorize Intelligence AI classification, Opportunity
Scoring, Optimization, Insights, or Recommendations. Each remains a
separate, independently-scoped decision.

---

## 22. AI Deferred Domains

AI Topic Classification is optional and not pursued as part of the current
AI implementation. Manual Signal → Topic association (`signal_topics`)
remains the complete MVP-4 implementation.

AI is not an architectural prerequisite for Insights or Recommendations. A
future Analysis mechanism may use AI, but AI does not by itself authorize or
gate Optimization work.

Analysis (Engineering Blueprint §20) starts as deterministic/rule-based.
This establishes only the intended starting architecture for future
Optimization work — no Analysis mechanism is implemented by this decision.

Opportunity scoring remains undefined. No scoring formula or mechanism is
approved by this or any other decision.

---

## 23. AI Provider and Credentials

OpenAI is the initial AI provider, accessed exclusively behind the AI
Provider Interface (Engineering Blueprint §10) so future providers can be
added without changing domain logic.

AI provider credentials use an environment-configured, server-side
platform-level key. Credentials must never reach the browser or be
committed to Git. Workspace-level or bring-your-own-key AI credentials are
not introduced by this decision.

---

## 24. AI Data Access

`ai_jobs`, `ai_usage`, and `prompt_versions` grant workspace members SELECT
only. All INSERT/UPDATE/DELETE on these tables is performed by
`service_role`. No `authenticated` write policy exists for AI execution
bookkeeping.

---

## 25. AI Job Reference Semantics

`ai_jobs.input_reference` and `ai_jobs.output_reference` use a hybrid
semantic model: typed domain/entity references plus workspace context, and
a frozen snapshot of the request actually sent to the provider and the
output actually used by the domain consumer. JSONB is not a replacement for
relational foreign keys — entity references remain typed FKs where they
exist.

---

## 26. Prompt Version Lifecycle

Prompt versions are immutable. A new prompt version creates a new row.
Versioning uses a monotonically increasing integer per
`(workspace_id, purpose)`.

Canonical active-version behavior is unchanged: `is_active`, a partial
unique constraint on `(workspace_id, purpose)`, and workspace-specific
active prompts taking precedence over global active prompts (Engineering
Blueprint §12).

---

## 27. AI Execution Model

AI execution supports two modes: a synchronous fast-path for short,
single-operation calls (an `ai_jobs` row is still created; `queued →
running → completed/failed` may complete within one request), and an
asynchronous long-running path for image generation, multi-step generation,
and batch operations, where job state persists independently of the
triggering request. No numeric timeout threshold is fixed by this decision.

---

## 28. AI Traceability Scope

The initial AI traceability guarantee is limited to the canonical Content
requirements: `content_versions.ai_job_id` and `assets.ai_job_id`.
Traceability columns are not added to `content_variants`, `signal_topics`,
or other AI-touchable tables unless separately approved.

---

## 29. Analytics Metric Vocabulary and Cross-Provider Semantics

Marqos defines a canonical normalized metric vocabulary for
`publication_metric_snapshots`: impressions, reach, views, likes, comments,
shares, saves, clicks. These are standard Marqos storage/interface
concepts, not a claim of universal cross-provider measurement equivalence —
the same normalized field populated by two different providers does not
guarantee identical underlying measurement methodology (Engineering
Blueprint §18; Database Architecture §9).

Provider-specific measurement semantics are described, not invented, per
metric:

- Impressions: the total number of times the content was reported as
  displayed/impressed by the provider.
- Reach: the number of unique users/accounts the provider reports as
  reached by the content.
- Views: the provider's own definition of a view; Marqos does not impose a
  universal view definition.
- Likes: provider-reported likes/reactions, per the provider's own
  measurement semantics.
- Comments: provider-reported comments, per provider semantics.
- Shares: provider-reported shares/reposts, per provider semantics.
- Saves: provider-reported save/bookmark activity, when supported by the
  provider.
- Clicks: provider-reported clicks, per provider semantics.

Raw provider metrics remain preserved separately (`provider_metrics`
JSONB) regardless of how they normalize. This decision does not establish
cross-provider comparability, does not define a concrete per-provider
mapping contract (remains open — see Decision #32), and does not add any
structure beyond the vocabulary and semantic guidance stated above.

---

## 30. Analytics Engagement Rate

Marqos does not currently define a universal engagement-rate formula.
`engagement_rate` on `publication_metric_snapshots` represents a
provider-reported metric when the provider supplies one — Marqos does not
compute, infer, or fabricate `engagement_rate` from other metrics (likes,
comments, shares, reach, impressions, or any combination) unless a future
decision explicitly defines such a formula.

A deterministic mock/fixture value used for development or testing must be
identified as fixture/provider-simulated data, never presented as an
actual provider-reported measurement.

This decision does not define a future Marqos-calculated engagement rate
formula (remains open) and does not change the
`publication_metric_snapshots.engagement_rate` column.

---

## 31. Analytics Performance Score — Provisional Passthrough

The MVP-3 `content_performance_scores` implementation
(`calculatePublicationPerformanceScore`,
`src/server/services/analytics.ts`) writes `score_type = "engagement_rate"`
with `score` equal to the publication's most recent
`publication_metric_snapshots.engagement_rate`, unchanged. This is a
provisional passthrough, not a genuinely derived Marqos performance
calculation: no aggregation, weighting, or transformation is applied.

This decision clarifies, and does not contradict, Decision #10 ("raw
platform metrics must remain separate from derived performance scores and
insights") and Engineering Blueprint §18's target architecture (`Provider
Response → Normalization → Metric Snapshot → Derived Score → Insight`):
the target architecture's "Derived Score" stage remains the intended
future state. The current MVP-3 passthrough occupies that stage
provisionally, pending a genuinely derived Marqos performance score
formula, and must not be treated as fulfilling it.

Downstream consumers (future Analysis, Insight, or Recommendation
mechanisms) must not treat the current passthrough score as a universal
Marqos-derived performance measurement. This decision does not introduce a
new scoring formula, does not rename `content_performance_scores` or any
of its columns, and does not change existing schema or application code.
The final derivation formula remains an explicit open decision.

---

## 32. Analytics Normalization Boundary

Analytics normalization is a distinct conceptual stage between the
provider adapter and metric persistence: Provider → Provider Adapter → Raw
Provider Response → Analytics Normalizer → Normalized Metrics → Metric
Snapshot. The Analytics Normalizer is the canonical boundary where a
provider-specific raw response is translated into the normalized metric
vocabulary (Decision #29).

This decision establishes the conceptual stage only. It does not define
the raw-provider-response type/interface, does not specify where the
normalizer function lives in the codebase, and does not implement the
normalizer. These remain open implementation-contract decisions.

---

## 33. Analytics Metric Value State Semantics

The Analytics data model must be able to distinguish five conditions
without overloading a single representation:

1. a reported value, including a legitimate numeric zero;
2. unavailable — the provider capability is not classified as unsupported,
   but a value could not be obtained;
3. unsupported — the provider does not offer this metric capability at
   all;
4. not collected — no collection attempt was made for this
   publication/event; this state is represented by the absence of a
   metric snapshot, not by a snapshot containing placeholder values;
5. provider/collection failure — a collection-level condition, not a
   metric-value state; a failed collection attempt does not create a
   metric snapshot.

A reported numeric zero (likes = 0, comments = 0, shares = 0, etc.) is
legitimate observed data. Zero must never be represented as, and must
never be confused with, unavailable, unsupported, or not-collected, and
none of those three states may be represented as a numeric zero.

The overall semantic model is hybrid: a collection-level status (handling
provider/collection failure) and a per-metric state (handling
reported/unsupported/unavailable, with zero as a value under "reported")
are conceptually distinct layers.

This decision establishes the semantic distinctions only. It does not
select an enum, column, JSON structure, additional table, or any other
persistence representation — the exact structural representation for
per-metric state and collection-level status remains an explicit open
decision, not resolved by this document.

---

## 34. Analytics Observation Timestamp

`publication_metric_snapshots.captured_at` represents the time associated
with the metric observation itself, distinct from `created_at` (the time
the row was persisted) and from `publications.published_at`/`scheduled_at`
(publication lifecycle timing). The preferred source for `captured_at` is
the provider's own reported observation timestamp, when the provider
exposes one.

The fallback behavior when a provider does not expose an observation
timestamp is explicitly OPEN and is not decided by this document — it must
not be silently assumed to be Marqos's sync/request execution time. This
remains a required follow-on decision before real provider integration.

---

## 35. Analytics Freshness Semantics

Freshness is account-level. `social_accounts.last_synced_at` means: the
most recent time Marqos successfully obtained a metric observation from at
least one publication under that social account. It does not mean every
publication under that account is currently fresh — a workspace-facing
presentation of this field must not imply per-publication freshness.

A failed collection attempt must not advance `last_synced_at`. A
successful observation may advance it, and only to a later timestamp than
its current value.

No canonical stale/fresh threshold exists. This decision does not
introduce one, and none is implied by the existence of this field.

The exact point in the service layer where `last_synced_at` is written,
and whether it is updated per-publication-sync or as a separate
aggregation step, is not decided by this document and remains an
implementation decision.

---

## 36. Analytics Fixture Parity

Representative Analytics fixtures, when built, must exercise the same
conceptual path as production: Mock Provider → Provider Adapter →
Analytics Normalizer → Analytics Service → Metric Snapshot → Analytics UI.
Fixtures must be deterministic, production-shaped, and explicitly
identified as fixture/simulated provider data — never presented as real
provider-reported measurements (Decision #30).

Fixture scenarios (for example: stable, growth, decline, zero activity,
unsupported metric, unavailable metric, provider failure) are fixture
coverage concepts, not business rules or canonical facts about any real
provider's behavior.

Fixtures must not bypass the Analytics Normalizer (Decision #32) once it
exists, and must not insert directly into `publication_metric_snapshots`
when exercising the production flow. Implementation of both the
normalizer and any fixture scenarios is deferred until the normalization
contract (Decision #32's open items) is resolved.

---

## 37. Analytics Metric State Representation (Architecture)

Owner-approved (MVP-5.10D), superseding the open A/B/C question left by
Decision #33: per-metric state is represented as an additive JSONB
structure alongside the existing normalized metric columns on
`publication_metric_snapshots`, not as a new relational child table.

The existing normalized numeric columns (impressions, reach, views,
likes, comments, shares, saves, clicks) remain the storage for reported
numeric values, including legitimate zero. The additive JSONB structure
exists solely to record, per metric, whether it is reported, unsupported,
or unavailable (Decision #33) — a "reported" state always carries a
numeric value (zero is valid); "unsupported" and "unavailable" carry no
numeric value. Provider/collection failure remains a collection-level
condition (Decision #33) and is never represented as a metric state; "not
collected" continues to mean no snapshot row exists at all.

This decision settles the architectural direction only. It does not
define the column name, the JSON key structure, enum value names, or any
SQL constraint — these remain implementation details to be finalized in
the implementation milestone that actually migrates the schema. No
migration is authorized by this decision.

---

## 38. Analytics Observation Timestamp Fallback and Provenance

Owner-approved (MVP-5.10D), resolving the fallback left open by Decision
#34: `publication_metric_snapshots.captured_at` uses the provider's
reported observation time when available; when the provider does not
expose one, Marqos's metric-collection/sync time is used as the fallback
observation timestamp. A valid metric snapshot must never be rejected
merely because the provider did not expose an observation time.

The system must preserve explicit provenance indicating whether a given
`captured_at` value came from the provider's own reported time or from
the Marqos fallback — the two must never be silently treated as
equivalent, and no consumer of `captured_at` may assume it is always
provider-verified.

This decision settles the semantic (best-available timestamp, with
knowable provenance) only. The physical representation of that
provenance (a new column, a JSON marker, or another mechanism) is an
implementation-contract detail deferred to the implementation milestone.
No schema change is authorized by this decision.

---

## 39. Analytics Raw Provider Response Contract

Owner-approved (MVP-5.10D): the boundary between a provider adapter and
the Analytics Normalizer (Decision #32) is a generic raw-response
envelope carrying a provider identity discriminant, an optional
provider-reported observation timestamp, and the provider's untouched,
provider-native payload. The payload remains provider-specific and
unnormalized until the normalizer processes it. Publication/account
identity used to make the provider call (execution context) is not part
of the raw response itself, since it is caller-supplied context, not data
the provider returned. Provider errors continue to be represented as a
thrown `ProviderError`, unchanged.

Concrete per-provider API response TypeScript shapes are not defined by
this decision and must not be invented before a real provider is actually
integrated and its API semantics verified — the envelope's payload
remains an unshaped, provider-native structure until then. Raw fidelity
(the payload must reach normalization and storage untouched) is
mandatory.

---

## 40. Analytics Freshness Write Point

Owner-approved (MVP-5.10D), resolving the write-point question left open
by Decision #35: `social_accounts.last_synced_at` is updated inside the
successful path of `recordPublicationMetricSnapshot`, after a metric
snapshot has been successfully persisted — never inside
`syncWorkspacePublicationMetrics` alone, since a publication synced via a
direct call (not through the batch orchestrator) must still correctly
advance freshness. Both the direct-call path and the batch-sync path
converge through this one function, so both are covered by a single write
point.

The update is monotonic: `last_synced_at` becomes the greater of its
existing value and the newly successful observation's timestamp, never an
unconditional overwrite. A failed collection attempt must never advance
`last_synced_at`.

This decision requires no schema change — `social_accounts.last_synced_at`
already exists (Decision #35) — only a service-layer write, which is an
implementation task for a future milestone, not performed here.

---

## 41. Analytics Provider Normalization Boundary (Adapter / Normalizer Split)

Owner-approved (MVP-5.10D), refining Decision #32: provider metric
mapping belongs in dedicated, provider-specific normalizer modules behind
a shared normalization interface, dispatched by provider identity
(Decision #39's raw-response discriminant) — not inside the provider
adapter.

Provider adapters are responsible only for communicating with the
provider and returning its raw response (Decision #39); they never
normalize. Normalizers translate a provider's raw metrics into the
Marqos normalized vocabulary (Decision #29), determine each metric's
state (Decision #33), and resolve provider-specific mappings; normalizers
perform no network I/O and persist no data — persistence remains the
Analytics service's responsibility, unchanged.

Concrete per-provider metric mappings are not defined by this decision and
must not be created until a provider is actually integrated and its API
semantics verified (consistent with Decision #39).

---

## 42. Analytics Provider Capability Declaration

Owner-approved (MVP-5.10D): provider capability (which normalized metrics
a given provider is known to support at all) is a static, code-level
declaration, consulted by the normalizer (Decision #41) to distinguish
"unsupported" from "unavailable" (Decision #33). No provider capability
database table or other persisted structure is required or introduced by
this decision — no evidence exists that capability varies by account
rather than by provider/platform.

A real provider's capability list may only be populated once that
provider is actually integrated and its supported metrics are verified;
it must never be populated from assumptions about a provider's API that
has not been integrated.

---

## 43. Instagram Publishing Foundation (MVP-5.35B)

Owner-approved (Panji, MVP-5.35A decisions Q1–Q6), recorded with the
MVP-5.35B schema foundation:

- **Variant-level media selection (Q1).** The publication target is a
  content variant, so the exact ordered media it publishes is bound at
  variant level by `marqos_content_variant_assets`. Content-level assets
  (`marqos_content_assets`) remain the library and are never implicitly
  published; no existing content-level binding is migrated.
- **JPEG-only first slice (Q2).** Instagram publishing initially supports
  eligible JPEG images only. PNG/WebP conversion and any media
  transformation/derivative handling are deferred.
- **Format values (Q3).** Canonical publishing formats are `image`,
  `carousel`, `reel`. `content_variants.format` remains free text (existing
  data and UI treat it as free text); the canonical values are validated at
  the publishing boundary, not by a schema constraint.
- **Image-first execution (Q4).** The first real publishing vertical slice
  is IMAGE only. Carousel and Reel publishing and background video polling
  are deferred.
- **`published_at` (Q5).** Remains the MARQOS time of the published
  transition; a provider timestamp may later be stored as provenance.
- **Instagram user target (Q6) and identity model (Model B).** Decided
  (Panji, MVP-5.35B.1–B.3): Instagram publishing does NOT use `me`; it
  targets the exact professional account ID `<IG_ID>` in
  `/<IG_ID>/media` and `/<IG_ID>/media_publish`. Meta documents `<IG_ID>` as
  `GET /me?fields=user_id` ("the Instagram professional account ID"),
  distinct from the token exchange's "Instagram-scoped user ID" and the
  `/me` app-scoped `id`. `social_accounts.external_account_id` therefore
  means the provider-native id of the account MARQOS acts on — for
  Instagram, `<IG_ID>` — and is the natural key; the token-scoped id is kept
  losslessly as provenance (`metadata.instagramScopedUserId`). The profile
  lookup is part of connection establishment and fails closed. Provider ids
  are opaque strings preserved losslessly (Database Architecture §8). Legacy
  rows keyed by the old rounded token id are reconciled in place on
  reconnect (compatibility-only; fails closed on ambiguity/collision).
- **MARQOS-owned idempotency.** Instagram documents no idempotency key and
  no behavior for repeated `media_publish`. MARQOS prevents duplicates via:
  lifecycle triggers + scheduler claim (single-flight), the scheduling
  guard (never reschedule `published`/`publishing`/`cancelled`, nor an
  unknown outcome, nor while an attempt is open), and `publication_attempts`
  as the provider checkpoint (container ids recorded before publish, remote
  media id right after).
- **Provider checkpoint vs MARQOS lifecycle.** Provider container states
  (`IN_PROGRESS`, `FINISHED`, `PUBLISHED`, …) live in
  `publication_attempts.stage`/`container_ids`, never in
  `publications.status`.
- **Unknown outcome (refined, MVP-5.35C-A/B, Panji D1/D2/D4).** Once the
  irreversible publish request has been invoked, only a success with a media
  id or an authoritative structured provider rejection is conclusive; every
  other result (timeout, any transport error, 5xx, malformed response,
  process interruption) is `outcome_unknown`. The attempt records
  `outcome_unknown` and the publication STAYS `publishing` until reconciled
  (so both resolutions remain possible under the existing lifecycle
  triggers). No automatic provider retry, rescheduling, or new attempt.
  Reconciliation reads the provider container status: ERROR/EXPIRED ⇒ known
  not published; FINISHED ⇒ not published, operator decision required;
  PUBLISHED ⇒ a post exists, and recent-media correlation by
  caption/timestamp is HEURISTIC evidence only — never auto-selected or
  auto-finalized. An operator may close an unresolved unknown as `failed`
  with `error_code = 'publish_outcome_unknown'`, which is not reschedulable.
  Staged publishing is disabled unless explicitly enabled server-side
  (`MARQOS_INSTAGRAM_STAGED_PUBLISHING=enabled`).
- **Execution budget and pre-irreversible deadline gate (MVP-5.35C-D).**
  Netlify's synchronous/streaming function limit is 60 s (documented, not
  configurable). Staged publishing plans at most 45 s (≥ 15 s headroom):
  provider requests ≤ 10 s each, container polling ≤ 15 s, and a protected
  reserve of 12 s for the publish request plus 5 s for final persistence.
  Pre-publish work may never consume those reserves. Immediately before
  `publish_requested` is written, the remaining budget must cover both
  reserves; otherwise the attempt fails KNOWN-NOT-PUBLISHED
  (`insufficient_publish_time_budget`, manually retryable) and the publish
  request is never made. Budget exhaustion after the publish request began is
  `outcome_unknown`.
- **Dry run (MVP-5.35C-D).** An internal, server-only dry-run entry point runs
  validation → container creation → polling → `container_ready` and stops.
  It is structurally unable to publish: it receives only the
  create/status capability (no publish method) and never writes
  `publish_requested`. The intentional stop is known-not-published, recorded
  as attempt `failed` + `error_code = 'dry_run_container_ready'` and the
  publication moved to `failed` with the same code (never `outcome_unknown`).
  The unpublished provider container expires on the provider side (24 h). The
  dry run is not exposed through any route, action, UI, scheduler, or feature
  gate.
- **Recovery after provider success, and operator-confirmed finalization
  (MVP-5.35C-I).** When `media_publish` authoritatively succeeded (2xx with a
  media id) but local persistence did not finish, the engine returns
  `pending_reconcile` carrying that exact media id (lossless string). This
  means provider success is known — not that anything was persisted, and
  never that `media_publish` may be called again (no automatic provider
  retry exists anywhere). Recovery is an explicit operator action:
  `finalizeWithConfirmedMediaId` applies an authoritative or
  operator-confirmed media id (non-empty ASCII digits) WITHOUT any provider
  call, only while the publication is `publishing` and only for its latest
  attempt at `publish_requested` or `outcome_unknown`. From
  `publish_requested` the attempt is written `published` +
  `external_media_id` first, then the publication. Terminal attempts
  (`published`, `failed`, `outcome_unknown`) are immutable history, so from
  `outcome_unknown` only the publication is marked `published`, with
  `provider_response.reconciliation = 'operator_confirmed'` and an
  evidence reference. Re-finalizing with the same id is a no-op; a
  different id is refused.
- **Level 5 operator guard (MVP-5.35C-I).** The first real publish runs from
  a one-off local operator CLI (never the scheduler, a route, or the global
  gate) under an operator-only provider-call guard that wraps `fetch` with
  a default-deny allowlist and per-rule ceilings counted at dispatch (Vault
  read ≤ 1, container create ≤ 1, media_publish ≤ 1, bounded status reads).
  `media_publish` additionally requires a captured container, an observed
  `FINISHED`, a matching `creation_id`, and arming — which happens only after
  the `publish_requested` checkpoint resolved. Evidence is append-only,
  fsync'd JSONL with safe fields only.

