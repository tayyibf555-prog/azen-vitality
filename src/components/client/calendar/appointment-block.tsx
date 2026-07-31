"use client";

import { Check, Clock } from "lucide-react";
import type { FundingCode } from "@/lib/calendar/funding";
import type { Placed } from "./diary-grid";
import {
  accessibleSentence,
  blockBodyText,
  blockEdges,
  blockLeadLine,
  blockMetaLine,
  blockStyle,
  blockTier,
  bodyLineCount,
  shortPatientName,
  stateGlyph,
  BLOCK_PAD_Y,
  type BlockTier,
  type DiaryAppointment,
  type Zoom,
} from "./diary-view";
import { RESIZE_HANDLE_MIN_BLOCK_PX } from "./diary-drag";
import { paletteSlotFor } from "./treatment-type";
import { stateLabel } from "./calendar-logic";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// One appointment on the grid.
//
// THE FILL IS THE TREATMENT TYPE, not the state. That is what the practice's own
// Dentally screen does: two "Scale & Polish" bookings with different state
// letters share one salmon fill, while "Scale & Polish Extensive Hygiene" is
// lavender. State keeps four channels of its own, none of them hue: the 3px left
// spine, the corner letter, the border weight, and the non-hue treatments
// (cancelled dashed, did-not-attend hatched, completed at 55%).
//
// FUNDING is a 3px vertical rail immediately inboard of that spine, in the
// blue-for-NHS and orange-for-private the practice was trained on. Unresolvable
// funding draws NO RAIL AND NO WORD - never a guessed "private".
//
// THE DRAG CONTRACT. The block can now be moved, reassigned and resized, and the
// affordance appears ONLY for a role the server will actually accept
// (PATIENT_ADMIN_ROLES, imported by both sides so they cannot drift) and only
// while the site's working hours and breaks were genuinely read. Dragging the
// body moves the appointment and, across columns, reassigns it; dragging the
// bottom 8px strip changes its length. Nothing is written by the gesture: a drop
// opens a centred confirmation, and an illegal drop never reaches it. The
// keyboard equivalent is M to move and R to resize, and it is the PRIMARY path
// below lg, where only one column is drawn and a pointer cannot cross clinicians.
//
// APPOINTMENT UPDATE HAS NEVER BEEN PROVEN AGAINST LIVE DENTALLY. createAppointment
// has; PUT /v1/appointments/:id has not. That is why every move is confirmed by
// reading it back, and why a block that did not save returns to where it was and
// says so rather than sitting quietly at its new time.
//
// The drag states all use NON-HUE channels (opacity, outline, a moving bar),
// because the fill is the treatment type and the spine is the appointment state,
// and a drag state that borrowed either would be a mis-signalled clinical state.
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

function Glyph({ state, size = 10 }: { state: string; size?: number }) {
  const glyph = stateGlyph(state);
  if (!glyph) return null;
  if (glyph.kind === "clock") return <Clock size={size} strokeWidth={2.5} />;
  if (glyph.kind === "check") return <Check size={size} strokeWidth={3} />;
  return null;
}

/** The 3px rail colour for a resolved funding code, or null when there is none. */
function fundingRailVar(funding: FundingCode): string | null {
  if (funding === "nhs") return "var(--fund-nhs)";
  if (funding === "private") return "var(--fund-private)";
  if (funding === "udc") return "var(--fund-udc)";
  return null;
}

/** What the block needs to know about moving. Absent entirely on a read-only diary. */
export interface BlockDrag {
  /** Role-gated and read-gated. False means no cursor, no handle, no listener. */
  enabled: boolean;
  /** This block is the SOURCE of an active gesture: it stays where it was, faded. */
  lifted: boolean;
  /** Where an optimistic move has got to. Null when nothing is in flight. */
  status: "saving" | "saved" | "failed" | "held" | "unknown" | null;
  onPointerDown: (event: React.PointerEvent, appt: DiaryAppointment, columnKey: string) => void;
  /** True when the gesture that just ended was a drag, so the click must not open the panel. */
  swallowClick: () => boolean;
}

