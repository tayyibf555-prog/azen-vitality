"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { FundingCode } from "@/lib/calendar/funding";
import { occupyingEntries, type DiaryEntryRecord } from "@/lib/calendar/entries";
import { offSpans, type ColumnWorkState, type Span } from "@/lib/calendar/working-spans";
import { labelMinutes, layoutColumn, type Placed } from "./diary-grid";
import {
  blockEdges,
  columnCounts,
  initialsOf,
  interiorGaps,
  pxPerMinute,
  ruleMarks,
  COL_MIN_PX,
  GUTTER_PX,
  GUTTER_PX_SM,
  HEADER_PX,
  OFF_LABEL_MIN_PX,
  type DiaryAppointment,
  type InteriorGap,
  type Zoom,
} from "./diary-view";
import { AppointmentBlock } from "./appointment-block";
import { DiaryEntryBlock } from "./diary-entry-block";
import { truncateRefusal } from "./move-copy";

// ---------------------------------------------------------------------------
// The grid: time down the page, one column across per clinician (or, in the
// multiday and week views, per day). Every view shares this component so the
// geometry, the rules, the rounding and the sticky chrome can only ever be right
// or wrong once. Two copies of the placement code is how an appointment ends up
// drawn at the wrong time.
//
// GREY MEANS OFF. Every column body starts at --diary-off and WORKING TIME IS
// PAINTED ONTO IT in white, never the reverse. A clinician can therefore only
// ever read as available because something positively said so. Three textures,
// three claims, and they must never collapse into two:
//
//   WHITE = we asked, and they are working.
//   GREY  = we asked, and they are not.
//   HATCH = we did not get an answer.
//
// Construction notes that are load-bearing rather than stylistic:
//
//   - ONE element owns both scroll axes at lg and above. Below lg the page
//     scrolls vertically and the diary shows a single column, because per CSS
//     Overflow 3 a container cannot have page-scrolled vertical, container-
//     scrolled horizontal and vertically sticky headers at the same time.
//   - Every sticky cell sets an opaque bg-card, or scrolled content shows through.
//   - The rules are drawn per BODY CELL rather than as one overlay across the
//     grid, and they sit FIRST in the DOM so blocks paint over them.
//   - THREE rule weights, at 5, 30 and 60 minutes. An earlier note here said the
//     neutral ramp had no usable third level; that was true of a DARKER third
//     level, and this one is LIGHTER (color-mix against --line), which the ramp
//     does support. The 5 minute rules are suppressed at compact, where 8px
//     between them is moire.
//   - The time gutter runs down BOTH edges, as the reference's does.
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
  // reads "Nothing booked", "Not working", "Hours not loaded" or "Not loaded"
  // under exactly the right conditions, and a body label repeated a few pixels
  // below it read as a bug. The header is also the better of the two to keep: it
  // is sticky, so it survives scrolling, whereas a label pinned to the top of the
  // body does not.
  /** Named in every block's accessible sentence. */
  clinicianName: string | null;
  /** Week and multiday only: the now-line inside this column, in px from the top. */
  nowTop?: number | null;
  /** What this column may honestly claim about the clinician's day. */
  workState: ColumnWorkState;
  /** The white sessions: availability windows UNION this clinician's own bookings. */
  workingSpans: readonly Span[];
  /** Breaks and notes, drawn BENEATH the appointments in their own list. */
  entries: DiaryEntryRecord[];
  /** Dentally patient id -> funding code. An absent id draws no rail and no word. */
  funding?: Record<string, FundingCode>;
  onOpenEntry?: (entry: DiaryEntryRecord) => void;
}

/** What the grid needs in order to be a drop target. Absent on a read-only diary. */
export interface GridDrag {
  enabled: boolean;
  draggingId: string | null;
  pending: Map<string, { status: "saving" | "saved" | "failed" | "held" | "unknown" }>;
  preview: {
    columnKey: string;
    startMin: number;
    endMin: number;
    valid: boolean;
    message: string | null;
  } | null;
  registerColumn: (key: string, el: HTMLElement | null) => void;
  onBlockPointerDown: (event: React.PointerEvent, appt: DiaryAppointment, columnKey: string) => void;
  swallowClick: () => boolean;
}

