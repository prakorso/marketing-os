# Marketing Operating System (MOS) — Product Requirements Document

**Version:** 1.1
**Status:** Canonical specification — pending explicit approval
**Date:** 2026-09-15

## 1. Product Definition

Marketing Operating System (MOS) is a multi-tenant marketing operations platform designed to let a small marketing function — ideally one strong marketer supported by AI and automation — operate the core marketing lifecycle from one system.

MOS combines:
1. Marketing intelligence
2. Topic and trend discovery
3. Content ideation
4. AI-assisted content creation
5. Asset management
6. Content approval
7. Social scheduling and publishing
8. Social analytics
9. Performance analysis
10. AI-generated insights and recommendations
11. Future paid/performance marketing operations

MOS is an operating system, not merely a dashboard. Its core value is the closed feedback loop:

**Signal → Topic → Opportunity → Brief → Content → Publication → Metrics → Insight → Recommendation → New Content**

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

The architecture must support multiple users and roles even if the initial product is primarily used by one person.

## 5. Product Principles

1. One operating loop: intelligence, creation, distribution, and measurement are connected.
2. AI as execution layer: AI assists and automates work but does not silently make strategic decisions.
3. Human approval: publishing and important irreversible actions require explicit approval unless an automation policy explicitly permits otherwise.
4. Traceability: generated content and insights must be traceable to their inputs.
5. Version preservation: creative history must not be overwritten.
6. Platform abstraction: Instagram, TikTok, YouTube, Threads, and future platforms must not dictate the core content model.
7. Data integrity: raw data and derived intelligence remain separate.
8. Multi-tenant security: workspace isolation is mandatory.
9. Progressive complexity: MVP proves the core loop before paid media and advanced automation.
10. Maintainability: architecture and schema are documented and version controlled.

## 6. Core Operating Model

### Intelligence
MOS captures external and internal signals such as social discussions, videos, posts, recurring questions, engagement patterns, and trends. Signals are normalized and grouped into topics. Topics can produce strategic opportunities.

### Planning
An opportunity can become one or more content briefs defining objective, audience, angle, core message, format, platform intent, CTA, and constraints.

### Creation
The marketer or AI creates content from a brief. Initial outputs include written posts, single-image posts, image-led posts, carousels, illustrations, captions, hooks, and CTAs. Video generation is an extension point, not an MVP requirement.

### Review
Content moves through an approval lifecycle. The reviewer can approve, request changes, regenerate, create a new version, or schedule.

### Distribution
Approved content variants can be scheduled and published to connected social accounts. A single content concept can have different variants for different platforms.

### Measurement
MOS stores historical publication metrics including impressions, reach, views, likes, comments, shares, saves, clicks, and engagement rate. Platform-specific metrics may be stored in provider-specific JSONB while normalized metrics remain available for cross-platform analysis.

### Optimization
MOS analyzes historical performance and creates insights, evidence, and recommendations. Recommendations can lead back into content creation.

## 7. Core Modules

### Command Center
Current marketing state, priorities, content pipeline, upcoming publications, important insights, and AI recommendations.

### Intelligence
Signal ingestion, topic identification, opportunity scoring, and content suggestions.

### Content Studio
Content creation, AI copy, image generation, carousel structures, brand context, versions, and assets.

### Content Calendar
Scheduled/published content, filters, approvals, and rescheduling. The calendar is a projection of publications.

### Analytics
Publication performance, format comparisons, topic comparisons, patterns, and evidence-backed insights.

### Automation
Recurring intelligence collection, metric synchronization, AI analysis, and approved workflows.

### Future Performance Marketing
Ad accounts, campaigns, ad sets, creatives, budgets, spend, conversions, ROAS, and optimization recommendations. Deferred from initial MVP.

## 8. User Stories

### Intelligence
- As a marketer, I can see relevant emerging topics.
- As a marketer, I can inspect the source behind a topic.
- As a marketer, I can turn an opportunity into a content brief.

