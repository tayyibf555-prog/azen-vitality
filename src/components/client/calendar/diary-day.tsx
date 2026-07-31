"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { hourMarks, labelMinutes, layoutColumn, type Placed } from "./diary-grid";
import {
  blockEdges,
  columnCounts,
  initialsOf,
  interiorGaps,
  pxPerMinute,
  COL_MIN_PX,
  GUTTER_PX,
  GUTTER_PX_SM,
  HEADER_PX,
  type DiaryAppointment,
  type InteriorGap,
  type Zoom,
} from "./diary-view";
import { AppointmentBlock } from "./appointment-block";

// ---------------------------------------------------------------------------
// The grid: time down the page, one column across per clinician (or, in week
// view, per day). Both views share this component so the geometry, the rules,
// the rounding and the sticky chrome can only ever be right or wrong once.
//
// Construction notes that are load-bearing rather than stylistic:
//
//   - ONE element owns both scroll axes at lg and above. Below lg the page
//     scrolls vertically and the diary shows a single column, because per CSS
//     Overflow 3 a container cannot have page-scrolled vertical, container-
//     scrolled horizontal and vertically sticky headers at the same time.
//   - Every sticky cell sets an opaque bg-card, or scrolled content shows through.
//   - The rules are drawn ONCE as a full-width overlay rather than repeated per
//     column, and they sit FIRST in the DOM so blocks paint over them.
//   - Exactly two rule weights exist. The neutral ramp inside .app-frame jumps
//     from #dde5f0 straight to #94a3b8 with nothing usable between, so the third
//     level of hierarchy is carried by the LABEL (hours labelled, half hours
//     not) and never by a louder line.
// ---------------------------------------------------------------------------

export interface GridColumn {
  /** Stable key: a practitioner id, the unassigned sentinel, or a day key. */
  key: string;
  /** The id the column's <ul> points at with aria-labelledby. */
  headerId: string;
  /** The untruncated header sentence, e.g. "Jin Kim, 8 booked, 2 pending". */
  headerLabel: string;
  /** The visible header content. */
  header: React.ReactNode;
  onHeaderClick?: () => void;
  headerPressed?: boolean;
  headerDisabled?: boolean;
  headerTitle?: string;
  /** Draws the 3px navy bar along the header's top edge. */
  marked?: boolean;
  placed: Placed<DiaryAppointment>[];
  gaps: InteriorGap[];
  // NO empty-state label in the column body. The header's second line already
  // reads "Nothing booked" or "Not loaded" under exactly the same conditions
  // (columnCounts falls back to the former, countsUnavailable forces the
  // latter), and a body label repeated a few pixels below it read as a bug.
  // The header is also the better of the two to keep: it is sticky, so it
  // survives scrolling, whereas a label pinned to the top of the body does not.
  /** Named in every block's accessible sentence. */
  clinicianName: string | null;
  /** Week view only: the now-line inside this column, in px from the day's top. */
  nowTop?: number | null;
}

