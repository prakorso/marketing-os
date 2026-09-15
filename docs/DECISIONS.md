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
