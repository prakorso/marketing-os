"use client";

import Link from "next/link";

import { Button } from "@/components/ui/Button";

const MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

// Matches Button's "secondary" variant classes — used here on <Link> (a
// real <a>) rather than nesting a <button> inside an anchor, since
// prev/next are genuine navigations (Use semantic buttons/links).
const navLinkClass =
  "inline-flex items-center justify-center gap-1.5 rounded-control border border-outline-variant bg-surface-container-lowest px-3.5 py-2 font-label text-label-md font-medium tracking-wide text-on-surface transition hover:bg-surface-container-low";

type CalendarToolbarProps = {
  /** Browser-local reference date for computing prev/next/today targets and the month label. */
  displayDate: Date;
  buildMonthHref: (year: number, month: number) => string;
  onToday: () => void;
};

/**
 * Prev/next are relative navigations (correct regardless of timezone, so
 * plain server-navigable links), while Today must resolve the viewer's
 * actual local "now" — onToday is provided by CalendarView, which has
 * access to the real browser Date.
 */
export function CalendarToolbar({ displayDate, buildMonthHref, onToday }: CalendarToolbarProps) {
  const year = displayDate.getFullYear();
  const month = displayDate.getMonth();

  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  return (
    <div className="flex flex-wrap items-center justify-between gap-space-md">
      <h2 className="font-headline text-headline-md font-bold text-on-surface">{MONTH_FORMATTER.format(displayDate)}</h2>
      <div className="flex items-center gap-space-xs">
        <Link href={buildMonthHref(prevYear, prevMonth)} aria-label="Previous month" className={navLinkClass}>
          ←
        </Link>
        <Button type="button" variant="secondary" onClick={onToday} aria-label="Go to today">
          Today
        </Button>
        <Link href={buildMonthHref(nextYear, nextMonth)} aria-label="Next month" className={navLinkClass}>
          →
        </Link>
      </div>
    </div>
  );
}
