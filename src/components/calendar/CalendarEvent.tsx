"use client";

import { Badge } from "@/components/ui/Badge";
import type { CalendarEvent } from "@/components/calendar/types";
import type { PublicationStatus } from "@/types/database";

const STATUS_BADGE_VARIANT: Record<PublicationStatus, "neutral" | "active" | "alert"> = {
  draft: "neutral",
  approved: "neutral",
  scheduled: "neutral",
  publishing: "active",
  published: "active",
  failed: "alert",
  cancelled: "neutral",
};

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

type CalendarEventChipProps = {
  event: CalendarEvent;
  onSelect: (publicationId: string) => void;
  selected: boolean;
};

/**
 * A single day cell's event chip. A real <button> (not a clickable <div>)
 * so it is keyboard-reachable and activatable without a mouse.
 */
export function CalendarEventChip({ event, onSelect, selected }: CalendarEventChipProps) {
  const localTime = TIME_FORMATTER.format(new Date(event.scheduledAt));
  const label = `${event.contentTitle}, ${event.accountPlatform ?? "unknown platform"}, ${event.status}, ${localTime}`;

  return (
    <button
      type="button"
      onClick={() => onSelect(event.publicationId)}
      aria-label={label}
      aria-pressed={selected}
      className={`flex w-full flex-col gap-0.5 rounded-control border px-space-xs py-1 text-left transition ${
        selected
          ? "border-secondary bg-surface-container-low"
          : "border-outline-variant bg-surface-container-lowest hover:bg-surface-container-low"
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-label text-label-sm font-medium text-on-surface">{localTime}</span>
        <Badge variant={STATUS_BADGE_VARIANT[event.status]}>{event.status}</Badge>
      </div>
      <span className="truncate font-body text-body-sm text-on-surface">{event.contentTitle}</span>
      <span className="truncate font-label text-label-sm text-on-surface-variant">
        {event.accountPlatform ?? "—"}
        {event.accountName ? ` · ${event.accountName}` : ""}
      </span>
    </button>
  );
}
