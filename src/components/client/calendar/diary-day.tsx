"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { FundingCode } from "@/lib/calendar/funding";
import { occupyingEntries, type DiaryEntryRecord } from "@/lib/calendar/entries";
import {
  columnHatchIsQuiet,
  columnIsHatched,
  columnIsLoud,
  columnWorkSummary,
  offSpans,
  type ColumnWorkContext,
  type ColumnWorkState,
  type Span,
} from "@/lib/calendar/working-spans";
import { capacityLine, capacitySentence, columnCapacity } from "@/lib/calendar/capacity";
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
import type { PreviewState } from "./use-diary-move";

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
  /**
   * The London wall-minute this day's availability answer begins at, 0 for a day
   * asked about in full. On today's column it is roughly `now`, and the hours
   * ABOVE it were never asked about: they are hatched rather than labelled "Off".
   */
  answerableFromMin?: number;
  /**
   * What the column may say, beyond its state: the reading rather than the
   * claim. See ColumnWorkContext. Carries `askableMinutesRemaining`, which is
   * what turns thirteen columns each repeating "Hours not reportable" at seven
   * in the evening back into thirteen columns of counts.
   */
  workContext?: ColumnWorkContext;
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
  // The SHARED type, not a copy of its fields. A hand-copied duplicate here is
  // how the ghost silently kept rendering a blank white box after the hook had
  // already started sending it the block's colour and name.
  preview: PreviewState | null;
  registerColumn: (key: string, el: HTMLElement | null) => void;
  onBlockPointerDown: (event: React.PointerEvent, appt: DiaryAppointment, columnKey: string) => void;
  swallowClick: () => boolean;
}

/** The hatch that says "we did not get an answer": never grey and never white.
 *  Pitch 6/8, deliberately distinct from the did-not-attend hatch at 5/7. */
const HOURS_UNKNOWN_HATCH =
  "repeating-linear-gradient(45deg, var(--card-muted) 0 6px, var(--line) 6px 8px)";

/**
 * The SAME hatch at half volume, for the one case where the answer is missing
 * and nobody can do anything about it: a day that has run out.
 *
 * Same pitch and same angle, so it is recognisably the same texture and means
 * the same thing; a paler stripe on a lighter ground, so a whole grid of it at
 * seven in the evening reads as a day that is over rather than as a screen full
 * of warnings. See COLUMN_WORK_ELAPSED_DAY.
 */
