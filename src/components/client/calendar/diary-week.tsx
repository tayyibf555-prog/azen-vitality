"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { FundingCode } from "@/lib/calendar/funding";
import type { DiaryEntryRecord } from "@/lib/calendar/entries";
import type { ColumnWorkState, Span } from "@/lib/calendar/working-spans";
import { capacityLine, capacitySentence, columnCapacity } from "@/lib/calendar/capacity";
import { layoutColumn } from "./diary-grid";
import { dow, dnum, mondayOf, shiftDay } from "./calendar-logic";
import {
  columnCounts,
  initialsOf,
  interiorGaps,
  type DiaryAppointment,
  type Zoom,
} from "./diary-view";
import { DiaryGrid, type GridColumn, type GridDrag } from "./diary-day";

// ---------------------------------------------------------------------------
// The day-per-column views: MULTIDAY and WEEK, for ONE clinician.
//
// They are the SAME COMPONENT. Week is multiday with a span of seven anchored to
// Monday, so DiaryWeek is now a thin wrapper over DiaryDays and nothing that
// imports it breaks. DiaryGrid is used VERBATIM: it already takes an arbitrary
// columns: GridColumn[] with an optional per-column nowTop, which is exactly what
// a day-per-column view needs. Zero geometry, zero rules and zero sticky chrome
// is duplicated. The one thing that must never fork is the placement code.
//
// Everyone at once is deliberately NOT offered: seven days by thirteen
// clinicians is 91 columns, and eight lanes in a 112px column is a 14px block
// with no text on it. The column axis carries one dimension and the day axis has
// taken it, so the clinician rail is how you change whose days you are reading.
// The mitigation for whole-practice figures is the seven-day strip above, which
// carries per-day counts for the whole practice in EVERY view.
// ---------------------------------------------------------------------------

export interface DayColumnDayInput {
  dayKey: string;
  appointments: DiaryAppointment[];
  /** False for a day outside the window the server actually fetched. */
  inWindow: boolean;
  isToday: boolean;
  /** The now-line's offset inside this day's column, when it is today. */
  nowTop: number | null;
  workState: ColumnWorkState;
  /** The London wall-minute this day's hours could be asked about from. See GridColumn. */
  answerableFromMin?: number;
  workingSpans: Span[];
  entries: DiaryEntryRecord[];
}

