"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { CalendarToolbar } from "@/components/calendar/CalendarToolbar";
import { CalendarFilters } from "@/components/calendar/CalendarFilters";
import { CalendarGrid } from "@/components/calendar/CalendarGrid";
import type { CalendarEvent } from "@/components/calendar/types";
import { cancelPublicationAction, reschedulePublicationAction } from "@/app/w/[slug]/calendar/actions";
import type { CalendarPublicationStatus } from "@/components/calendar/types";
import type { SocialPlatform } from "@/types/database";

// Only 'scheduled' is both cancellable (publications.ts's
// CANCELLABLE_STATUSES) and a sensible target for "pick a new time" —
// publishing/published/failed/cancelled are calendar-visible (per the
// locked MVP-2.5 status scope) but intentionally get no reschedule/cancel
// controls here. This is a UI-layer affordance choice, not a new business
// rule: schedulePublication/cancelPublication and their triggers remain
// the actual, unchanged authority regardless of what this component shows.
const RESCHEDULABLE_STATUSES: CalendarPublicationStatus[] = ["scheduled"];
const CANCELLABLE_STATUSES: CalendarPublicationStatus[] = ["scheduled"];

const DATETIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type CalendarViewProps = {
  workspaceSlug: string;
  /** Server-resolved target year/month (0-indexed), possibly a UTC-based default — see page.tsx. */
  year: number;
  month: number;
  statusFilter: CalendarPublicationStatus | undefined;
  events: CalendarEvent[];
  canEdit: boolean;
};

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CalendarView({ workspaceSlug, year, month, statusFilter, events, canEdit }: CalendarViewProps) {
  const router = useRouter();
  const [platformFilter, setPlatformFilter] = useState<SocialPlatform | "all">("all");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);

  function buildMonthHref(targetYear: number, targetMonth: number, targetStatus = statusFilter): string {
    const params = new URLSearchParams();
    params.set("year", String(targetYear));
    params.set("month", String(targetMonth + 1)); // URL is 1-indexed for readability
    if (targetStatus) params.set("status", targetStatus);
    return `/w/${workspaceSlug}/calendar?${params.toString()}`;
  }

  // The server defaults to the UTC "current month" when no year/month
  // params are present, since it cannot know the viewer's timezone. Once
  // mounted, correct to the viewer's actual local current month if they
  // differ — this only ever fires on the very first, param-less load.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("year") || params.has("month")) return;

    const now = new Date();
    if (now.getFullYear() !== year || now.getMonth() !== month) {
      router.replace(buildMonthHref(now.getFullYear(), now.getMonth()));
    }
    // Intentionally only on mount — this is a one-time correction, not a
    // continuous sync (the URL becomes the source of truth afterward).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const eventsByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    for (const event of events) {
      if (platformFilter !== "all" && event.accountPlatform !== platformFilter) continue;

      const local = new Date(event.scheduledAt);
      if (local.getFullYear() !== year || local.getMonth() !== month) continue; // outside the padded fetch's target month

      const day = local.getDate();
      const existing = map.get(day) ?? [];
      existing.push(event);
      map.set(day, existing);
    }
    return map;
  }, [events, platformFilter, year, month]);

  const visibleEventCount = useMemo(
    () => [...eventsByDay.values()].reduce((total, dayEvents) => total + dayEvents.length, 0),
    [eventsByDay],
  );

  const selectedEvent = events.find((event) => event.publicationId === selectedEventId) ?? null;

  return (
    <div className="flex flex-col gap-space-lg">
      <CalendarToolbar
        displayDate={new Date(year, month, 1)}
        buildMonthHref={(y, m) => buildMonthHref(y, m)}
        onToday={() => {
          const now = new Date();
          router.push(buildMonthHref(now.getFullYear(), now.getMonth()));
        }}
      />

      <CalendarFilters
        statusFilter={statusFilter}
        onStatusChange={(status) => router.push(buildMonthHref(year, month, status))}
        platformFilter={platformFilter}
        onPlatformChange={setPlatformFilter}
      />

      {visibleEventCount === 0 ? (
        <EmptyState
          title="No publications for this period"
          description="No scheduled or completed publications match the selected month and filters."
        />
      ) : (
        <CalendarGrid
          year={year}
          month={month}
          eventsByDay={eventsByDay}
          selectedEventId={selectedEventId}
          onSelectEvent={(id) => {
            setSelectedEventId((current) => (current === id ? null : id));
            setRescheduling(false);
          }}
        />
      )}

      {selectedEvent ? (
        <Card className="flex flex-col gap-space-md">
          <div className="flex items-start justify-between gap-space-md">
            <div className="flex flex-col gap-space-xs">
              <span className="font-label text-label-sm uppercase tracking-wider text-secondary font-semibold">
                Publication
              </span>
              <span className="font-body text-body-md font-semibold text-on-surface">{selectedEvent.contentTitle}</span>
              <span className="font-label text-label-sm text-on-surface-variant">
                {selectedEvent.accountPlatform ?? "—"}
                {selectedEvent.accountName ? ` · ${selectedEvent.accountName}` : ""}
                {selectedEvent.accountHandle ? ` (@${selectedEvent.accountHandle})` : ""}
              </span>
              <span className="font-label text-label-sm text-on-surface-variant">
                {DATETIME_FORMATTER.format(new Date(selectedEvent.scheduledAt))}
              </span>
            </div>
            <Badge
              variant={
                selectedEvent.status === "failed" ? "alert" : selectedEvent.status === "cancelled" || selectedEvent.status === "scheduled" ? "neutral" : "active"
              }
            >
              {selectedEvent.status}
            </Badge>
          </div>

          <a
            href={`/w/${workspaceSlug}/content/${selectedEvent.contentId}`}
            className="self-start font-label text-label-sm font-semibold text-secondary underline underline-offset-2"
          >
            View in Content Studio
          </a>

          {canEdit && RESCHEDULABLE_STATUSES.includes(selectedEvent.status as CalendarPublicationStatus) ? (
            rescheduling ? (
              <form action={reschedulePublicationAction} className="flex flex-wrap items-end gap-space-sm border-t border-outline-variant pt-space-md">
                <input type="hidden" name="slug" value={workspaceSlug} />
                <input type="hidden" name="publication_id" value={selectedEvent.publicationId} />
                <input type="hidden" name="year" value={String(year)} />
                <input type="hidden" name="month" value={String(month + 1)} />
                {statusFilter ? <input type="hidden" name="status" value={statusFilter} /> : null}
                <div className="flex flex-col gap-space-xs">
                  <label htmlFor="scheduled_at" className="font-label text-label-sm font-semibold text-on-surface">
                    New date &amp; time
                  </label>
                  <input
                    id="scheduled_at"
                    name="scheduled_at"
                    type="datetime-local"
                    required
                    defaultValue={toDatetimeLocalValue(selectedEvent.scheduledAt)}
                    className="rounded-control border border-outline-variant bg-surface-container-lowest px-space-md py-space-sm font-body text-body-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-secondary"
                  />
                </div>
                <Button type="submit">Confirm reschedule</Button>
                <Button type="button" variant="tertiary" onClick={() => setRescheduling(false)}>
                  Cancel edit
                </Button>
              </form>
            ) : (
              <div className="flex items-center gap-space-sm border-t border-outline-variant pt-space-md">
                <Button type="button" variant="secondary" onClick={() => setRescheduling(true)}>
                  Reschedule
                </Button>
                {CANCELLABLE_STATUSES.includes(selectedEvent.status as CalendarPublicationStatus) ? (
                  <form action={cancelPublicationAction}>
                    <input type="hidden" name="slug" value={workspaceSlug} />
                    <input type="hidden" name="publication_id" value={selectedEvent.publicationId} />
                    <input type="hidden" name="year" value={String(year)} />
                    <input type="hidden" name="month" value={String(month + 1)} />
                    {statusFilter ? <input type="hidden" name="status" value={statusFilter} /> : null}
                    <Button type="submit" variant="tertiary">
                      Cancel publication
                    </Button>
                  </form>
                ) : null}
              </div>
            )
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