/** The hatch that says "we did not get an answer": never grey and never white.
 *  Pitch 6/8, deliberately distinct from the did-not-attend hatch at 5/7. */
const HOURS_UNKNOWN_HATCH =
  "repeating-linear-gradient(45deg, var(--card-muted) 0 6px, var(--line) 6px 8px)";

/**
 * The current-time chip, drawn in BOTH gutters.
 *
 * aria-hidden, because the current time is already announced by the board's own
 * status region; unhiding it would make a screen reader read "09:25" twice, once
 * per gutter. The caller supplies left or right, and nothing else varies.
 */
const NOW_CHIP =
  "pointer-events-none absolute z-[4] -translate-y-1/2 rounded-[3px] bg-navy px-1 text-[10px] font-semibold leading-[1.4] tabular-nums text-white";

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
  drag,
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
  drag?: GridDrag;
}) {
  const ppm = pxPerMinute(zoom);
  const dayHeight = Math.round((bounds.endMin - bounds.startMin) * ppm);

  // Three DISJOINT sets, computed once: a 30 is never also emitted as a 5 and a
  // 60 never also as a 30, so two rules of different weights can never land on
  // the same pixel and leave a half hour looking like a hairline.
  const { fives, halves, hours } = useMemo(() => ruleMarks(bounds, zoom), [bounds, zoom]);

  const topOf = (min: number) => blockEdges(min, min, bounds.startMin, zoom).top;

  // The rules and the now-line are drawn INSIDE each body cell rather than as one
  // overlay across the grid. An absolutely positioned child of the grid is sized
  // to the grid's own box, which is only the VISIBLE width once thirteen columns
  // overflow it, so an overlay would stop dead at the viewport edge and leave the
  // scrolled-to columns unruled and uncrossed by the now-line.
  const rules = (
    <>
      {fives.map((m) => (
        <div
          key={`f-${m}`}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t"
          style={{ top: topOf(m), borderColor: "color-mix(in oklab, var(--line) 45%, transparent)" }}
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
      {hours.map((m) => (
        <div
          key={`h-${m}`}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-line-strong"
          style={{ top: topOf(m) }}
        />
      ))}
    </>
  );

  // Both gutters carry the same labels: hours always, half hours as the two
  // digits "30" at normal and roomy only, exactly as the reference prints them.
  const gutterLabels = (side: "left" | "right") => (
    <>
      {hours.map((m) => (
        <span
          key={`gl-${side}-${m}`}
          className={cn(
            "absolute inset-x-0 -translate-y-[0.5em] text-[11px] font-medium tabular-nums text-muted",
            side === "left" ? "pr-2 text-right" : "pl-2 text-left",
          )}
          style={{ top: topOf(m) }}
        >
          {labelMinutes(m)}
        </span>
      ))}
      {zoom === "compact"
        ? null
        : halves.map((m) => (
            <span
              key={`gh-${side}-${m}`}
              className={cn(
                "absolute inset-x-0 -translate-y-[0.5em] text-[9px] font-normal tabular-nums text-faint",
                side === "left" ? "pr-2 text-right" : "pl-2 text-left",
              )}
              style={{ top: topOf(m) }}
            >
              30
            </span>
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
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Home End Enter Escape T D W S M R N [ ]"
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
              // A trailing gutter at BOTH ends, as the reference has. GUTTER_PX
              // and GUTTER_PX_SM are reused rather than duplicated.
              "--diary-cols-sm": `${GUTTER_PX_SM}px minmax(0, 1fr) ${GUTTER_PX_SM}px`,
              // repeat() requires an integer of at least 1: repeat(0, ...) is
              // invalid at computed-value time and takes the WHOLE declaration
              // down to `none`, leaving a bare time gutter with no explanation.
              // Zero columns is a real state (a site with no clinicians and
              // nothing booked), so the floor is structural, not defensive.
              "--diary-cols": `${GUTTER_PX}px repeat(${Math.max(1, columns.length)}, minmax(${COL_MIN_PX}px, 1fr)) ${GUTTER_PX}px`,
              gridTemplateRows: `${HEADER_PX}px ${dayHeight}px`,
            } as React.CSSProperties
          }
        >
          {/* Header row. Every sticky cell sets an opaque bg-card, or scrolled
              content shows through it. A matching spacer at each end. */}
          <div className="sticky left-0 top-14 z-[3] border-b border-line-strong bg-card lg:top-0" />
          {columns.map((col) => (
            <div
              key={`head-${col.key}`}
              className={cn(
                "sticky top-14 z-[1] border-b border-line-strong border-l border-line-strong bg-card lg:top-0 lg:z-[2]",
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
          <div className="sticky right-0 top-14 z-[3] border-b border-line-strong border-l border-line-strong bg-card lg:top-0" />

          {/* Body row: the sticky left gutter, one positioned cell per column,
              then the sticky right gutter. */}
          <div
            className="sticky left-0 z-[1] border-r border-line-strong bg-card"
            style={{ height: dayHeight }}
          >
            <div className="relative h-full">
              {rules}
              {gutterLabels("left")}
              {nowRule}
              {nowTop === null ? null : (
                <span aria-hidden className={NOW_CHIP} style={{ top: nowTop, left: 2 }}>
                  {nowLabel}
                </span>
              )}
            </div>
          </div>

          {columns.map((col, colIndex) => (
            <div
              key={`body-${col.key}`}
              // The drop target, and the box whose own rect top is the drawn zero
              // of the time axis. The pointer resolves the target clinician from
              // this attribute, NEVER from x divided by a column width: columns
              // are minmax(112px, 1fr) and have no fixed pitch.
              data-diary-col={col.key}
              ref={(el) => {
                drag?.registerColumn(col.key, el);
              }}
              className={cn(
                "relative border-l border-line-strong",
                col.key === mobileKey ? "block" : "hidden lg:block",
              )}
              style={{
                height: dayHeight,
                // GREY IS THE DEFAULT and white is painted onto it. A failed read
                // is NEVER grey: grey is a positive claim that a clinician is off,
                // and a failed read turning the practice grey on a busy Monday
                // would send a receptionist ringing patients to cancel.
                // "unconfirmed" hatches for the same reason "unknown" does: we do
                // not have an answer we can stand behind. Grey would claim they
                // are off and white would offer another practice's free time as
                // this one's capacity.
                background:
                  col.workState === "unknown" || col.workState === "unconfirmed"
                    ? undefined
                    : "var(--diary-off)",
                backgroundImage:
                  col.workState === "unknown" || col.workState === "unconfirmed"
                    ? HOURS_UNKNOWN_HATCH
                    : undefined,
              }}
            >
              {/* WORKING AND FREE: white, painted per session, with a hard 1px rule
                  at each grey/white boundary so a session edge is an edge and not a
                  fade. Nothing is drawn for "off" or "unknown". */}
              {col.workState === "working"
                ? col.workingSpans.map((s) => {
                    const edges = blockEdges(
                      Math.max(s.startMin, bounds.startMin),
                      Math.min(s.endMin, bounds.endMin),
                      bounds.startMin,
                      zoom,
                    );
                    if (edges.height <= 0) return null;
                    return (
                      <span
                        key={`work-${s.startMin}-${s.endMin}`}
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 border-y border-line-strong bg-card"
                        style={{ top: edges.top, height: edges.height }}
                      />
                    );
                  })
                : null}

              {/* A large grey field must never be mistaken for a rendering
                  failure, so it says the word. Only spans tall enough to carry it. */}
              {col.workState === "off" || col.workState === "working"
                ? offSpans(col.workingSpans, bounds).map((s) => {
                    const edges = blockEdges(s.startMin, s.endMin, bounds.startMin, zoom);
                    if (edges.height < OFF_LABEL_MIN_PX) return null;
                    return (
                      <span
                        key={`off-${s.startMin}-${s.endMin}`}
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 flex items-center justify-center text-[9px] font-medium text-muted"
                        style={{ top: edges.top, height: edges.height }}
                      >
                        Off
                      </span>
                    );
                  })
                : null}

              {rules}

              {/* The one quantified statement about empty time: a gap bounded on
                  BOTH sides by a drawn block. No fill, no frame, no hover, no
                  click, and pointer-events-none, because it sits over exactly the
                  empty slots staff aim at. */}
              {col.gaps.map((gap) => (
                <span
                  key={`gap-${gap.top}`}
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 flex cursor-default items-center justify-center text-[10px] font-medium tabular-nums text-muted"
                  style={{ top: gap.top, height: gap.height }}
                >
                  {gap.minutes}m
                </span>
              ))}

              {/* Breaks and notes: a SEPARATE list, BEFORE the appointments in DOM
                  order, so an appointment always wins the z-order and a break can
                  never hide a patient. That structural separation is the one
                  difference that survives a CSS regression. */}
              {col.entries.length > 0 ? (
                <ul aria-label="Breaks and notes" className="absolute inset-0">
                  {col.entries.map((entry) => (
                    <DiaryEntryBlock
                      key={entry.id}
                      entry={entry}
                      boundsStartMin={bounds.startMin}
                      boundsEndMin={bounds.endMin}
                      zoom={zoom}
                      clinicianName={col.clinicianName}
                      onOpen={col.onOpenEntry}
                    />
                  ))}
                </ul>
              ) : null}

              <ul aria-labelledby={col.headerId} className="absolute inset-0">
                {col.placed.map((placed) => (
                  <AppointmentBlock
                    key={placed.item.id}
                    placed={placed}
                    boundsStartMin={bounds.startMin}
                    boundsEndMin={bounds.endMin}
                    zoom={zoom}
                    clinicianName={col.clinicianName}
                    columnKey={col.key}
                    funding={col.funding?.[placed.item.patientId] ?? "unknown"}
                    focused={focusedId === placed.item.id}
                    drag={
                      drag
                        ? {
                            enabled: drag.enabled,
                            lifted: drag.draggingId === placed.item.id,
                            status: drag.pending.get(placed.item.id)?.status ?? null,
                            onPointerDown: drag.onBlockPointerDown,
                            swallowClick: drag.swallowClick,
                          }
                        : undefined
                    }
                    onOpen={onOpen}
                    onFocus={() => onFocusItem(colIndex, placed.item)}
                  />
                ))}
              </ul>

              {/* THE DRAG PREVIEW: a FULL-WIDTH overlay in its own aria-hidden
                  list, deliberately EXCLUDED from layoutColumn. Re-laning the
                  cluster on every frame would make the dragged block and its
                  neighbours jump between full and half width, lose their degrade
                  tier and flicker the clash seam, all under the pointer. Lanes
                  settle only on commit. */}
              {drag?.preview && drag.preview.columnKey === col.key ? (
                <ul aria-hidden className="pointer-events-none absolute inset-0 z-[5]">
                  <li
                    className="absolute inset-x-[1px] overflow-hidden rounded-[4px]"
                    style={{
                      ...blockEdges(
                        Math.max(drag.preview.startMin, bounds.startMin),
                        Math.min(drag.preview.endMin, bounds.endMin),
                        bounds.startMin,
                        zoom,
                      ),
                      background: "var(--card)",
                      outline: drag.preview.valid
                        ? "2px solid var(--navy)"
                        : "2px dashed var(--danger)",
                      // Drawn INSET, the same technique the focus ring uses,
                      // because an outward ring is clipped inside overflow:auto.
                      outlineOffset: -2,
                    }}
                  >
                    {/* Red is transient here and ALWAYS paired with words: red
                        already means did-not-attend on this grid. The FULL
                        sentence goes to the live region. */}
                    <span
                      className="absolute left-[2px] top-[2px] max-w-[calc(100%-4px)] truncate rounded-[3px] px-1 text-[10px] font-semibold leading-[1.4] tabular-nums text-white"
                      style={{
                        background: drag.preview.valid ? "var(--navy)" : "var(--danger)",
                      }}
                    >
                      {drag.preview.valid
                        ? labelMinutes(drag.preview.startMin)
                        : truncateRefusal(drag.preview.message ?? "Not possible")}
                    </span>
                  </li>
                </ul>
              ) : null}

              {/* Day view crosses every column; the day-per-column views draw the
                  line inside today's column only. */}
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

          <div
            className="sticky right-0 z-[1] border-l border-line-strong bg-card"
            style={{ height: dayHeight }}
          >
            <div className="relative h-full">
              {rules}
              {gutterLabels("right")}
              {nowRule}
              {nowTop === null ? null : (
                <span aria-hidden className={NOW_CHIP} style={{ top: nowTop, right: 2 }}>
                  {nowLabel}
                </span>
              )}
            </div>
          </div>
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
  /** From columnWorkState: what this column may honestly claim. */
  workState: ColumnWorkState;
  /** The white sessions: availability UNION this clinician's own bookings. */
  workingSpans: Span[];
  entries: DiaryEntryRecord[];
}

export function DiaryDay({
  columns,
  bounds,
  zoom,
  ariaLabel,
  soloKey,
  onSolo,
  countsUnavailable,
  funding,
  hoursPending = false,
  nowTop,
  nowLabel,
  focusedId,
  onFocusItem,
  onOpen,
  onOpenEntry,
  onKeyDown,
  describedById,
  drag,
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
  /** Dentally patient id -> funding code. Empty when the funding read failed, in
   *  which case NO block anywhere draws a rail and the board says so in words. */
  funding: Record<string, FundingCode>;
  /** True while the availability read for these days is still in flight.
   *
   *  The TEXTURE is the same as a failure (the hatch: we do not have an answer),
   *  because painting grey or white before Dentally has answered would be a claim
   *  we cannot support. The WORDS are different, because "Hours not loaded"
   *  flashing on every day change is a false alarm, and an alarm a receptionist
   *  learns to ignore is worse than none. */
  hoursPending?: boolean;
  nowTop: number | null;
  nowLabel: string | null;
  focusedId: string | null;
  onFocusItem: (colIndex: number, appt: DiaryAppointment) => void;
  onOpen: (appt: DiaryAppointment) => void;
  onOpenEntry?: (entry: DiaryEntryRecord) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  describedById: string;
  drag?: GridDrag;
}) {
  const grid: GridColumn[] = useMemo(
    () =>
      columns.map((col) => {
        const placed = layoutColumn(col.appointments);
        // The header's second line, and the three claims it may make.
        // "Hours not loaded" is a DIFFERENT sentence from "Not working": the first
        // says we could not find out, the second says we asked and they are off.
        // Collapsing them is the confident empty this whole design refuses.
        const summary = countsUnavailable
          ? "Not loaded"
          : col.workState === "unknown"
            ? hoursPending
              ? "Reading hours"
              : "Hours not loaded"
            : col.workState === "unconfirmed"
              ? // NOT "Not working". They may well be working, at another of these
                // practices, and their availability carries no site to tell us.
                "Not confirmed here"
              : col.workState === "off"
                ? "Not working"
                : columnCounts(col.appointments);
        // A pending read is quiet; a failed one is loud. Only one of the two is a
        // problem the reader has to do something about.
        const loud =
          countsUnavailable ||
          (col.workState === "unknown" && !hoursPending) ||
          col.workState === "unconfirmed";
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
                  loud
                    ? "font-semibold text-ink"
                    : col.workState === "off"
                      ? "font-semibold text-muted"
                      : "font-medium text-muted",
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
          // The gap label is a claim about BOOKABLE time, so it is cut to the
          // clinician's actual sessions and around their breaks, and it is not
          // drawn at all unless the column can honestly claim to be working.
          gaps:
            countsUnavailable || col.workState !== "working"
              ? []
              : interiorGaps(
                  placed,
                  bounds.startMin,
                  bounds.endMin,
                  zoom,
                  col.workingSpans,
                  occupyingEntries(col.entries, col.id).map((e) => ({
                    startMin: e.startMin,
                    endMin: e.endMin,
                  })),
                ),
          clinicianName: col.name,
          workState: col.workState,
          workingSpans: col.workingSpans,
          entries: col.entries,
          funding,
          onOpenEntry,
        };
      }),
    [
      columns,
      bounds.startMin,
      bounds.endMin,
      zoom,
      soloKey,
      onSolo,
      countsUnavailable,
      funding,
      hoursPending,
      onOpenEntry,
    ],
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
      drag={drag}
    />
  );
}
