"use client";

import { CalendarEventChip } from "@/components/calendar/CalendarEvent";
import type { CalendarEvent } from "@/components/calendar/types";

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat(undefined, { weekday: "short" });
// January 1, 2023 was a Sunday — used only as a stable reference date to
// derive localized Sun..Sat weekday labels via Intl, not for any date math.
const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, index) => WEEKDAY_FORMATTER.format(new Date(2023, 0, 1 + index)));

type CalendarGridProps = {
  /** Browser-local target year/month (0-indexed month, JS Date convention). */
  year: number;
  month: number;
  /** Day-of-month (1-31, browser-local) -> events already matched to that local day. */
  eventsByDay: Map<number, CalendarEvent[]>;
  selectedEventId: string | null;
  onSelectEvent: (publicationId: string) => void;
};

/**
 * Renders a standard month grid using only native Date — handles any
 * starting weekday and any month length (28-31 days) by computing the
 * leading blank count and total cell count directly, with no hard-coded
 * assumptions. All date math here operates on the *local* Date
 * constructor (new Date(year, month, day)), which is inherently
 * browser-timezone-aware — this is what makes the grid correct across
 * DST transitions without any timezone library.
 */
export function CalendarGrid({ year, month, eventsByDay, selectedEventId, onSelectEvent }: CalendarGridProps) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = new Date(year, month, 1).getDay();
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  return (
    <div
      role="grid"
      aria-label="Calendar month grid"
      className="grid grid-cols-7 gap-px overflow-hidden rounded-card border border-outline-variant bg-outline-variant"
    >
      {WEEKDAY_LABELS.map((label) => (
        <div
          key={label}
          role="columnheader"
          className="bg-surface-container-low px-space-xs py-space-xs text-center font-label text-label-sm font-semibold text-on-surface-variant"
        >
          {label}
        </div>
      ))}

      {Array.from({ length: totalCells }, (_, index) => {
        const dayNumber = index - leadingBlanks + 1;
        const isInMonth = dayNumber >= 1 && dayNumber <= daysInMonth;
        const dayEvents = isInMonth ? (eventsByDay.get(dayNumber) ?? []) : [];
        const isToday = isInMonth && isCurrentMonth && dayNumber === today.getDate();

        return (
          <div
            key={index}
            role="gridcell"
            className={`flex min-h-28 flex-col gap-1 bg-surface-container-lowest p-1 ${
              isInMonth ? "" : "bg-surface-container-low/40"
            }`}
          >
            {isInMonth ? (
              <span
                className={`self-end font-label text-label-sm ${
                  isToday
                    ? "rounded-full bg-primary px-1.5 py-0.5 text-on-primary"
                    : "text-on-surface-variant"
                }`}
              >
                {dayNumber}
              </span>
            ) : null}
            <div className="flex flex-col gap-1 overflow-y-auto">
              {dayEvents.map((event) => (
                <CalendarEventChip
                  key={event.publicationId}
                  event={event}
                  onSelect={onSelectEvent}
                  selected={event.publicationId === selectedEventId}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
