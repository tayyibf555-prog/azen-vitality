"use client";

import { Check, Clock } from "lucide-react";
import type { Placed } from "./diary-grid";
import {
  accessibleSentence,
  blockEdges,
  blockMetaLine,
  blockStyle,
  blockTier,
  stateGlyph,
  BLOCK_PAD_Y,
  type DiaryAppointment,
  type Zoom,
} from "./diary-view";
import { stateLabel } from "./calendar-logic";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// One appointment on the grid.
//
// The block is a BUTTON and nothing else: there is no drag handle, no resize
// edge, no cursor change at its edges and no state control. Dentally appointment
// writes are unproven against the live API and patient creation already returns
// 422, so the affordance must not exist even by accident. The detail panel says
// so in words rather than leaving a clinician to discover it by trying.
//
// Everything visible is aria-hidden and the button carries one complete sentence
// instead, so the announcement is identical at every degrade tier, including the
// shortest one where nothing is drawn at all. Find-in-page still works: aria-hidden
// hides from assistive technology, not from the browser's find.
// ---------------------------------------------------------------------------

/** The DOM id a block owns, so the panel can hand focus back to it on close. */
export function blockDomId(appointmentId: string): string {
  return `diary-appt-${appointmentId}`;
}

function Glyph({ state, ink }: { state: string; ink: string }) {
  const glyph = stateGlyph(state);
  if (!glyph) return null;
  if (glyph.kind === "clock") return <Clock size={10} className={ink} strokeWidth={2.5} />;
  if (glyph.kind === "check") return <Check size={10} className={ink} strokeWidth={3} />;
  return <span className={cn("text-[10px] font-bold leading-none", ink)}>{glyph.text}</span>;
}

export function AppointmentBlock({
  placed,
  boundsStartMin,
  zoom,
  boundsEndMin,
  clinicianName,
  focused,
  onOpen,
  onFocus,
}: {
  placed: Placed<DiaryAppointment>;
  boundsStartMin: number;
  /** The grid's own bottom edge. A block is never DRAWN past it. */
  boundsEndMin: number;
  zoom: Zoom;
  /** Always named in the accessible sentence: a half-width block is visually
   *  ambiguous about which column it belongs to. */
  clinicianName: string | null;
  /** The single roving tab stop for the whole grid body. */
  focused: boolean;
  onOpen: (appt: DiaryAppointment) => void;
  onFocus: () => void;
}) {
  const appt = placed.item;
  // The drawn bottom is clamped to the grid's own bottom edge. dayBounds stops at
  // 24:00, so a booking whose duration runs past London midnight (a bad finish
  // time, or a duration Dentally reports too long) would otherwise draw a block
  // hanging below the diary's bottom border, over the page behind it. The full
  // length is still stated on line 2, in the title and in the detail panel.
  const drawnEndMin = Math.min(placed.endMin, boundsEndMin);
  const { top, height } = blockEdges(placed.startMin, drawnEndMin, boundsStartMin, zoom);
  const tier = blockTier(height, placed.lanes);
  const style = blockStyle(appt.state);
  const meta = blockMetaLine(appt);
  const sentence = accessibleSentence(appt, clinicianName, placed.lanes);
  const title = `${appt.patientName}${meta ? ` · ${meta}` : ""} · ${stateLabel(appt.state)}`;
  const hasNote = Boolean(appt.note);
  const glyph = stateGlyph(appt.state);
  // A neighbour to the right means a clash. The right edge is otherwise unused,
  // because the state spine owns the left, so a double booking reads as a split
  // block with a navy seam down the middle.
  const clashSeam = placed.lane < placed.lanes - 1;

  return (
    <li
      className="absolute"
      style={{
        top,
        height,
        left: `calc(${placed.lane} * 100% / ${placed.lanes})`,
        width: `calc(100% / ${placed.lanes})`,
      }}
    >
      <button
        type="button"
        id={blockDomId(appt.id)}
        tabIndex={focused ? 0 : -1}
        onClick={() => onOpen(appt)}
        onFocus={onFocus}
        title={title}
        className={cn(
          // 1px in on each side, so two lanes show their own edges and the
          // column's own rule stays visible behind the block.
          "pressable absolute inset-y-0 left-[1px] right-[1px] overflow-hidden rounded-[4px] border text-left transition-colors",
          "[scroll-margin-top:44px] [scroll-margin-left:52px]",
          // An outward ring is clipped on a block flush against a column edge
          // inside overflow:auto, so the focus outline is drawn INSET.
          "focus-visible:[outline:2px_solid_var(--navy)] focus-visible:[outline-offset:-2px]",
          style.fill,
          style.hairline,
          style.hoverHairline,
        )}
        style={{
          // Vertical padding TIGHTENS as the block shortens (BLOCK_PAD_Y), which
          // is what makes each tier's threshold height actually fit the lines
          // that tier draws. A flat 4px clipped every short block's name.
          paddingTop: BLOCK_PAD_Y[tier],
          paddingRight: 6,
          paddingBottom: BLOCK_PAD_Y[tier],
          paddingLeft: 7,
        }}
      >
        {/* The 3px state spine. Cancelled is the one state that has none, which is
            itself the strongest glanceable signal on the grid. */}
        {style.spine ? (
          <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", style.spine)} />
        ) : null}

        {/* Did not attend: the hatch is what separates it from a booked block in
            greyscale and on a projector. */}
        {style.hatched ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, transparent 0 5px, var(--tint-red-line) 5px 7px)",
            }}
          />
        ) : null}

        {clashSeam ? (
          <span aria-hidden className="absolute inset-y-0 right-0 w-[3px] bg-navy" />
        ) : null}

        {tier === "bar" ? null : tier === "name" ? (
          <span aria-hidden className="relative flex items-center gap-1 overflow-hidden">
            {/* At this height a corner glyph does not fit, and without the letter
                pending and confirmed would be separated by hue alone. */}
            {glyph?.kind === "text" ? (
              <span className={cn("shrink-0 text-[10px] font-semibold leading-none", style.glyphInk)}>
                {glyph.text}
              </span>
            ) : glyph ? (
              <span className="shrink-0 leading-none">
                <Glyph state={appt.state} ink={style.glyphInk} />
              </span>
            ) : null}
            <span className={cn("truncate text-[10px] font-semibold leading-none", style.nameInk)}>
              {appt.patientName}
            </span>
          </span>
        ) : (
          <span aria-hidden className="relative block h-full overflow-hidden">
            <span className={cn("block truncate pr-[18px] text-[12.5px] font-semibold leading-[1.1]", style.nameInk)}>
              {appt.patientName}
            </span>
            {tier === "full" && meta ? (
              <span className={cn("block truncate text-[10px] font-medium leading-[1.2]", style.metaInk)}>
                {meta}
              </span>
            ) : null}
            <span className="absolute right-[3px] top-[2px] flex items-center gap-[3px]">
              {/* The one mark that survives truncation: something is typed on this
                  booking. On a real day that is "needs pre med, check with dentist". */}
              {hasNote ? (
                <span
                  className={cn(
                    "h-[4px] w-[4px] shrink-0 rounded-full",
                    style.solid ? "bg-white" : "bg-navy",
                  )}
                />
              ) : null}
              <span className="flex min-w-[12px] justify-end leading-none">
                {glyph?.text === "DNA" ? (
                  <span className={cn("text-[9px] font-bold leading-none", style.glyphInk)}>DNA</span>
                ) : (
                  <Glyph state={appt.state} ink={style.glyphInk} />
                )}
              </span>
            </span>
          </span>
        )}

        <span className="sr-only">{sentence}</span>
      </button>
    </li>
  );
}