export function AppointmentBlock({
  placed,
  boundsStartMin,
  zoom,
  boundsEndMin,
  clinicianName,
  columnKey,
  funding = "unknown",
  focused,
  drag,
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
  /** The grid column this block is drawn in, so a gesture knows where it started. */
  columnKey: string;
  /** Resolved from the PATIENT's payment plan. "unknown" draws nothing at all. */
  funding?: FundingCode;
  /** The single roving tab stop for the whole grid body. */
  focused: boolean;
  drag?: BlockDrag;
  onOpen: (appt: DiaryAppointment) => void;
  onFocus: () => void;
}) {
  const appt = placed.item;
  // The drawn bottom is clamped to the grid's own bottom edge. dayBounds stops at
  // 24:00, so a booking whose duration runs past London midnight (a bad finish
  // time, or a duration Dentally reports too long) would otherwise draw a block
  // hanging below the diary's bottom border, over the page behind it. The full
  // length is still stated in the title and in the detail panel.
  const drawnEndMin = Math.min(placed.endMin, boundsEndMin);
  const { top, height } = blockEdges(placed.startMin, drawnEndMin, boundsStartMin, zoom);
  const tier: BlockTier = blockTier(height, placed.lanes);
  const style = blockStyle(appt.state);

  const slot = paletteSlotFor(appt.reason);
  const fill = `var(--type-${slot}-fill)`;
  const line = `var(--type-${slot}-line)`;
  const ink = `var(--type-${slot}-ink)`;

  const leadLine = blockLeadLine(appt);
  const bodyText = blockBodyText(appt, funding);
  const sentence = accessibleSentence(appt, clinicianName, placed.lanes, funding);
  const meta = blockMetaLine(appt);
  const title = `${appt.patientName}${meta ? ` · ${meta}` : ""} · ${stateLabel(appt.state)}`;
  const hasNote = Boolean(appt.note);
  const glyph = stateGlyph(appt.state);
  const rail = fundingRailVar(funding);

  // A neighbour to the right means a clash. A double booking reads as a split
  // block with a navy seam down the middle.
  const clashSeam = placed.lane < placed.lanes - 1;

  // The narrow variants: a third of a 112px column is 34px, which cannot carry
  // the reference's 28px clear strip AND wrapped text. The rail narrows rather
  // than disappearing, because funding must not silently drop out on a busy day.
  const narrow = tier === "name" || tier === "bar" || placed.lanes >= 3;
  const railWidth = narrow ? 2 : 3;
  const railLeft = narrow ? 3 : 4;
  const padLeft = narrow ? 8 : 11;
  const padRight = narrow ? 14 : 28;

  const cancelled = appt.state === "cancelled";
  const inSurgery = appt.state === "in_surgery";
  const completed = appt.state === "completed";

  // EXACTLY ONE STATE REPLACES THE TYPE FILL: cancelled, forced to white. It is
  // the only state whose meaning is "this space is available", and availability
  // is now the fill channel's other job. did_not_attend KEEPS its type fill with
  // the hatch over it, because the slot was consumed.
  //
  // completed mixes toward --card rather than using CSS opacity, which would fade
  // the text with the fill and cost the block its legibility as well as its
  // weight.
  const background = cancelled
    ? "var(--card)"
    : completed
      ? `color-mix(in oklab, ${fill} 55%, var(--card))`
      : fill;

  const borderStyle = cancelled ? "dashed" : "solid";
  const borderWidth = inSurgery ? 2 : 1;
  const borderColor = cancelled ? "var(--line-strong)" : inSurgery ? "var(--navy)" : line;

  // The drag states. Every one of them is a NON-HUE channel, because the fill is
  // the treatment type and the spine is the appointment state: a drag state that
  // borrowed either would be a mis-signalled clinical state, which is the safety
  // failure this whole repaint was careful to avoid.
  const status = drag?.status ?? null;
  const saving = status === "saving";
  // A CANCELLED or DID-NOT-ATTEND booking is not draggable. It is not a booking
  // any more: moving it would write a new time into Dentally for an appointment
  // that is not happening and, worse, text the patient that "your appointment has
  // been moved to" it. Re-booking one of these patients is a new appointment, not
  // a drag. The server refuses the same two states independently.
  const movable = appt.state !== "cancelled" && appt.state !== "did_not_attend";
  const dragEnabled = drag?.enabled === true && !saving && movable;
  const showHandle = dragEnabled && height >= RESIZE_HANDLE_MIN_BLOCK_PX;
  const moveOutline =
    saving
      ? "2px solid var(--navy)"
      : status === "failed"
        ? "2px dashed var(--danger)"
        : status === "unknown"
          ? "2px solid var(--status-amber)"
          : undefined;

  return (
    <li
      className="absolute"
      data-diary-block={appt.id}
      onPointerDown={dragEnabled ? (event) => drag?.onPointerDown(event, appt, columnKey) : undefined}
      style={{
        top,
        height,
        left: `calc(${placed.lane} * 100% / ${placed.lanes})`,
        width: `calc(100% / ${placed.lanes})`,
        // The SOURCE of an active gesture stays exactly where it was, faded, so
        // the reader can see what they are moving FROM while the preview shows
        // where it is going.
        opacity: drag?.lifted ? 0.4 : undefined,
        filter: drag?.lifted ? "saturate(0.4)" : undefined,
      }}
    >
      <button
        type="button"
        id={blockDomId(appt.id)}
        tabIndex={focused ? 0 : -1}
        aria-busy={saving || undefined}
        onClick={() => {
          // A gesture that WAS a drag must not also open the detail panel behind
          // the confirmation dialog.
          if (drag?.swallowClick()) return;
          onOpen(appt);
        }}
        onFocus={onFocus}
        title={title}
        className={cn(
          // 1px in on each side, so two lanes show their own edges and the
          // column's own rule stays visible behind the block.
          "pressable absolute inset-y-0 left-[1px] right-[1px] overflow-hidden rounded-[4px] text-left transition-colors",
          "[scroll-margin-top:44px] [scroll-margin-left:52px] [scroll-margin-right:52px]",
          // An outward ring is clipped on a block flush against a column edge
          // inside overflow:auto, so the focus outline is drawn INSET.
          "focus-visible:[outline:2px_solid_var(--navy)] focus-visible:[outline-offset:-2px]",
          dragEnabled && "cursor-grab",
          // No second move may start on a block that is still being saved.
          saving && "pointer-events-none",
        )}
        style={{
          background,
          borderStyle,
          borderWidth,
          borderColor,
          color: ink,
          paddingTop: BLOCK_PAD_Y[tier],
          paddingBottom: BLOCK_PAD_Y[tier],
          paddingLeft: padLeft,
          paddingRight: padRight,
          outline: moveOutline,
          outlineOffset: moveOutline ? -2 : undefined,
        }}
      >
        {/* At the shortest tier no outline is legible, so a saving block ALSO
            prints a line under the command bar. This bar is the on-block half. */}
        {saving ? (
          <span aria-hidden className="diary-saving-bar absolute inset-x-0 top-0 h-[3px] bg-navy" />
        ) : null}
        {/* The 3px state spine. Cancelled is the one state that has none, which is
            itself the strongest glanceable signal on the grid. */}
        {style.spine && !cancelled ? (
          <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", style.spine)} />
        ) : null}

        {/* Funding: a rail, never a fill. Nothing at all when unresolvable, which
            covers all five unresolvable cases identically - no patient id, a 404,
            a timeout, no plan on file, and a real plan outside this practice's
            whitelist. "Private" is never inferred from an absence. */}
        {rail ? (
          <span
            aria-hidden
            className="absolute inset-y-0"
            style={{ left: railLeft, width: railWidth, background: rail }}
          />
        ) : null}

        {/* Did not attend: the hatch is what separates it from a booked block in
            greyscale and on a projector. Pitch 5/7, distinct from the whole-column
            "hours not loaded" hatch, which is 6/8 and a different colour. */}
        {style.hatched ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `repeating-linear-gradient(45deg, transparent 0 5px, ${line} 5px 7px)`,
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
              <span className="shrink-0 text-[9.5px] font-bold leading-none">{glyph.text}</span>
            ) : glyph ? (
              <span className="shrink-0 leading-none">
                <Glyph state={appt.state} size={9} />
              </span>
            ) : null}
            <span
              className={cn(
                "truncate text-[9.5px] font-semibold leading-none",
                cancelled && "line-through",
              )}
            >
              {shortPatientName(appt.patientName)}
            </span>
          </span>
        ) : (
          <span aria-hidden className="relative block h-full overflow-hidden">
            {/* Line 1, always: "09:30 N.Lamprell", exactly the reference's form.
                The FULL name is never lost - it is in the title attribute, the
                accessible sentence and the panel. */}
            <span
              className={cn(
                "block truncate text-[10px] font-semibold leading-[1.15]",
                cancelled && "line-through",
              )}
            >
              {leadLine}
            </span>

            {/* The wrapped body. -webkit-line-clamp stops it on a WHOLE line at a
                count derived from the drawn height, so text FILLS the block the
                way the reference's does and nothing is ever half-drawn. */}
            {tier === "full" && bodyText ? (
              <span
                className="text-[9.5px] font-normal leading-[1.25]"
                style={{
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: bodyLineCount(height),
                  overflow: "hidden",
                  color: `color-mix(in oklab, ${ink} 78%, transparent)`,
                }}
              >
                {bodyText}
              </span>
            ) : null}

            {/* The reference leaves a clear strip down the right edge of every
                block. This is what lives in it. */}
            <span className="absolute right-[3px] top-[2px] flex items-center gap-[3px]">
              {/* The one mark that survives every tier above "bar": something is
                  typed on this booking. At "lead" the note TEXT is not drawn, so
                  the dot is then the only signal it exists. */}
              {hasNote ? (
                <span
                  className="h-[4px] w-[4px] shrink-0 rounded-full"
                  style={{ background: inSurgery ? "var(--navy)" : "currentColor" }}
                />
              ) : null}
              {/* The state letter, on its own square of the type fill at 100%, so
                  it stays legible over wrapped body text running under it.
                  in_surgery inverts it to a navy square behind a white S: it is
                  the one state that should shout, and at most one column is in
                  surgery at any moment. */}
              {glyph ? (
                <span
                  className="flex h-[13px] min-w-[13px] items-center justify-center rounded-[2px] px-[1px] leading-none"
                  style={{
                    background: inSurgery ? "var(--navy)" : cancelled ? "var(--card)" : fill,
                    color: inSurgery ? "#ffffff" : undefined,
                  }}
                >
                  {glyph.kind === "text" ? (
                    <span
                      className={cn(
                        "font-bold leading-none",
                        glyph.text === "DNA" ? "text-[8px]" : "text-[11px]",
                      )}
                    >
                      {glyph.text}
                    </span>
                  ) : (
                    <Glyph state={appt.state} size={10} />
                  )}
                </span>
              ) : null}
            </span>
          </span>
        )}

        <span className="sr-only">{sentence}</span>
      </button>

      {/* The resize strip. The block IS a button, so this cannot be a nested
          button: it is an aria-hidden SIBLING and the pointerdown handler on the
          <li> decides move-or-resize from where the gesture started. It eats the
          button's bottom 8px, which is accepted, and it is not drawn at all on a
          block too short to carry it. */}
      {showHandle ? (
        <span
          aria-hidden
          className="absolute bottom-0 left-[1px] right-[1px] h-[8px] cursor-ns-resize"
        />
      ) : null}
    </li>
  );
}