const HOURS_ELAPSED_HATCH =
  "repeating-linear-gradient(45deg, var(--card) 0 6px, var(--card-muted) 6px 8px)";

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
  const { quarters, halves, hours } = useMemo(() => ruleMarks(bounds), [bounds]);

  const topOf = (min: number) => blockEdges(min, min, bounds.startMin, zoom).top;

  // The rules and the now-line are drawn INSIDE each body cell rather than as one
  // overlay across the grid. An absolutely positioned child of the grid is sized
  // to the grid's own box, which is only the VISIBLE width once thirteen columns
  // overflow it, so an overlay would stop dead at the viewport edge and leave the
  // scrolled-to columns unruled and uncrossed by the now-line.
  const rules = (
    <>
      {/* THE SLOT RULE: every quarter hour, DASHED, exactly as the reference
          draws it. It was a solid hairline every five minutes, which at Normal
          is a line every twelve pixels — a grey wash rather than a grid, and the
          single loudest thing on the screen beside Dentally's own diary. */}
      {quarters.map((m) => (
        <div
          key={`q-${m}`}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-dashed"
          style={{ top: topOf(m), borderColor: "color-mix(in oklab, var(--line) 80%, transparent)" }}
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
                // "unconfirmed" and "past" hatch for the same reason "unknown"
                // does: we do not have an answer we can stand behind. Grey would
                // claim they are off -- on a past day, a claim about a day we
                // were never able to ask about -- and white would offer another
                // practice's free time as this one's capacity.
                background: columnIsHatched(col.workState, col.workContext)
                  ? undefined
                  : "var(--diary-off)",
                backgroundImage: columnIsHatched(col.workState, col.workContext)
                  ? columnHatchIsQuiet(col.workState, col.workContext)
                    ? HOURS_ELAPSED_HATCH
                    : HOURS_UNKNOWN_HATCH
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
                  failure, so it says the word. Only spans tall enough to carry it.

                  BUT "OFF" IS A CLAIM, and it may only be made about hours that
                  were actually asked about. Dentally answers availability from
                  `now` forward, so on TODAY'S column everything above
                  answerableFromMin went unasked: that stretch takes the same
                  hatch a wholly unanswerable column takes, and no word at all.
                  On every other day the cut is 0, this is the single span it has
                  always been, and nothing changes. */}
              {col.workState === "off" || col.workState === "working"
                ? offSpans(col.workingSpans, bounds).flatMap((s) => {
                    const cut = Math.min(
                      Math.max(col.answerableFromMin ?? 0, s.startMin),
                      s.endMin,
                    );
                    const unasked = blockEdges(s.startMin, cut, bounds.startMin, zoom);
                    const asked = blockEdges(cut, s.endMin, bounds.startMin, zoom);
                    return [
                      unasked.height > 0 ? (
                        <span
                          key={`unasked-${s.startMin}-${cut}`}
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0"
                          style={{
                            top: unasked.top,
                            height: unasked.height,
                            backgroundImage: HOURS_UNKNOWN_HATCH,
                          }}
                        />
                      ) : null,
                      asked.height >= OFF_LABEL_MIN_PX ? (
                        <span
                          key={`off-${cut}-${s.endMin}`}
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0 flex items-center justify-center text-[9px] font-medium text-muted"
                          style={{ top: asked.top, height: asked.height }}
                        >
                          Off
                        </span>
                      ) : null,
                    ];
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
                      // The ghost wears the block's OWN treatment colour, not a
                      // blank white box. Seeing where it will land is only half
                      // the question; the mistake worth preventing is dropping
                      // the wrong patient, and that is answered by the fill and
                      // the name, not by the outline.
                      background: `var(--type-${drag.preview.paletteSlot}-fill)`,
                      outline: drag.preview.valid
                        ? "2px solid var(--navy)"
                        : "2px dashed var(--danger)",
                      // Drawn INSET, the same technique the focus ring uses,
                      // because an outward ring is clipped inside overflow:auto.
                      outlineOffset: -2,
                    }}
                  >
                    {/* Line one of the real block, so the ghost is identifiable
                        at a glance. Pushed clear of the time chip above it. */}
                    <span
                      className="absolute inset-x-[3px] top-[19px] truncate text-[10px] font-semibold leading-[1.15]"
                      style={{ color: `var(--type-${drag.preview.paletteSlot}-ink)` }}
                    >
                      {drag.preview.lead}
                    </span>
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
  /** The London wall-minute this day's hours could be asked about from. See GridColumn. */
  answerableFromMin?: number;
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
  dayCloseMin,
  drag,
}: {
  columns: DayColumnInput[];
  bounds: { startMin: number; endMin: number };
  zoom: Zoom;
  ariaLabel: string;
  /**
   * The practice's own closing wall-minute for the day on screen.
   *
   * Given so the grid can tell an afternoon partial read (the morning is
   * missing, the afternoon is still askable, and each column says so because a
   * receptionist can act on it) from a day that has simply RUN OUT, where every
   * column would otherwise repeat the same caveat about hours nobody can ask
   * about any more. Derived entirely from the site's opening hours, which the
   * board already holds: no server shape changes for this.
   *
   * Undefined leaves every column exactly as it was.
   */
  dayCloseMin?: number;
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
        // HOW MUCH OF THE PRACTICE'S DAY IS STILL ASKABLE. Zero means the day has
        // run out, and a caveat about hours nobody can ask about any more stops
        // being per-column news. Derived here from two numbers the grid already
        // holds; the RULE it feeds lives in working-spans beside the union, so
        // this grid and the week grid cannot come to different conclusions.
        const workContext: ColumnWorkContext = {
          hoursPending,
          askableMinutesRemaining:
            dayCloseMin === undefined
              ? undefined
              : Math.max(0, dayCloseMin - (col.answerableFromMin ?? 0)),
        };
        // The header's second line. The words for a WORK STATE are not chosen
        // here: every one of them comes from COLUMN_WORK_PRESENTATION, the single
        // exhaustive mapping in the module that owns the union, so this grid and
        // the week grid cannot word the same state differently and a state added
        // to the union cannot fall out of the bottom of a ternary chain and land
        // silently on "Not working". null means the state has nothing to say and
        // the counts are the better sentence. "Not loaded" stays here because it
        // is not a work state at all: it is this screen's failed read.
        const summary = countsUnavailable
          ? "Not loaded"
          : (columnWorkSummary(col.workState, workContext) ?? columnCounts(col.appointments));
        // WHICH STATES SHOUT is not decided here either, for the same reason the
        // words are not: it was an or-chain in this file and a byte-identical one
        // in the week grid, and a chain over six states cannot be made to fail when
        // a seventh is added -- it just renders quiet. COLUMN_WORK_PRESENTATION
        // carries the loudness now, exhaustively, beside each state's words.
        //
        // `countsUnavailable` stays HERE because it is not a work state at all: it
        // is THIS screen's own failed read, and the clinician's day may be perfectly
        // well known behind it.
        const loud = countsUnavailable || columnIsLoud(col.workState, workContext);
        const soloed = soloKey === col.key;

        // WHITE SPACE, AS A NUMBER. Computed from exactly the spans drawn above
        // it: the same white sessions, the same occupying blocks, the same
        // breaks. Only a column that can honestly claim to be working gets one,
        // so a hatched or grey column prints no figure rather than a confident
        // zero. See capacity.ts.
        const capacity =
          countsUnavailable || col.workState !== "working"
            ? null
            : columnCapacity({
                working: col.workingSpans,
                // cancelled and did-not-attend do NOT consume the clinician's
                // time, exactly as the drop validator has it: a cancelled slot is
                // free, and the grid already draws it white and dashed.
                occupied: placed
                  .filter(
                    (p) =>
                      p.item.state !== "cancelled" && p.item.state !== "did_not_attend",
                  )
                  .map((p) => ({ startMin: p.startMin, endMin: p.endMin })),
                breaks: occupyingEntries(col.entries, col.id).map((e) => ({
                  startMin: e.startMin,
                  endMin: e.endMin,
                })),
                // Spread rather than passed by reference, so this memo's
                // dependency list stays the two primitives it already tracks.
                bounds: { startMin: bounds.startMin, endMin: bounds.endMin },
              });
        const capLine = capacityLine(capacity);
        const capSentence = capacitySentence(col.name, capacity);

        return {
          key: col.key,
          headerId: `diary-col-${col.key}`,
          headerLabel: `${col.name}, ${summary}${capSentence ? `. ${capSentence}` : ""}`,
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
              {/* Line three: how much of this clinician's day is still free, and
                  the longest single run of it. Drawn ONLY when the column can
                  honestly claim to be working, so a hatched or off column is
                  silent rather than confidently empty.

                  It is a third line and not an appended clause because the free
                  figure is scanned DOWN the header row — "who has room this
                  afternoon" is answered by reading one column of numbers, which
                  is the sick-clinician question. tabular-nums keeps that column
                  aligned. */}
              {capLine ? (
                <span className="block truncate text-[9.5px] font-semibold leading-[1.2] tabular-nums text-blue-royal">
                  {capLine}
                </span>
              ) : null}
            </>
          ),
          onHeaderClick: () => onSolo(col.key),
          headerPressed: soloed,
          // The capacity sentence goes in the hover title UNTRUNCATED, because
          // the line above it is cut to the column width and the full figures
          // must be readable somewhere without opening anything.
          headerTitle: capSentence
            ? `${capSentence} ${soloed ? "Click to show every clinician." : `Click to show only ${col.name}.`}`
            : soloed
              ? "Show every clinician"
              : `Show only ${col.name}`,
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
          answerableFromMin: col.answerableFromMin,
          workContext,
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
      dayCloseMin,
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