export function DiaryDays({
  days,
  clinicianName,
  bounds,
  zoom,
  ariaLabel,
  countsUnavailable,
  funding,
  hoursPending = false,
  onPickDay,
  focusedId,
  onFocusItem,
  onOpen,
  onOpenEntry,
  onKeyDown,
  describedById,
  selectedDay,
  drag,
}: {
  days: DayColumnDayInput[];
  clinicianName: string | null;
  bounds: { startMin: number; endMin: number };
  zoom: Zoom;
  ariaLabel: string;
  countsUnavailable: boolean;
  funding: Record<string, FundingCode>;
  /** True while the availability read for these days is still in flight. Same
   *  texture as a failure, different words: see DiaryDay. */
  hoursPending?: boolean;
  /** Drills through to that day in day view, which is what staff already expect. */
  onPickDay: (dayKey: string) => void;
  focusedId: string | null;
  onFocusItem: (colIndex: number, appt: DiaryAppointment) => void;
  onOpen: (appt: DiaryAppointment) => void;
  onOpenEntry?: (entry: DiaryEntryRecord) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  describedById: string;
  selectedDay: string;
  drag?: GridDrag;
}) {
  const columns: GridColumn[] = useMemo(
    () =>
      days.map((d) => {
        const placed = d.inWindow ? layoutColumn(d.appointments) : [];
        const unavailable = !d.inWindow || countsUnavailable;
        // A day outside the loaded window is drawn and MARKED, never shown as
        // empty: an unfetched day renders as zero appointments, which is
        // indistinguishable from a free day on a fully booked diary.
        const summary = unavailable
          ? "Not loaded"
          : d.workState === "unknown"
            ? hoursPending
              ? "Reading hours"
              : "Hours not loaded"
            : d.workState === "unconfirmed"
              ? // NOT "Not working": they may be working at another of these
                // practices, and availability carries no site to tell us which.
                "Not confirmed here"
              : d.workState === "past"
                ? // NOT "Hours not loaded": nothing failed and nothing will load.
                  // Dentally will not answer for a date that has gone by.
                  "Date has passed"
                : d.workState === "unreportable"
                  ? // TODAY, seen after lunch. NOT "Date has passed" -- it has not
                    // -- and NOT "Not working": the morning is missing from the
                    // answer because nobody could ask about it, not because
                    // nobody was in. Same words as the day view, deliberately.
                    "Hours not reportable"
                  : d.workState === "off"
                    ? "Not working"
                    : columnCounts(d.appointments);
        // A date in the past is as quiet as a pending read: there is nothing for
        // the reader to do about either.
        const loud =
          unavailable ||
          (d.workState === "unknown" && !hoursPending) ||
          d.workState === "unconfirmed";

        // The same free-time figure the day view prints, asking the week's own
        // question: which day this week has room. Identical rules — only a
        // column that can honestly claim to be working gets one, and cancelled
        // and did-not-attend do not consume time. See capacity.ts.
        const breaks = d.entries
          .filter((e) => e.kind === "break")
          .map((e) => ({ startMin: e.startMin, endMin: e.endMin }));
        const capacity =
          unavailable || d.workState !== "working"
            ? null
            : columnCapacity({
                working: d.workingSpans,
                occupied: placed
                  .filter(
                    (p) => p.item.state !== "cancelled" && p.item.state !== "did_not_attend",
                  )
                  .map((p) => ({ startMin: p.startMin, endMin: p.endMin })),
                breaks,
                bounds: { startMin: bounds.startMin, endMin: bounds.endMin },
              });
        const capLine = capacityLine(capacity);
        const capSentence = capacitySentence(clinicianName ?? "This clinician", capacity);

        return {
          key: d.dayKey,
          headerId: `diary-daycol-${d.dayKey}`,
          headerLabel: `${dow(d.dayKey)} ${dnum(d.dayKey)}, ${clinicianName ?? "no clinician"}, ${summary}${
            capSentence ? `. ${capSentence}` : ""
          }`,
          header: (
            <>
              <span className="flex items-baseline gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
                  {dow(d.dayKey)}
                </span>
                <span
                  className={cn(
                    "text-[12.5px] font-bold tabular-nums tracking-[-0.2px]",
                    d.isToday ? "text-blue-royal" : "text-navy",
                  )}
                >
                  {dnum(d.dayKey)}
                </span>
              </span>
              {/* The reference shows the clinician's initials alone on line 2. We
                  keep the initials AND the counts, because dropping a figure to
                  calm a screen is a defect here, not a simplification. */}
              <span className="flex min-w-0 items-center gap-1">
                {clinicianName ? (
                  <span
                    aria-hidden
                    title={clinicianName}
                    className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full bg-card-muted text-[9px] font-semibold text-navy"
                  >
                    {initialsOf(clinicianName)}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "block truncate text-[10px] leading-[1.25] tabular-nums",
                    loud
                      ? "font-semibold text-ink"
                      : d.workState === "off"
                        ? "font-semibold text-muted"
                        : "font-medium text-muted",
                  )}
                >
                  {summary}
                </span>
              </span>
              {capLine ? (
                <span className="block truncate text-[9.5px] font-semibold leading-[1.2] tabular-nums text-blue-royal">
                  {capLine}
                </span>
              ) : null}
            </>
          ),
          onHeaderClick: d.inWindow ? () => onPickDay(d.dayKey) : undefined,
          headerDisabled: !d.inWindow,
          headerTitle: capSentence
            ? `${capSentence} ${d.inWindow ? "Click to open this day." : "Not loaded."}`
            : d.inWindow
              ? "Open this day"
              : "Not loaded",
          marked: d.dayKey === selectedDay,
          placed,
          // Cut to real sessions and around breaks, and not drawn at all unless
          // the column can honestly claim to be working. See interiorGaps.
          gaps:
            unavailable || d.workState !== "working"
              ? []
              : interiorGaps(
                  placed,
                  bounds.startMin,
                  bounds.endMin,
                  zoom,
                  d.workingSpans,
                  // Already scoped to this clinician and day by the board. Only a
                  // BREAK consumes time; a note does not.
                  d.entries
                    .filter((e) => e.kind === "break")
                    .map((e) => ({ startMin: e.startMin, endMin: e.endMin })),
                ),
          clinicianName,
          nowTop: d.nowTop,
          workState: d.workState,
          answerableFromMin: d.answerableFromMin,
          workingSpans: d.workingSpans,
          entries: d.entries,
          funding,
          onOpenEntry,
        };
      }),
    [
      days,
      clinicianName,
      bounds.startMin,
      bounds.endMin,
      zoom,
      countsUnavailable,
      funding,
      hoursPending,
      onPickDay,
      onOpenEntry,
      selectedDay,
    ],
  );

  return (
    <DiaryGrid
      columns={columns}
      bounds={bounds}
      zoom={zoom}
      ariaLabel={ariaLabel}
      mobileKey={selectedDay}
      nowTop={null}
      nowLabel={null}
      focusedId={focusedId}
      onFocusItem={onFocusItem}
      onOpen={onOpen}
      onKeyDown={onKeyDown}
      describedById={describedById}
      drag={drag}
    />
  );
}

/**
 * The seven days of the week containing `day`, Monday first.
 *
 * This is the ONLY difference between week view and multiday: week is multiday
 * with a span of seven, anchored to Monday instead of running forward from the
 * selected day. It lives beside DiaryDays so that anchoring rule sits with the
 * component that draws it, and so it can never be confused with multiday's own
 * anchor-FORWARD rule in multidaySpanKeys.
 *
 * There is deliberately no `DiaryWeek` wrapper any more. Nothing imports one, and
 * a component called DiaryWeek that did NOT anchor to Monday would be a trap for
 * whoever reached for it next.
 */
export function weekDayKeys(day: string): string[] {
  const mon = mondayOf(day);
  return Array.from({ length: 7 }, (_, i) => shiftDay(mon, i));
}
