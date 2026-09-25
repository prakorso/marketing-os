# MARQOS — Marketing Operating System — Product Requirements Document

**Version:** 1.2
**Status:** DRAFT — pending Owner approval (Track 0). Supersedes the unapproved v1.1 draft (2026-09-15) once approved.
**Date:** 2026-09-25

## 1. Product Definition

MARQOS — Marketing Operating System — is a multi-tenant marketing operations platform designed to let a small marketing function — ideally one strong marketer supported by AI and automation — operate the core marketing lifecycle from one system. ("MOS" / "Marketing OS" remains a descriptive category name used in historical documents; the canonical product name is MARQOS — Decision #46.)

MARQOS combines:
1. Marketing intelligence
2. Topic and trend discovery (Trend Signal)
3. Content ideation with human approval
4. Structured creative planning (Creative OS)
5. AI-assisted content creation
6. Asset management
7. Content approval
8. Connected Assets (social account connection) and Integrations
9. Social scheduling and publishing
10. Social analytics
11. Performance analysis
12. AI-generated insights and recommendations
13. Marq — a horizontal marketing intelligence copilot
14. Future paid/performance marketing operations

MARQOS is an operating system, not merely a dashboard. Its core value is the closed feedback loop:

**Signal → Topic → Opportunity → Content Idea → Brief → Content → Version → Variant → Publication → Metrics → Insight → Recommendation → Next Action / New Content**

(Content Idea was added to the loop by Decision #49; the closed-loop principle of Decision #19 is unchanged.)

## 2. Problem

Marketing work is commonly fragmented across social platforms, trend research, spreadsheets, design tools, copywriting tools, content calendars, scheduling tools, analytics dashboards, ad platforms, AI tools, and team communication.

This creates duplicated work, context switching, inconsistent brand execution, and weak feedback loops.

The marketer should not have to manually move the same information between many systems.

## 3. Product Vision

Create a single marketing operating layer where a marketer can:

> Discover what matters → decide what to say → create it → approve it → publish it → measure it → learn from it → improve the next content.

The long-term ambition is to reduce the need for large operational marketing teams without reducing strategic control.

AI should execute and accelerate work, while humans retain approval and strategic authority.

## 4. Target Users

### Primary
Marketing operator / marketing manager.

### Secondary
Founder / owner, marketing lead, content specialist, designer, performance marketer, reviewer / approver.

The architecture must support multiple users and roles, and multiple workspaces and brands, even if the initial product is primarily used by one person.

## 5. Product Principles

1. One operating loop: intelligence, creation, distribution, and measurement are connected.
2. AI as execution layer: AI assists and automates work but does not silently make strategic decisions.
3. Human approval: publishing and important irreversible actions require explicit approval unless an automation policy explicitly permits otherwise.
4. Traceability: generated content and insights must be traceable to their inputs.
5. Version preservation: creative history must not be overwritten.
6. Platform abstraction: Instagram, Facebook, Threads, TikTok, YouTube, and future platforms must not dictate the core content model.
7. Data integrity: raw data and derived intelligence remain separate.
8. Multi-tenant security: workspace isolation is mandatory.
9. Progressive complexity: MVP proves the core loop before paid media and advanced automation.
10. Maintainability: architecture and schema are documented and version controlled.
11. Completion-first delivery: capabilities are delivered as versions, each closed at 100% of its locked Definition of Done before the next major capability (Decision #46).
12. AI is advisory where human judgment or approval is required; this clarifies principle 2 and never weakens principle 3.

## 6. Core Operating Model

### Intelligence
MARQOS captures external and internal signals such as social discussions, videos, posts, recurring questions, engagement patterns, and trends. Signals are normalized and grouped into topics. Topics can produce strategic opportunities. The Trend Signal pipeline (Decision #48) is: multi-source signals → ingestion → normalization → detection/clustering → brand relevance → AI interpretation → Opportunity; opportunities are brand-specific, and a signal is never itself content.

### Ideation
An opportunity can produce one or more Content Ideas (Decision #49). AI may propose ideas; the operator approves, edits, or rejects them. Only an approved idea may progress from ideation to a brief.

### Planning
A brief defines objective, audience, angle, core message, format, platform intent, CTA, and constraints. Briefs may also be authored directly by an operator. The existing optional brief → opportunity link remains valid; the idea → brief linkage is defined by the Content Ideation V1 contract (Track 3).

### Creation
The marketer or AI creates content from a brief. Initial outputs include written posts, single-image posts, image-led posts, carousels, illustrations, captions, hooks, and CTAs. Video generation is an extension point, not an MVP requirement.

Structured creative planning (Creative OS, Decision #49) covers single images (headline/copy, visual direction, caption, CTA), carousels (slide structure, per-slide purpose/copy/direction, CTA), and video (storyboard, scenes, hook, visual direction, script/VO, on-screen text, CTA). A creative format does not imply that every provider can publish it.

### Review
Content moves through an approval lifecycle. The reviewer can approve, request changes, regenerate, create a new version, or schedule.

### Distribution
Approved content variants can be scheduled and published to connected social accounts. A single content concept can have different variants for different platforms. Social accounts are connected through provider OAuth (Connected Assets, Decision #50); normal users never handle provider tokens or IDs.

### Measurement
MARQOS stores historical publication metrics including impressions, reach, views, likes, comments, shares, saves, clicks, and engagement rate. Platform-specific metrics may be stored in provider-specific JSONB while normalized metrics remain available for cross-platform analysis.

### Optimization
MARQOS analyzes historical performance and creates insights, evidence, and recommendations. Recommendations can lead back into content ideas and creation.

### Marq (horizontal)
Marq is a marketing intelligence copilot across MARQOS (Decision #52): a dedicated conversational page plus contextual presence in Signals, Opportunities, Content, Analytics and Recommendations. It works only with authorized workspace/brand context and never bypasses approval or publishing safety. It is not a stage of the loop.

## 7. Core Modules

### Command Center
Current marketing state, priorities, content pipeline, upcoming publications, important insights, and AI recommendations.

### Intelligence
Signal ingestion, topic identification, opportunity scoring, and content idea suggestions.

### Ideation
Content Ideas per opportunity and their review (approve / edit / reject); conversion of approved ideas into briefs.

### Content Studio
Content creation, structured creative planning, AI copy, image generation, carousel structures, brand context, versions, and assets.

### Content Calendar
Scheduled/published content, filters, approvals, and rescheduling. The calendar is a projection of publications.

### Analytics
Publication performance, format comparisons, topic comparisons, patterns, and evidence-backed insights.

### Automation
Recurring intelligence collection, metric synchronization, AI analysis, and approved workflows.

### Settings — Connected Assets
OAuth-first connection of social accounts per workspace and brand (Decision #50).

### Settings — Integrations
AI providers, external services, API credentials and webhooks, with write-only secrets (Decision #51).

### Marq
Conversational copilot page and contextual assistance (Decision #52).

### Future Performance Marketing
Ad accounts, campaigns, ad sets, creatives, budgets, spend, conversions, ROAS, and optimization recommendations. Deferred from initial MVP; follows after the organic loop is stable.

## 8. User Stories

### Intelligence
- As a marketer, I can see relevant emerging topics.
- As a marketer, I can inspect the source behind a topic.
- As a marketer, I can turn an opportunity into a content brief.
- As a marketer, I can see brand-specific opportunities derived from signals.

### Ideation
- I can review AI-proposed content ideas for an opportunity.
- I can approve, edit, or reject a content idea.
- I can turn an approved content idea into a content brief.

### Content
- I can create content manually.
- I can ask AI to generate content from a brief.
- I can plan a single image, carousel, or video storyboard in a structured way.
- I can generate image assets.
- I can generate a carousel.
- I can regenerate without losing previous versions.
- I can approve or request changes.

### Distribution
- I can connect social accounts through the provider's own sign-in, without handling tokens or account IDs.
- I can reconnect an account whose credential has expired.
- I can schedule approved content.
- I can see upcoming publications in a calendar.
- I can see publication status.

### Analytics
- I can see publication performance.
- I can compare content performance.
- I can see evidence behind an insight.

### Optimization
- I can receive recommendations based on performance.
- I can turn a recommendation into a new content idea or brief.

### Settings and Marq
- I can add an integration credential that is never shown back to me after saving.
- I can ask Marq about my workspace and brands, within what I am authorized to see.

## 9. Product Domains and Roadmap

The MVP-0..MVP-4 phases below are kept as product-domain descriptions. Their original order is historical; execution order is the Track roadmap in `docs/ROADMAP.md` (Decision #46). The first production milestone was defined as proving **Signal → Topic → Opportunity → Brief → Content → Version → Variant → Publication → Metrics → Insight → Recommendation**; the loop is now the one in §1.

### MVP-0 — Foundation
Repository, application scaffold, authentication, workspace, roles, RLS (created together with every table from its first migration, never as a later pass), database migration system, storage foundation, deployment pipeline, and **audit logging** (`audit_logs`) — established at Foundation so every later domain is auditable from its first write. Automation infrastructure (`automations`, `automation_runs` schema) may also exist from Foundation, limited to system-defined internal jobs; it is infrastructure only, not a user-facing feature yet. (Current state: the automation tables are designed but not migrated — Database Architecture §12.)

### MVP-1 — Content Operating System
Brands, brand context, content briefs, content, versions, variants, assets, AI content generation, image generation, approval. Includes the explicit approval gate between `content_approvals` and publication readiness (see Engineering Blueprint §17), and AI-generation traceability (generated versions/assets link back to the AI job that produced them).

### MVP-2 — Distribution
Social account connections (credentials stored via Supabase Vault, never in application tables), publication records, scheduling, calendar, provider adapter architecture. Notifications (e.g. publication failure) may be introduced here as needed.

### MVP-3 — Analytics
Metric ingestion, historical snapshots, normalized metrics, performance scoring. Notifications may extend here (e.g. metric sync completion) as needed.

### MVP-4 — Intelligence
Sources, signals, topics, opportunities, insights, recommendations. The delivered MVP-4 uses manual Signal → Topic association (Decision #22); Trend Signal V1 adds AI classification, clustering, brand relevance and interpretation (Decision #48). Vector/embedding infrastructure is allowed where justified but not required. Insights and recommendations are designed but not migrated (Database Architecture §11).

Full user-configurable automation (marketer-authored workflows, and any policy permitting autonomous publishing under §11) is deferred until MVP-0 through MVP-4 are stable — it is a post-core-loop capability, not part of any individual MVP phase above.

Performance marketing follows after these stages are stable.

### Additional Domains
Ideation, Creative, Connected Assets, Integrations, Optimization / Learning, Marq (horizontal) and Performance Marketing (future).

### Execution Roadmap
Execution follows Tracks 0–8, defined in `docs/ROADMAP.md` (the operational canonical roadmap) under Decision #46: 0 Canon Alignment → 1 Instagram V1 Closure → 2 Trend Signal V1 → 3 Content Ideation & Approval V1 → 4 Creative OS V1 → 5 Social Expansion → 6 Organic Analytics V1 → 7 Learning Loop V1 → 8 Performance Marketing.

### Capability Versions and Definition of Done
Capabilities are delivered as versions (V1, V2, …), each with a locked Definition of Done and a release gate class (I, II, III — Decision #46). A version is 100% complete only when its locked scope is implemented, verified, proven at its gate class (including production/live proof where required) and formally closed. Later versions remain possible.

### Instagram Publishing V1
Instagram Publishing V1 is a Class III capability version whose Definition of Done is Decision #47: UI-driven OAuth, publication creation and scheduling from approved variants, unattended publishing by the hardened runtime, safe reconciliation, credential-expiry handling, a minimal metrics slice, a dedicated production environment, one controlled production publication and a 72-hour observation period. Its production proof does not authorize Decision #44 Phase 4 rollout. Carousel and Reel publishing are Instagram V2.

## 10. Non-Goals for Initial MVP

- Full CRM
- Sales pipeline
- Inventory management
- Finance/accounting
- Customer support
- Advanced video generation (structured video creative planning — storyboard, scenes, script/VO, on-screen text, CTA — is in scope under Creative OS, Decision #49)
- Autonomous unrestricted publishing
- Full advertising platform replacement
- Paid-media execution before Tracks 1–7 reach their required closure
- Replacing every marketing SaaS immediately

## 11. Approval and Safety Boundaries

Reversible AI actions such as generating copy, images, hooks, topics, and recommendations may run automatically.

Irreversible/external actions such as publishing, spending advertising budget, deleting historical data, and revoking social access require explicit approval or a separately configured automation policy.

These boundaries are extended, never weakened: AI-proposed content ideas require operator approval before they progress to briefs (Decision #49); Marq cannot bypass content approval or publishing safety and cannot publish autonomously without a future explicit automation contract (Decision #52); integration secrets are write-only from the user's perspective (Decision #51).

## 12. Success Metrics

Operational: time from idea to approved content, number of tools replaced, content production throughput, percentage of content produced without manual specialist intervention.

Content: engagement rate, saves, shares, reach, views, click-through rate.

Intelligence: opportunity-to-idea and idea-to-brief conversion, idea approval rate, opportunity-to-content conversion, recommendation adoption rate, percentage of insights backed by sufficient evidence.

System: job success rate, publication success rate, analytics sync success rate, AI generation latency, error rate.

## 13. Acceptance Criteria for Core Loop

1. Signals can exist.
2. Signals can be associated with topics.
3. Topics can produce opportunities.
4. Opportunities can produce content ideas; approved content ideas can produce briefs.
5. Briefs can produce content.
6. Content can have immutable versions.
7. Versions can produce platform variants.
8. Variants can become publications.
9. Publications can have historical metrics.
10. Metrics can produce performance calculations.
11. Performance can support evidence-backed insights.
12. Insights can create recommendations.
13. Recommendations can create/feed new content ideas, briefs or content.
14. Workspace isolation prevents cross-tenant access.
15. Historical records survive creative archiving.

## 14. Product Evolution

Future versions may add more intelligence providers, social platforms (Facebook, Threads, TikTok, YouTube — each as its own capability version, Decision #50), video workflows, campaigns/projects, advanced attribution, paid media, autonomous optimization, agentic workflows, predictive content scoring, and bring-your-own-key integrations (Decision #51).

These extensions must not compromise the core domain model.
