import type { PublicationStatus, SocialPlatform } from "@/types/database";

/**
 * The locked MVP-2.5 calendar status scope (approved product decision —
 * see src/server/services/publications.ts's module comment for the full
 * rationale). Defined here, in a plain neutral file with no "use client"/
 * "server-only" guard, rather than in publications.ts directly, because
 * client calendar components (CalendarFilters) need this exact list at
 * runtime to render filter options — importing a runtime value from
 * publications.ts (which has `import "server-only"`) would poison the
 * client bundle even for an unrelated named export. publications.ts
 * imports this same constant from here rather than redefining it, so
 * there is exactly one source of truth.
 */
export const CALENDAR_PUBLICATION_STATUSES = [
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
] as const;

export type CalendarPublicationStatus = (typeof CALENDAR_PUBLICATION_STATUSES)[number];

/**
 * Plain, serializable shape passed from the server (calendar/page.tsx) to
 * the client calendar components. Deliberately flat — no nested
 * Publication/SocialAccount/Content objects, no credential or provider
 * fields (provider_response, idempotency_key, etc. are never included).
 */
export type CalendarEvent = {
  publicationId: string;
  contentId: string;
  contentTitle: string;
  variantPlatform: string | null;
  variantCaption: string | null;
  accountPlatform: SocialPlatform | null;
  accountName: string | null;
  accountHandle: string | null;
  status: PublicationStatus;
  /** ISO instant — always non-null for a calendar event by construction (Database Architecture §18 range query). */
  scheduledAt: string;
  externalUrl: string | null;
};
