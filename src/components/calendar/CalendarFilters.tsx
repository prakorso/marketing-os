"use client";

import { CALENDAR_PUBLICATION_STATUSES, type CalendarPublicationStatus } from "@/components/calendar/types";
import type { SocialPlatform } from "@/types/database";

// The canonical, app-supported platform set (Engineering Blueprint §16) —
// not derived from which platforms happen to have events this month, so
// the filter list doesn't shift as data changes.
const PLATFORMS: SocialPlatform[] = ["instagram", "tiktok", "youtube", "threads"];

const STATUS_LABEL: Record<CalendarPublicationStatus, string> = {
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
};

const selectClass =
  "rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary";
const labelClass = "font-label text-label-sm font-semibold text-on-surface";

type CalendarFiltersProps = {
  /** Server-side filter (requires a new fetch on change) — undefined means "All". */
  statusFilter: CalendarPublicationStatus | undefined;
  onStatusChange: (status: CalendarPublicationStatus | undefined) => void;
  /** Client-side filter over already-fetched events — "all" means no filtering. */
  platformFilter: SocialPlatform | "all";
  onPlatformChange: (platform: SocialPlatform | "all") => void;
};

export function CalendarFilters({ statusFilter, onStatusChange, platformFilter, onPlatformChange }: CalendarFiltersProps) {
  return (
    <div className="flex flex-wrap items-end gap-space-md">
      <div className="flex flex-col gap-space-xs">
        <label htmlFor="calendar-status-filter" className={labelClass}>
          Status
        </label>
        <select
          id="calendar-status-filter"
          className={selectClass}
          value={statusFilter ?? "all"}
          onChange={(event) => {
            const value = event.target.value;
            onStatusChange(value === "all" ? undefined : (value as CalendarPublicationStatus));
          }}
        >
          <option value="all">All</option>
          {CALENDAR_PUBLICATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-space-xs">
        <label htmlFor="calendar-platform-filter" className={labelClass}>
          Platform
        </label>
        <select
          id="calendar-platform-filter"
          className={selectClass}
          value={platformFilter}
          onChange={(event) => onPlatformChange(event.target.value as SocialPlatform | "all")}
        >
          <option value="all">All</option>
          {PLATFORMS.map((platform) => (
            <option key={platform} value={platform}>
              {PLATFORM_LABEL[platform]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