### Content
- I can create content manually.
- I can ask AI to generate content from a brief.
- I can generate image assets.
- I can generate a carousel.
- I can regenerate without losing previous versions.
- I can approve or request changes.

### Distribution
- I can connect social accounts.
- I can schedule approved content.
- I can see upcoming publications in a calendar.
- I can see publication status.

### Analytics
- I can see publication performance.
- I can compare content performance.
- I can see evidence behind an insight.

### Optimization
- I can receive recommendations based on performance.
- I can turn a recommendation into a new content brief.

## 9. MVP Definition

The first production milestone must prove:

**Signal → Topic → Opportunity → Brief → Content → Version → Variant → Publication → Metrics → Insight → Recommendation**

Implementation phases:

### MVP-0 — Foundation
Repository, application scaffold, authentication, workspace, roles, RLS (created together with every table from its first migration, never as a later pass), database migration system, storage foundation, deployment pipeline, and **audit logging** (`audit_logs`) — established at Foundation so every later domain is auditable from its first write. Automation infrastructure (`automations`, `automation_runs` schema) may also exist from Foundation, limited to system-defined internal jobs; it is infrastructure only, not a user-facing feature yet.

### MVP-1 — Content Operating System
Brands, brand context, content briefs, content, versions, variants, assets, AI content generation, image generation, approval. Includes the explicit approval gate between `content_approvals` and publication readiness (see Engineering Blueprint §17), and AI-generation traceability (generated versions/assets link back to the AI job that produced them).

### MVP-2 — Distribution
Social account connections (credentials stored via Supabase Vault, never in application tables), publication records, scheduling, calendar, provider adapter architecture. Notifications (e.g. publication failure) may be introduced here as needed.

### MVP-3 — Analytics
Metric ingestion, historical snapshots, normalized metrics, performance scoring. Notifications may extend here (e.g. metric sync completion) as needed.

### MVP-4 — Intelligence
Sources, signals, topics, opportunities, insights, recommendations. Topic grouping uses AI/provider classification plus relational grouping; no vector/embedding infrastructure is required for MVP.

Full user-configurable automation (marketer-authored workflows, and any policy permitting autonomous publishing under §11) is deferred until MVP-0 through MVP-4 are stable — it is a post-core-loop capability, not part of any individual MVP phase above.

Performance marketing follows after these stages are stable.

## 10. Non-Goals for Initial MVP

- Full CRM
- Sales pipeline
- Inventory management
- Finance/accounting
- Customer support
- Advanced video generation
- Autonomous unrestricted publishing
- Full advertising platform replacement
- Replacing every marketing SaaS immediately

## 11. Approval and Safety Boundaries

Reversible AI actions such as generating copy, images, hooks, topics, and recommendations may run automatically.

Irreversible/external actions such as publishing, spending advertising budget, deleting historical data, and revoking social access require explicit approval or a separately configured automation policy.

## 12. Success Metrics

Operational: time from idea to approved content, number of tools replaced, content production throughput, percentage of content produced without manual specialist intervention.

Content: engagement rate, saves, shares, reach, views, click-through rate.

Intelligence: opportunity-to-content conversion, recommendation adoption rate, percentage of insights backed by sufficient evidence.

System: job success rate, publication success rate, analytics sync success rate, AI generation latency, error rate.

## 13. Acceptance Criteria for Core Loop

1. Signals can exist.
2. Signals can be associated with topics.
3. Topics can produce opportunities.
4. Opportunities can produce briefs.
5. Briefs can produce content.
6. Content can have immutable versions.
7. Versions can produce platform variants.
8. Variants can become publications.
9. Publications can have historical metrics.
10. Metrics can produce performance calculations.
11. Performance can support evidence-backed insights.
12. Insights can create recommendations.
13. Recommendations can create/feed new briefs or content.
14. Workspace isolation prevents cross-tenant access.
15. Historical records survive creative archiving.

## 14. Product Evolution

Future versions may add more intelligence providers, social platforms, video workflows, campaigns/projects, advanced attribution, paid media, autonomous optimization, agentic workflows, and predictive content scoring.

These extensions must not compromise the core domain model.
