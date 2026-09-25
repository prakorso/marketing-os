# MARQOS — Roadmap

**Version:** 1.2
**Status:** DRAFT — pending Owner approval (Track 0)
**Date:** 2026-09-25

This is the operational canonical roadmap of MARQOS — Marketing Operating
System. Roadmap governance (hierarchy, completion-first rule, release gate
classes, terminology) is locked by Decision #46. The product and domain
model lives in the PRD; architecture lives in the Engineering Blueprint.
Where this document summarizes a Decision, the Decision governs.

## 1. Hierarchy

```text
Product            MARQOS — Marketing Operating System
  → Domains        what the product is made of
  → Capability Versions   unit of scope and closure (locked DoD)
  → Execution Tracks      order in which capability versions are closed
  → Work Packages         engineering milestones (e.g. MVP-5.36, H0–H6)
  → Release/Rollout Gates how a capability is proven / rolled out safely
```

- **Domains.** Foundation, Content, Distribution, Analytics and
  Intelligence (formerly phases MVP-0..MVP-4; their order is historical),
  plus Ideation, Creative, Connected Assets, Integrations, Optimization /
  Learning, Marq (horizontal) and Performance Marketing (future).
- **Capability Version.** A named version (e.g. "Instagram Publishing
  V1") with a locked Definition of Done (DoD) and a release gate class.
  "100%" means 100% of that version's locked DoD — not that the
  capability can never have a V2.
- **Execution Tracks 0–8.** The only execution order (§3). Where an older
  MVP-phase sentence implies a different order, this roadmap governs
  (#46).
- **Work Packages.** Identifiers such as MVP-5.34, MVP-5.35, MVP-5.36 and
  H0–H6. They are not roadmap levels.
- **Release/Rollout Gates.** Gate classes I/II/III (§2) and
  provider-specific rollout stages such as Decision #44 Phases 0–4.
- **Terminology.** "Level N" is retired for future roadmap execution; no
  "Level 7" exists. Level 4/5/6 in Decisions #43–#45 remain valid
  historical Instagram rollout terminology.

## 2. Completion-First Governance and Release Gates

One major capability version is completed to 100% of its locked DoD
before execution moves to the next. Parallel work is allowed only if it
has no unsafe dependency and does not leave the active capability
unfinished (for example documentation or isolated technical-debt fixes).

Lifecycle: DEFINE → IMPLEMENT → VERIFY → STAGING → PILOT → HARDEN →
PRODUCTION/LIVE PROOF (where required) → FORMAL CLOSURE → NEXT.

Closed milestones are not reopened without a concrete regression, a
changed requirement, or an explicit Owner decision.

| Gate class | Applies to | Required before closure |
|---|---|---|
| I | No external side effect | Local verification, automated tests, staging verification, closure record |
| II | External read integration (ingestion, metrics) | Class I + real-provider staging proof; pilot where user-facing |
| III | External irreversible action (publish, spend, remote delete) | Class II + controlled pilot, dedicated production environment, production deployment, live proof, observation period, formal closure record |

Each capability version declares its class in its DoD; the Owner may
raise it.

## 3. Execution Tracks

### You Are Here

- **Track 0 — Canon Alignment: IN PROGRESS** (this document is part of it).
- Track 1 — Instagram V1 Closure: NOT STARTED. Its already completed
  foundation is the historical work in §4. MVP-5.36 Level-6 Runtime
  Hardening H0–H6 is formally closed and is not reopened. #44 Phase 2
  (hardened controlled dry run) is proven.
- Tracks 2–8: NOT STARTED.

### Track 0 — Canon Alignment

- **Purpose:** adopt the vNext canonical documentation (PRD, Blueprint,
  Database Architecture, ERD, this roadmap) and Decisions #46–#52.
- **Entry:** the Owner approves the vNext change plan.
- **Scope:** documentation only.
- **Non-goals:** any code, schema, environment or provider change.
- **Exit/closure:**
  - documentation consistency verified;
  - checks pass;
  - Owner reviews the final diff and explicitly approves v1.2;
  - documents marked Approved;
  - merged to main.
- **Dependencies:** none.
- **Proof:** Class I (documentation).

### Track 1 — Instagram V1 Closure

- **Purpose:** close Instagram Publishing V1 (Decision #47).
- **Entry:** Track 0 closed.
- **Scope:** summary of the #47 DoD (Decision #47 governs):
  - UI-driven Instagram OAuth with exactly the required publishing and
    insights scopes, signed OAuth state, professional-account
    validation, no manual token/id entry in the product;
  - approved variant → create publication; schedule/reschedule/cancel;
  - unattended hardened runtime; visible status; safe operator
    reconciliation of ambiguous outcomes;
  - separately authorized #44 Phase 3 real scheduled publish proof;
  - invalid/expired credential detection + reconnect flow;
  - dedicated MARQOS production environment (not the shared staging
    Supabase project);
  - minimal metrics ingestion (published publication → metrics sync →
    `publication_metric_snapshots`);
  - one controlled production publication through the product path,
    with a metrics snapshot, then a clean 72-hour observation period;
  - formal closure record.
- **Non-goals:**
  - other providers;
  - Instagram carousel/Reel (V2);
  - Organic Analytics V1;
  - automated token refresh;
  - #44 Phase 4 rollout. The V1 production proof does NOT authorize
    Phase 4.
- **Exit/closure:** every #47 item satisfied and the closure record
  written.
- **Dependencies:** MVP-5.36 (closed); production environment
  provisioning (separately authorized).
- **Proof:** Class III (production/live proof required).

### Track 2 — Trend Signal V1

- **Purpose:** translate external signals into brand-specific marketing
  opportunities (Decision #48).
- **Entry:** Track 1 closed.
- **Scope:**
  - initial sources with platform-managed credentials;
  - ingestion jobs; normalization;
  - detection/clustering; brand relevance (brand voice, audiences,
    content pillars); AI interpretation;
  - opportunity creation and operator review;
  - opportunity scoring defined in the V1 contract before use.
- **Non-goals:**
  - Content Ideas (Track 3);
  - a full Integration Hub (a minimal Integrations slice only if a
    source requires per-workspace credentials, #51);
  - Marq surfaces; paid data.
- **Exit/closure:** the locked V1 DoD.
- **Dependencies:** #48; job infrastructure choice (the automation
  tables are designed but not migrated).
- **Proof:** Class II (real-source staging proof; pilot on a real brand).

### Track 3 — Content Ideation & Approval V1

- **Purpose:** Opportunity → Content Ideas → operator approve/edit/reject
  → Brief (Decision #49).
- **Entry:** Track 2 closed.
- **Scope:**
  - Content Idea entity and lifecycle;
  - AI idea proposal; review UI; idea → brief conversion;
  - AI provider credentials live in the target environments.
- **Non-goals:** format-specific creative plans (Track 4).
- **Exit/closure:** the locked V1 DoD.
- **Dependencies:** #49.
- **Proof:** Class II (external AI provider; no irreversible action).

### Track 4 — Creative OS V1

- **Purpose:** structured creative planning per format (Decision #49).
- **Entry:** Track 3 closed.
- **Scope:** single image, carousel slides and video storyboard
  structures; AI assistance where already supported.
- **Non-goals:**
  - autonomous/advanced video generation;
  - publishing of formats a provider does not yet support (Instagram
    carousel/Reel stays Instagram V2).
- **Exit/closure:** the locked V1 DoD.
- **Dependencies:** #49.
- **Proof:** Class I or II, as declared in its DoD.

### Track 5 — Social Expansion

- **Purpose:** additional providers through the provider capability
  model (Decision #50).
- **Entry:** Track 4 closed.
- **Scope:**
  - the provider capability contract;
  - generalization of shared publication infrastructure where safe (the
    publication checkpoint and runtime are Instagram-keyed today);
  - then Facebook, Threads, TikTok and YouTube, each as its own
    capability version. Instagram V2 may be scheduled here.
- **Non-goals:** paid media.
- **Exit/closure:** each provider version closes separately.
- **Dependencies:** #50; Connected Assets per provider.
- **Proof:** Class III for any provider that publishes.

### Track 6 — Organic Analytics V1

- **Purpose:** multi-provider organic analytics beyond the Instagram V1
  minimal metrics slice.
- **Entry:** at least the first Track 5 provider closed, or an
  Owner-defined subset.
- **Scope:**
  - scheduled multi-provider metrics ingestion;
  - the derived performance score decision (#31 open);
  - comparison views.
- **Non-goals:** insights and recommendations (Track 7).
- **Exit/closure:** the locked V1 DoD.
- **Dependencies:** provider metrics capabilities.
- **Proof:** Class II.

### Track 7 — Learning Loop V1

- **Purpose:** Metrics → Insight → Evidence → Recommendation → Next
  Action.
- **Entry:** Track 6 closed.
- **Scope:**
  - the designed optimization entities (not migrated today);
  - rule-based analysis first (#22);
  - recommendation → content idea / brief.
- **Non-goals:** autonomous actions.
- **Exit/closure:** the locked V1 DoD.
- **Dependencies:** Track 6 data.
- **Proof:** Class I or II.

### Track 8 — Performance Marketing

- **Purpose:** paid media (e.g. Meta Ads, Google Ads, TikTok Ads).
- **Entry:** Tracks 1–7 at their required closure state.
- **Scope:**
  - a separate paid-media domain (Database Architecture §23);
  - ad-platform credentials through Integrations (#51).
- **Non-goals:** anything before Tracks 1–7 close.
- **Exit/closure:** per-channel capability versions.
- **Dependencies:** #51.
- **Proof:** Class III (spend).

## 4. Historical Mapping

| Historical item | Meaning now |
|---|---|
| MVP-0 … MVP-4 | Delivered domain foundations; names kept as domain labels |
| MVP-5.34 (Instagram OAuth), MVP-5.35 (Level 4/5 publishing), MVP-5.36 (Level-6 runtime, H0–H6 CLOSED) | Work packages that are completed parts of the Track 1 capability |
| Level 4 / 5 / 6 (#43–#45) | Historical Instagram rollout terminology; unchanged |
| #44 Phase 2 | PROVEN (#45 verification record) |
| #44 Phase 3 | A Track 1 closure requirement; execution separately authorized |
| #44 Phase 4 | Bounded/wider rollout; separately authorized; NOT authorized by the Instagram V1 production proof |

## 5. Cross-Cutting Capabilities

- **Marq (#52).**
  - Design is canonical now.
  - The first product surface is built after the Trend Signal and Content
    Ideation foundations; contextual entry points are added as the
    corresponding surfaces exist.
  - Never bypasses approval or publishing safety.
- **Connected Assets (#50).**
  - Instagram slice in Track 1 (UI OAuth entry, scopes, signed state,
    reconnect);
  - generalized per provider in Track 5.
- **Integrations / API Credentials (#51).**
  - Minimal slice with Track 2 only if a source requires per-workspace
    credentials;
  - full Integrations Settings before Track 8 and before Marq BYOK.
- **Human approval.**
  - An invariant across all tracks: the publication approval gate
    (existing) and the ideation approval gate (Track 3).
  - No roadmap item weakens either.
- **Multi-tenancy / security.**
  - Every new table is created with RLS, policies and tenant-isolation
    tests (Engineering Blueprint §23, §24, §31);
  - composite tenant FKs (Database Architecture §16);
  - secrets in Vault.
- **Observability / audit.**
  - External actions write audit records;
  - new jobs record runs and failures;
  - Class II/III versions require a closure record.