export function DiaryGrid({
  columns,
  bounds,
  zoom,
  ariaLabel,
  mobileKey,
  nowTop,
  nowLabel,
  focusedId,
  onFocusItem,
  onOpen,
  onKeyDown,
  describedById,
}: {
  columns: GridColumn[];
  bounds: { startMin: number; endMin: number };
  zoom: Zoom;
  ariaLabel: string;
  /** The one column drawn below lg, where there is no horizontal scroll. */
  mobileKey: string;
  /** Day view: a full-width now-line. Null on any day but today. */
  nowTop: number | null;
  nowLabel: string | null;
  focusedId: string | null;
  onFocusItem: (colIndex: number, appt: DiaryAppointment) => void;
  onOpen: (appt: DiaryAppointment) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  describedById: string;
}) {
  const ppm = pxPerMinute(zoom);
  const dayHeight = Math.round((bounds.endMin - bounds.startMin) * ppm);

  const hours = useMemo(() => hourMarks(bounds), [bounds]);
  const halves = useMemo(() => {
    const out: number[] = [];
    for (let m = Math.ceil(bounds.startMin / 30) * 30; m <= bounds.endMin; m += 30) {
      if (m % 60 !== 0) out.push(m);
    }
    return out;
  }, [bounds]);

  const topOf = (min: number) => blockEdges(min, min, bounds.startMin, zoom).top;

  // The rules and the now-line are drawn INSIDE each body cell rather than as one
  // overlay across the grid. An absolutely positioned child of the grid is sized
  // to the grid's own box, which is only the VISIBLE width once thirteen columns
  // overflow it, so an overlay would stop dead at the viewport edge and leave the
  // scrolled-to columns unruled and uncrossed by the now-line.
  const rules = (
    <>
      {hours.map((m) => (
        <div
          key={`h-${m}`}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-line-strong"
          style={{ top: topOf(m) }}
        />
      ))}
      {halves.map((m) => (
        <div
          key={`m-${m}`}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-line"
          style={{ top: topOf(m) }}
        />
      ))}
    </>
  );

  // Navy, not --danger: red already means did-not-attend and money owed on this
  // screen, and a red rule crossing a red DNA block is unreadable.
  //
  // z-0, NOT a high z-index. A body cell is position:relative with z-index:auto,
  // so it does NOT open a stacking context and its children compete directly
  // with the sticky header row (z-[2] at lg). At z-[4] the now-line and its time
  // chip painted straight over the clinician headers the moment the day was
  // scrolled past the current time. z-0 still beats the blocks, because they sit
  // EARLIER in the DOM at the same level.
  const nowRule =
    nowTop === null ? null : (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 z-0 h-[2px] bg-navy"
        style={{ top: nowTop }}
      />
    );

  return (
    <section
      aria-label={ariaLabel}
      aria-describedby={describedById}
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End Enter Escape T D W S"
      onKeyDown={onKeyDown}
      className={cn(
        "overflow-x-hidden border-y border-line",
        "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col",
      )}
    >
      <div className="overflow-x-hidden lg:min-h-0 lg:flex-1 lg:overflow-auto lg:overscroll-contain">
        <div
          className="grid [grid-template-columns:var(--diary-cols-sm)] lg:[grid-template-columns:var(--diary-cols)]"
          style={
            {
              "--diary-cols-sm": `${GUTTER_PX_SM}px minmax(0, 1fr)`,
              // repeat() requires an integer of at least 1: repeat(0, ...) is
              // invalid at computed-value time and takes the WHOLE declaration
              // down to `none`, leaving a bare time gutter with no explanation.
              // Zero columns is a real state (a site with no clinicians and
              // nothing booked), so the floor is structural, not defensive.
              "--diary-cols": `${GUTTER_PX}px repeat(${Math.max(1, columns.length)}, minmax(${COL_MIN_PX}px, 1fr))`,
              gridTemplateRows: `${HEADER_PX}px ${dayHeight}px`,
            } as React.CSSProperties
          }
        >
          {/* Header row. Every sticky cell sets an opaque bg-card, or scrolled
              content shows through it. */}
          <div className="sticky left-0 top-14 z-[3] border-b border-line-strong bg-card lg:top-0" />
          {columns.map((col) => (
            <div
              key={`head-${col.key}`}
              className={cn(
                "sticky top-14 z-[1] border-b border-line-strong border-l border-line bg-card lg:top-0 lg:z-[2]",
                col.key === mobileKey ? "block" : "hidden lg:block",
              )}
            >
              <button
                type="button"
                onClick={col.onHeaderClick}
                disabled={col.headerDisabled}
                aria-pressed={col.onHeaderClick ? Boolean(col.headerPressed) : undefined}
                title={col.headerTitle}
                className={cn(
                  "relative flex h-full w-full flex-col justify-center gap-[1px] overflow-hidden px-2 py-1 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  col.headerDisabled ? "cursor-not-allowed opacity-40" : "hover:bg-card-muted/50",
                )}
              >
                {/* The selection reads from across a desk, not only by a pressed chip. */}
                {col.marked ? (
                  <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-navy" />
                ) : null}
                <h3 id={col.headerId} className="sr-only">
                  {col.headerLabel}
                </h3>
                {col.header}
              </button>
            </div>
          ))}

          {/* Body row: the sticky gutter, then one positioned cell per column. */}
          <div
            className="sticky left-0 z-[1] border-r border-line-strong bg-card"
            style={{ height: dayHeight }}
          >
            <div className="relative h-full">
              {rules}
              {hours.map((m) => (
                <span
                  key={`gl-${m}`}
                  className="absolute inset-x-0 -translate-y-[0.5em] pr-2 text-right text-[11px] font-medium tabular-nums text-muted"
                  style={{ top: topOf(m) }}
                >
                  {labelMinutes(m)}
                </span>
              ))}
              {zoom === "roomy"
                ? halves.map((m) => (
                    <span
                      key={`gh-${m}`}
                      className="absolute inset-x-0 -translate-y-[0.5em] pr-2 text-right text-[10px] font-normal tabular-nums text-muted"
                      style={{ top: topOf(m) }}
                    >
                      {labelMinutes(m)}
                    </span>
                  ))
                : null}
              {nowRule}
              {nowTop === null ? null : (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-[2px] z-[4] -translate-y-1/2 rounded-[3px] bg-navy px-1 text-[10px] font-semibold leading-[1.4] tabular-nums text-white"
                  style={{ top: nowTop }}
                >
                  {nowLabel}
                </span>
              )}
            </div>
          </div>

          {columns.map((col, colIndex) => (
            <div
              key={`body-${col.key}`}
              className={cn(
                "relative border-l border-line",
                col.key === mobileKey ? "block" : "hidden lg:block",
              )}
              style={{ height: dayHeight }}
            >
              {rules}

              {/* The one quantified statement about empty time: a gap bounded on
                  BOTH sides by a drawn block. No fill, no frame, no hover, no
                  click, because booking into an empty slot is out of scope and
                  the affordance must not exist even by accident. */}
              {col.gaps.map((gap) => (
                <span
                  key={`gap-${gap.top}`}
                  aria-hidden
                  className="absolute inset-x-0 flex cursor-default items-center justify-center text-[10px] font-medium tabular-nums text-muted"
                  style={{ top: gap.top, height: gap.height }}
                >
                  {gap.minutes}m
                </span>
              ))}

              <ul aria-labelledby={col.headerId} className="absolute inset-0">
                {col.placed.map((placed) => (
                  <AppointmentBlock
                    key={placed.item.id}
                    placed={placed}
                    boundsStartMin={bounds.startMin}
                    boundsEndMin={bounds.endMin}
                    zoom={zoom}
                    clinicianName={col.clinicianName}
                    focused={focusedId === placed.item.id}
                    onOpen={onOpen}
                    onFocus={() => onFocusItem(colIndex, placed.item)}
                  />
                ))}
              </ul>

              {/* Day view crosses every column; week view draws the line inside
                  today's column only. */}
              {nowRule}
              {typeof col.nowTop === "number" ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 z-0 h-[2px] bg-navy"
                  style={{ top: col.nowTop }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Day view: one column per clinician working that day.
// ---------------------------------------------------------------------------

export interface DayColumnInput {
  key: string;
  id: string | null;
  name: string;
  appointments: DiaryAppointment[];
}

export function DiaryDay({
  columns,
  bounds,
  zoom,
  ariaLabel,
  soloKey,
  onSolo,
  countsUnavailable,
  nowTop,
  nowLabel,
  focusedId,
  onFocusItem,
  onOpen,
  onKeyDown,
  describedById,
}: {
  columns: DayColumnInput[];
  bounds: { startMin: number; endMin: number };
  zoom: Zoom;
  ariaLabel: string;
  soloKey: string | null;
  onSolo: (key: string) => void;
  /** True when the appointment read or the clinician read failed: every derived
   *  figure is suppressed, because a gap-aware screen computing from a failed
   *  read invents free time. */
  countsUnavailable: boolean;
  nowTop: number | null;
  nowLabel: string | null;
  focusedId: string | null;
  onFocusItem: (colIndex: number, appt: DiaryAppointment) => void;
  onOpen: (appt: DiaryAppointment) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  describedById: string;
}) {
  const grid: GridColumn[] = useMemo(
    () =>
      columns.map((col) => {
        const placed = layoutColumn(col.appointments);
        const summary = countsUnavailable ? "Not loaded" : columnCounts(col.appointments);
        const soloed = soloKey === col.key;
        return {
          key: col.key,
          headerId: `diary-col-${col.key}`,
          headerLabel: `${col.name}, ${summary}`,
          header: (
            <>
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full bg-card-muted text-[9px] font-semibold text-navy"
                >
                  {initialsOf(col.name)}
                </span>
                <span
                  title={col.name}
                  className="truncate text-[11px] font-medium leading-[1.2] text-navy"
                >
                  {col.name}
                </span>
              </span>
              <span
                className={cn(
                  "block truncate text-[10px] leading-[1.25] tabular-nums",
                  countsUnavailable ? "font-semibold text-ink" : "font-medium text-muted",
                )}
              >
                {summary}
              </span>
            </>
          ),
          onHeaderClick: () => onSolo(col.key),
          headerPressed: soloed,
          headerTitle: soloed ? "Show every clinician" : `Show only ${col.name}`,
          marked: soloed,
          placed,
          gaps: countsUnavailable
            ? []
            : interiorGaps(placed, bounds.startMin, bounds.endMin, zoom),
          clinicianName: col.name,
        };
      }),
    [columns, bounds.startMin, bounds.endMin, zoom, soloKey, onSolo, countsUnavailable],
  );

  return (
    <DiaryGrid
      columns={grid}
      bounds={bounds}
      zoom={zoom}
      ariaLabel={ariaLabel}
      mobileKey={soloKey ?? columns[0]?.key ?? ""}
      nowTop={nowTop}
      nowLabel={nowLabel}
      focusedId={focusedId}
      onFocusItem={onFocusItem}
      onOpen={onOpen}
      onKeyDown={onKeyDown}
      describedById={describedById}
    />
  );
}
