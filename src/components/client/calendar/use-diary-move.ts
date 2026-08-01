"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { londonInstantMs } from "@/lib/calendar/availability";
import { validateMove, type MoveProposal } from "@/lib/calendar/move-validate";
import type { ColumnWorkState, Span } from "@/lib/calendar/working-spans";
import { effectiveMinutes, labelMinutes, londonMinutes } from "./diary-grid";
import { blockLeadLine, shortPatientName, type DiaryAppointment, type Zoom } from "./diary-view";
import { paletteSlotFor } from "./treatment-type";
import {
  clampToBounds,
  gestureFor,
  isNoopProposal,
  pointerToMinutes,
  proposeMove,
  proposeResize,
  snapDelta,
  DRAG_THRESHOLD_PX,
  SNAP_MIN,
  type DragOrigin,
} from "./diary-drag";
import {
  cancelledAnnouncement,
  moveModeAnnouncement,
  movedAnnouncement,
  notSavedAnnouncement,
  NOT_MOVABLE,
  proposedAnnouncement,
  savingAnnouncement,
  unknownOutcomeSentence,
} from "./move-copy";

// ---------------------------------------------------------------------------
// MOVING AN APPOINTMENT, from the reader's side.
//
// One state machine for BOTH input paths. The pointer reducer and the keyboard
// reducer both end by calling setProposal, and the confirmation dialog renders
// off that single piece of state, so there is exactly one dialog and exactly one
// commit function. Two commit paths is two ways of writing the wrong thing.
//
// The keyboard path is PRIMARY, not a fallback. Below lg the grid draws a single
// column, so a pointer drag cannot cross clinicians at all: the arrow keys and
// the dialog's own clinician select are the only way to reassign on a
// laptop-narrow window.
//
// NOTHING IS WRITTEN WITHOUT A CONFIRMATION, and nothing is drawn as moved that
// has not been read back and confirmed. A move that failed snaps back and says
// so; a move we could not verify neither commits nor snaps back, because
// snapping back would assert something we do not know.
// ---------------------------------------------------------------------------

/** cancelled and did_not_attend are not bookings and cannot be moved. */
export function isMovableState(state: string): boolean {
  return state !== "cancelled" && state !== "did_not_attend";
}

/** How long a failed block keeps its dashed danger outline before it is cleared. */
const FAILED_LINGER_MS = 6_000;
/** How long the Undo affordance stays offered after a confirmed move. */
export const UNDO_WINDOW_MS = 30_000;

export interface MoveColumn {
  /** The grid's own column key: a practitioner id, the unassigned sentinel, or a day key. */
  key: string;
  /** null is Unassigned, which is not a person and can never be a target. */
  practitionerId: string | null;
  name: string;
  dayKey: string;
  workState: ColumnWorkState;
  workingSpans: readonly Span[];
  /** Spans that CONSUME time. cancelled and did_not_attend are already excluded. */
  occupied: readonly (Span & { appointmentId: string })[];
  /** Breaks only. A note does not block a drop. */
  breaks: readonly Span[];
}

export interface MoveContext {
  siteId: string;
  bounds: Span;
  zoom: Zoom;
  /** The FULL column set, never the soloed subset: soloing must not remove the
   *  only column a keyboard user could move to. */
  columns: MoveColumn[];
  /** True when the reader's role may move an appointment at all. */
  allowed: boolean;
  /** Set when a read failed: moves are refused entirely and this is the sentence. */
  blockedReason: string | null;
  /** True while a panel or dialog is open, so a drag can never start under one. */
  suspended: boolean;
  focusedId: string | null;
  focusedColumnKey: string | null;
  appointmentsById: Map<string, DiaryAppointment>;
}

/**
 * "held" is the honest fifth state: the move was REFUSED before anything was
 * written, so nothing changed, and the entry exists only to say where the
 * appointment actually is. Without it a refusal fell back to the board's server
 * prop, which inside the refresh window after a confirmed move still holds the
 * OLD time: the grid would then draw the appointment where Dentally no longer
 * has it, while the alert named the right place. People act on the grid.
 */
export type PendingStatus = "saving" | "saved" | "failed" | "held" | "unknown";

export interface PendingMove {
  appointmentId: string;
  startTime: string;
  finishTime: string;
  durationMin: number;
  practitionerId: string;
  practitionerName: string;
  dayKey: string;
  status: PendingStatus;
}

export interface MoveEnd {
  dayKey: string;
  startMin: number;
  endMin: number;
  practitionerId: string | null;
  practitionerName: string | null;
}

export interface MoveProposalState {
  appointment: DiaryAppointment;
  from: MoveEnd;
  to: MoveEnd;
  /**
   * True when this came from the reschedule suggestions rather than a drag.
   *
   * Those slots may sit on a day the grid is not currently drawing, so there is
   * no local column to re-validate against and the client check is skipped. It is
   * not a hole: the slots were computed SERVER side against real availability,
   * real bookings and real breaks, and the write route re-runs all six checks
   * against inputs it fetches itself before anything is written.
   */
  fromSuggestion?: boolean;
  /**
   * Set when this proposal is the REVERSE of a saved move. It is carried through
   * to the write so the audit row links the two, and it is why undo now opens
   * this same dialog rather than committing straight away.
   */
  undoOf?: string | null;
}

export interface PreviewState {
  columnKey: string;
  startMin: number;
  endMin: number;
  valid: boolean;
  message: string | null;
  /**
   * The identity of the block being moved, so the preview LOOKS LIKE IT.
   *
   * It used to be a plain white box with a time chip, which the owner reported as
   * "the box being dragged just turns white": you could see where it would land
   * but not what you were landing there. On a diary that is the wrong half of the
   * information, because the mistake to avoid is dropping the WRONG patient.
   */
  paletteSlot: number;
  /** Line one of the block, e.g. "09:30 I.Moreau". */
  lead: string;
}

export interface LastMove {
  appointmentId: string;
  patientShort: string;
  moveId: string | null;
  from: MoveEnd;
  to: MoveEnd;
  at: number;
  /** What actually happened to the patient's text, read back rather than assumed. */
  notify: { queued: boolean; reason: string | null } | null;
}

/** The instant a London wall-clock minute on a given day corresponds to. */
export function isoFromDayMinutes(dayKey: string, minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  const ms = londonInstantMs(dayKey, Math.floor(clamped / 60), clamped % 60);
  // Minutes past 23:59 are carried as whole minutes on top of the resolved
  // instant, so a booking finishing at 24:00 is one instant and not a wrap to
  // midnight at the START of the same day.
  const overflow = Math.max(0, Math.round(minutes) - clamped);
  return new Date(ms + overflow * 60_000).toISOString();
}

function originOf(appt: DiaryAppointment, dayKey: string): DragOrigin {
  const startMin = londonMinutes(appt.start);
  return {
    appointmentId: appt.id,
    dayKey,
    startMin,
    endMin: startMin + effectiveMinutes(appt),
    practitionerId: appt.practitionerId,
  };
}

interface DragState {
  appt: DiaryAppointment;
  origin: DragOrigin;
  originColumnKey: string;
  mode: "move" | "resize";
  startClientY: number;
  startClientX: number;
  started: boolean;
  /** FROZEN at pointerdown. dayBounds extends to cover anything booked outside
   *  opening hours, so an optimistic move to 07:15 would otherwise re-lay every
   *  block on screen under the pointer mid-gesture. */
  bounds: Span;
  zoom: Zoom;
  columnTop: number;
  /** The block element, so pointer capture can be taken LATE. See onMove. */
  li: HTMLElement;
  /** True once setPointerCapture succeeded, so it is released exactly once. */
  captured: boolean;
}

interface KeyboardState {
  mode: "move" | "resize";
  appt: DiaryAppointment;
  origin: DragOrigin;
  columnIndex: number;
  deltaMin: number;
}

export interface DiaryMoveApi {
  allowed: boolean;
  pending: Map<string, PendingMove>;
  draggingId: string | null;
  preview: PreviewState | null;
  proposal: MoveProposalState | null;
  proposalBusy: boolean;
  proposalError: string | null;
  keyboardMode: "move" | "resize" | null;
  keyboardId: string | null;
  status: string;
  alert: string | null;
  savingLine: string | null;
  lastMove: LastMove | null;
  registerColumn: (key: string, el: HTMLElement | null) => void;
  onBlockPointerDown: (event: React.PointerEvent, appt: DiaryAppointment, columnKey: string) => void;
  /** True when the pointer gesture that just ended was a DRAG, so the block's own
   *  click must not also open the detail panel. */
  swallowClick: () => boolean;
  /** Returns true when the key was consumed, so the grid's own handler stands down. */
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => boolean;
  openProposal: (p: MoveProposalState) => void;
  editProposal: (to: Partial<MoveEnd>) => void;
  cancelProposal: () => void;
  confirmProposal: (notifyPatient: boolean) => void;
  undo: () => void;
  dismissAlert: () => void;
  /** The live refusal for the proposal as it currently stands, re-run on every edit. */
  proposalRefusal: string | null;
}

/**
 * @param pending  the optimistic overlay, OWNED BY THE BOARD.
 *
 * It is lifted rather than held here because the board must merge it over the
 * server prop before it derives the columns this hook is then given: the rendered
 * appointment set and the pending set are two views of one thing, and holding
 * them in two places is how a block ends up drawn in one position and validated
 * in another.
 */
export function useDiaryMove(
  context: MoveContext,
  pending: Map<string, PendingMove>,
  setPending: React.Dispatch<React.SetStateAction<Map<string, PendingMove>>>,
): DiaryMoveApi {
  // The latest context, readable from a pointer handler that was installed
  // several renders ago. A drag reads this ONCE at pointerdown for the frozen
  // values and per frame for the column set.
  //
  // Synchronised in an EFFECT rather than assigned during render: a ref written
  // during render is a React violation, and an effect runs long before any
  // pointer can reach a block. Nothing here is read during render.
  const ctxRef = useRef(context);
  const setPendingRef = useRef(setPending);
  useEffect(() => {
    ctxRef.current = context;
    setPendingRef.current = setPending;
  }, [context, setPending]);

  const columnEls = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<DragState | null>(null);
  const keyboardRef = useRef<KeyboardState | null>(null);
  const clickSwallow = useRef(false);
  const failedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmounting mid-gesture (a navigation away, a site switch) must not leave the
  // body stuck in its dragging state or a rollback timer running against a
  // component that no longer exists.
  useEffect(() => {
    const timers = failedTimers.current;
    return () => {
      document.body.removeAttribute("data-diary-dragging");
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [proposal, setProposal] = useState<MoveProposalState | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [keyboardMode, setKeyboardMode] = useState<"move" | "resize" | null>(null);
  const [keyboardId, setKeyboardId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [alert, setAlert] = useState<string | null>(null);
  const [savingLine, setSavingLine] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<LastMove | null>(null);

  const allowed = context.allowed && context.blockedReason === null;

  const say = useCallback((message: string) => {
    // A repeated identical string is not re-announced by a polite live region, so
    // a zero-width space is appended when it repeats, which changes the node's
    // text without changing what is read out.
    setStatus((current) => (current === message ? `${message}​` : message));
  }, []);

  const columnFor = useCallback((key: string): MoveColumn | null => {
    return ctxRef.current.columns.find((c) => c.key === key) ?? null;
  }, []);

  /** The six checks, run against the column the gesture has landed on. */
  const check = useCallback(
    (p: MoveProposal, column: MoveColumn | null, bounds: Span, movingId: string) => {
      if (!column) {
        return {
          ok: false as const,
          message: "That is not a column an appointment can be moved to.",
        };
      }
      const result = validateMove(
        { ...p, practitionerId: column.practitionerId, dayKey: column.dayKey },
        {
          targetPractitionerId: column.practitionerId,
          targetPractitionerName: column.name,
          workState: column.workState,
          workingSpans: column.workingSpans,
          occupiedSpans: column.occupied,
          breakSpans: column.breaks,
          bounds,
          movingAppointmentId: movingId,
        },
      );
      return result.ok ? { ok: true as const, message: null } : { ok: false as const, message: result.message };
    },
    [],
  );

  const endFor = useCallback((p: MoveProposal, column: MoveColumn | null): MoveEnd => {
    return {
      dayKey: column?.dayKey ?? p.dayKey,
      startMin: p.startMin,
      endMin: p.endMin,
      practitionerId: column?.practitionerId ?? p.practitionerId,
      practitionerName: column?.name ?? null,
    };
  }, []);

  // -------------------------------------------------------------------------
  // The pointer gesture.
  // -------------------------------------------------------------------------

  const registerColumn = useCallback((key: string, el: HTMLElement | null) => {
    if (el) columnEls.current.set(key, el);
    else columnEls.current.delete(key);
  }, []);

  const swallowClick = useCallback(() => {
    const swallow = clickSwallow.current;
    clickSwallow.current = false;
    return swallow;
  }, []);

  const onBlockPointerDown = useCallback(
    (event: React.PointerEvent, appt: DiaryAppointment, columnKey: string) => {
      const ctx = ctxRef.current;
      if (!ctx.allowed || ctx.blockedReason !== null || ctx.suspended) return;
      // No drag may begin while the confirmation dialog is open, which is what
      // keeps Escape unambiguous.
      if (proposal) return;
      // No second move may start on a block that is still being saved.
      if (pending.get(appt.id)?.status === "saving") return;
      // Cancelled and did-not-attend are not draggable. The block already refuses
      // to hand us a pointerdown, and this is the second lock on the same door.
      if (!isMovableState(appt.state)) return;
      if (event.button !== 0 || !event.isPrimary) return;

      const column = ctx.columns.find((c) => c.key === columnKey) ?? null;
      const columnEl = columnEls.current.get(columnKey) ?? null;
      if (!column || !columnEl) return;

      // A gesture never inherits the previous one's swallow flag. Without this, a
      // drag whose click the browser suppressed (which touch does) would leave the
      // flag set and quietly eat the NEXT genuine click, so a block would refuse
      // to open its panel for no visible reason.
      clickSwallow.current = false;

      const li = event.currentTarget as HTMLElement;
      const rect = li.getBoundingClientRect();
      const mode = gestureFor(event.clientY - rect.top, rect.height);

      dragRef.current = {
        appt,
        origin: originOf(appt, column.dayKey),
        originColumnKey: columnKey,
        mode,
        startClientY: event.clientY,
        startClientX: event.clientX,
        started: false,
        bounds: ctx.bounds,
        zoom: ctx.zoom,
        columnTop: columnEl.getBoundingClientRect().top,
        li,
        captured: false,
      };

      // POINTER CAPTURE IS TAKEN LATE, in onMove, once the gesture has actually
      // crossed the drag threshold. NOT here.
      //
      // Taking it on pointerdown broke opening a patient. With capture active the
      // browser retargets pointerup to the CAPTURING element, so it fires `click`
      // on this <li> rather than on the <button> inside it, and the button's
      // onClick (which opens the appointment panel) never runs. Every block became
      // draggable and unclickable: the only thing a click could do was start a
      // move.
      //
      // Deferring costs nothing, by this file's own reasoning: the window
      // listeners below carry the gesture whether or not capture is held, which is
      // why the original take was wrapped in a try/catch and called a courtesy.

      const onMove = (e: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (!drag.started) {
          const moved =
            Math.abs(e.clientY - drag.startClientY) + Math.abs(e.clientX - drag.startClientX);
          if (moved < DRAG_THRESHOLD_PX) return;
          drag.started = true;
          // NOW take capture, not on pointerdown: from this point the gesture is
          // unambiguously a drag, so retargeting the click away from the block's
          // button costs nothing (that click is swallowed anyway).
          try {
            drag.li.setPointerCapture(e.pointerId);
            drag.captured = true;
          } catch {
            // A browser that refuses capture still gets a working drag from the
            // window listeners; only the pointer-leaves-the-window case degrades.
          }
          setDraggingId(drag.appt.id);
          document.body.setAttribute("data-diary-dragging", "true");
        }

        const rawDelta =
          pointerToMinutes(e.clientY, drag.columnTop, drag.bounds.startMin, drag.zoom) -
          pointerToMinutes(drag.startClientY, drag.columnTop, drag.bounds.startMin, drag.zoom);

        let targetKey = drag.originColumnKey;
        if (drag.mode === "move") {
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const cell = under?.closest("[data-diary-col]") as HTMLElement | null;
          const key = cell?.getAttribute("data-diary-col");
          if (key) targetKey = key;
        }
        const targetColumn = columnFor(targetKey);

        const p =
          drag.mode === "move"
            ? proposeMove(
                drag.origin,
                rawDelta,
                {
                  practitionerId: targetColumn?.practitionerId ?? null,
                  dayKey: targetColumn?.dayKey ?? drag.origin.dayKey,
                },
                drag.bounds,
              )
            : proposeResize(drag.origin, rawDelta, drag.bounds);

        const verdict = check(p, targetColumn, drag.bounds, drag.appt.id);
        setPreview({
          columnKey: targetKey,
          startMin: p.startMin,
          endMin: p.endMin,
          valid: verdict.ok,
          message: verdict.message,
          paletteSlot: paletteSlotFor(drag.appt.reason),
          lead: blockLeadLine(drag.appt),
        });
      };

      const finish = (e: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        const drag = dragRef.current;
        dragRef.current = null;
        setDraggingId(null);
        setPreview(null);
        document.body.removeAttribute("data-diary-dragging");
        if (!drag || !drag.started) return;

        // The gesture WAS a drag, so the block's own click must not also open the
        // detail panel behind the dialog.
        clickSwallow.current = true;

        const rawDelta =
          pointerToMinutes(e.clientY, drag.columnTop, drag.bounds.startMin, drag.zoom) -
          pointerToMinutes(drag.startClientY, drag.columnTop, drag.bounds.startMin, drag.zoom);

        let targetKey = drag.originColumnKey;
        if (drag.mode === "move") {
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const cell = under?.closest("[data-diary-col]") as HTMLElement | null;
          const key = cell?.getAttribute("data-diary-col");
          if (key) targetKey = key;
        }
        const targetColumn = columnFor(targetKey);

        const p =
          drag.mode === "move"
            ? proposeMove(
                drag.origin,
                rawDelta,
                {
                  practitionerId: targetColumn?.practitionerId ?? null,
                  dayKey: targetColumn?.dayKey ?? drag.origin.dayKey,
                },
                drag.bounds,
              )
            : proposeResize(drag.origin, rawDelta, drag.bounds);

        if (isNoopProposal(p, drag.origin)) return;

        const verdict = check(p, targetColumn, drag.bounds, drag.appt.id);
        if (!verdict.ok) {
          // AN INVALID DROP NEVER REACHES THE CONFIRMATION DIALOG. The block goes
          // back and the reason is said in full.
          say(verdict.message ?? "That move is not possible.");
          return;
        }

        const originColumn = columnFor(drag.originColumnKey);
        setProposal({
          appointment: drag.appt,
          from: endFor(
            {
              appointmentId: drag.appt.id,
              startMin: drag.origin.startMin,
              endMin: drag.origin.endMin,
              practitionerId: drag.origin.practitionerId,
              dayKey: drag.origin.dayKey,
            },
            originColumn,
          ),
          to: endFor(p, targetColumn),
        });
        setProposalError(null);
      };

      const cancel = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        dragRef.current = null;
        setDraggingId(null);
        setPreview(null);
        document.body.removeAttribute("data-diary-dragging");
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
    },
    [check, columnFor, endFor, pending, proposal, say],
  );

  // -------------------------------------------------------------------------
  // The keyboard equivalent.
  // -------------------------------------------------------------------------

  const targetableColumns = useCallback(
    () => ctxRef.current.columns.filter((c) => c.practitionerId !== null),
    [],
  );

  const announceKeyboard = useCallback(
    (state: KeyboardState) => {
      const columns = targetableColumns();
      const column = columns[state.columnIndex] ?? null;
      const p =
        state.mode === "move"
          ? proposeMove(
              state.origin,
              state.deltaMin,
              {
                practitionerId: column?.practitionerId ?? null,
                dayKey: column?.dayKey ?? state.origin.dayKey,
              },
              ctxRef.current.bounds,
            )
          : proposeResize(state.origin, state.deltaMin, ctxRef.current.bounds);
      const verdict = check(p, column, ctxRef.current.bounds, state.appt.id);
      setPreview({
        columnKey: column?.key ?? "",
        startMin: p.startMin,
        endMin: p.endMin,
        valid: verdict.ok,
        message: verdict.message,
        paletteSlot: paletteSlotFor(state.appt.reason),
        lead: blockLeadLine(state.appt),
      });
      say(
        verdict.ok
          ? proposedAnnouncement(
              shortPatientName(state.appt.patientName),
              labelMinutes(p.startMin),
              column?.name ?? null,
              p.endMin - p.startMin,
            )
          : (verdict.message ?? "That move is not possible."),
      );
      return { proposal: p, column, verdict };
    },
    [check, say, targetableColumns],
  );

  const exitKeyboard = useCallback(() => {
    keyboardRef.current = null;
    setKeyboardMode(null);
    setKeyboardId(null);
    setPreview(null);
  }, []);

  // Declared before the key handler that calls it, because undo is defined below
  // (it needs `send`) and the handler must not close over a binding that is not
  // yet in scope.
  const undoRef = useRef<() => void>(() => undefined);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): boolean => {
      const ctx = ctxRef.current;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return false;
      }

      // Undo is checked BEFORE the grid's own metaKey/ctrlKey early return, or it
      // could never fire at all.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (!lastMove || Date.now() - lastMove.at > UNDO_WINDOW_MS) return false;
        event.preventDefault();
        undoRef.current();
        return true;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return false;

      const state = keyboardRef.current;
      if (state) {
        const key = event.key;
        if (key === "Escape") {
          event.preventDefault();
          const column = targetableColumns()[state.columnIndex] ?? null;
          say(
            cancelledAnnouncement(
              shortPatientName(state.appt.patientName),
              labelMinutes(state.origin.startMin),
              column?.name ?? null,
            ),
          );
          exitKeyboard();
          return true;
        }
        if (key === "Enter") {
          event.preventDefault();
          const columns = targetableColumns();
          const column = columns[state.columnIndex] ?? null;
          const p =
            state.mode === "move"
              ? proposeMove(
                  state.origin,
                  state.deltaMin,
                  {
                    practitionerId: column?.practitionerId ?? null,
                    dayKey: column?.dayKey ?? state.origin.dayKey,
                  },
                  ctx.bounds,
                )
              : proposeResize(state.origin, state.deltaMin, ctx.bounds);
          const verdict = check(p, column, ctx.bounds, state.appt.id);
          if (!verdict.ok) {
            say(verdict.message ?? "That move is not possible.");
            return true;
          }
          if (isNoopProposal(p, state.origin)) {
            exitKeyboard();
            return true;
          }
          const originColumn =
            ctx.columns.find(
              (c) =>
                c.practitionerId === state.origin.practitionerId &&
                c.dayKey === state.origin.dayKey,
            ) ?? null;
          setProposal({
            appointment: state.appt,
            from: endFor(
              {
                appointmentId: state.appt.id,
                startMin: state.origin.startMin,
                endMin: state.origin.endMin,
                practitionerId: state.origin.practitionerId,
                dayKey: state.origin.dayKey,
              },
              originColumn,
            ),
            to: endFor(p, column),
          });
          setProposalError(null);
          exitKeyboard();
          return true;
        }

        // Shift MUST be tested before the plain arrows, or the thirty minute step
        // is unreachable.
        const step = event.shiftKey ? 30 : SNAP_MIN;
        if (key === "ArrowDown" || key === "ArrowUp") {
          event.preventDefault();
          const dir = key === "ArrowDown" ? 1 : -1;
          state.deltaMin = snapDelta(state.deltaMin + dir * step);
          announceKeyboard(state);
          return true;
        }
        if (state.mode === "move" && (key === "ArrowRight" || key === "ArrowLeft")) {
          event.preventDefault();
          const columns = targetableColumns();
          const dir = key === "ArrowRight" ? 1 : -1;
          const next = Math.max(0, Math.min(columns.length - 1, state.columnIndex + dir));
          state.columnIndex = next;
          announceKeyboard(state);
          return true;
        }
        // Every other key is swallowed while a move is in progress, so a stray
        // 'w' cannot switch view out from under an uncommitted move.
        if (key.length === 1) {
          event.preventDefault();
          return true;
        }
        return false;
      }

      const lower = event.key.toLowerCase();
      if (lower !== "m" && lower !== "r") return false;
      if (!ctx.focusedId) return false;
      event.preventDefault();

      if (!ctx.allowed) return true;
      if (ctx.blockedReason !== null) {
        say(ctx.blockedReason);
        return true;
      }
      const appt = ctx.appointmentsById.get(ctx.focusedId);
      if (!appt) return true;
      if (pending.get(appt.id)?.status === "saving") return true;
      // The keyboard equivalent of the drag guard. A cancelled or did-not-attend
      // booking is not a booking: moving it would write a new time into Dentally
      // for an appointment that is not happening and text the patient about it.
      if (!isMovableState(appt.state)) {
        say(NOT_MOVABLE);
        return true;
      }

      const columns = targetableColumns();
      const columnIndex = Math.max(
        0,
        columns.findIndex((c) => c.key === ctx.focusedColumnKey),
      );
      const column = columns[columnIndex] ?? null;
      const origin = originOf(appt, column?.dayKey ?? ctx.columns[0]?.dayKey ?? "");
      const mode = lower === "m" ? "move" : "resize";
      keyboardRef.current = { mode, appt, origin, columnIndex, deltaMin: 0 };
      setKeyboardMode(mode);
      setKeyboardId(appt.id);
      say(
        moveModeAnnouncement(
          mode,
          shortPatientName(appt.patientName),
          labelMinutes(origin.startMin),
          column?.name ?? null,
        ),
      );
      return true;
    },
    [announceKeyboard, check, endFor, exitKeyboard, lastMove, pending, say, targetableColumns],
  );

  // -------------------------------------------------------------------------
  // Committing.
  // -------------------------------------------------------------------------

  const setPendingEntry = useCallback(
    (id: string, entry: PendingMove | null) => {
      setPending((current) => {
        const next = new Map(current);
        if (entry === null) next.delete(id);
        else next.set(id, entry);
        return next;
      });
    },
    [setPending],
  );

  /**
   * Pin a block at the position we have evidence for, with NO marker.
   *
   * Used whenever a move was refused or never reached the server: nothing
   * changed, so the block belongs at the proposal's `from` end. Deleting the
   * entry instead would fall back to the board's server prop, which after a
   * confirmed move and before the refresh lands still holds the OLD time.
   */
  const holdAtTruth = useCallback(
    (id: string, p: MoveProposalState) => {
      setPendingEntry(id, {
        appointmentId: id,
        startTime: isoFromDayMinutes(p.from.dayKey, p.from.startMin),
        finishTime: isoFromDayMinutes(p.from.dayKey, p.from.endMin),
        durationMin: p.from.endMin - p.from.startMin,
        practitionerId: p.from.practitionerId ?? "",
        practitionerName: p.from.practitionerName ?? "",
        dayKey: p.from.dayKey,
        status: "held",
      });
      const timer = failedTimers.current.get(id);
      if (timer) clearTimeout(timer);
      failedTimers.current.set(
        id,
        setTimeout(() => {
          failedTimers.current.delete(id);
          setPendingRef.current((current) => {
            const entry = current.get(id);
            if (!entry || entry.status !== "held") return current;
            const next = new Map(current);
            next.delete(id);
            return next;
          });
        }, FAILED_LINGER_MS),
      );
    },
    [setPendingEntry],
  );

  const send = useCallback(
    async (
      p: MoveProposalState,
      opts: { notifyPatient: boolean; undoOf: string | null; viaDialog: boolean },
    ): Promise<void> => {
      const ctx = ctxRef.current;
      const appt = p.appointment;
      const patientShort = shortPatientName(appt.patientName);
      const startTime = isoFromDayMinutes(p.to.dayKey, p.to.startMin);
      const finishTime = isoFromDayMinutes(p.to.dayKey, p.to.endMin);
      const durationMin = p.to.endMin - p.to.startMin;

      if (p.to.practitionerId === null) {
        setProposalError("An appointment cannot be moved to Unassigned. Choose a clinician.");
        return;
      }

      setProposalBusy(true);
      setProposalError(null);
      // OPTIMISTIC: the block moves now, draws its saving treatment and is inert
      // until the answer comes back.
      setPendingEntry(appt.id, {
        appointmentId: appt.id,
        startTime,
        finishTime,
        durationMin,
        practitionerId: p.to.practitionerId,
        practitionerName: p.to.practitionerName ?? "",
        dayKey: p.to.dayKey,
        status: "saving",
      });
      setSavingLine(savingAnnouncement(patientShort, labelMinutes(p.to.startMin), p.to.practitionerName));
      say(savingAnnouncement(patientShort, labelMinutes(p.to.startMin), p.to.practitionerName));

      // `expected` is derived from the proposal's OWN `from` end, never from
      // appt.start. The two agree for a first move, and they must not for an
      // UNDO: after a saved move the server holds the new time, the board's
      // server prop may still hold the old one, and an `expected` taken from the
      // prop would 409 every undo. The optimistic overlay is what the reader is
      // looking at, and `from` is read off exactly that.
      const expectedStart = isoFromDayMinutes(p.from.dayKey, p.from.startMin);
      const expectedFinish = isoFromDayMinutes(p.from.dayKey, p.from.endMin);

      try {
        const res = await fetch(`/api/calendar/appointment/${encodeURIComponent(appt.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            siteId: ctx.siteId,
            day: p.to.dayKey,
            startTime,
            finishTime,
            practitionerId: p.to.practitionerId,
            expected: {
              startTime: expectedStart,
              finishTime: expectedFinish,
              practitionerId: p.from.practitionerId,
            },
            notifyPatient: opts.notifyPatient,
            undoOf: opts.undoOf,
          }),
        });
        const payload = (await res.json()) as {
          ok?: boolean;
          confirmed?: boolean;
          reason?: string;
          error?: string;
          moveId?: string | null;
          notify?: { queued: boolean; reason: string | null };
        };

        setSavingLine(null);

        if (payload.ok === true && payload.confirmed === true) {
          setPendingEntry(appt.id, {
            appointmentId: appt.id,
            startTime,
            finishTime,
            durationMin,
            practitionerId: p.to.practitionerId,
            practitionerName: p.to.practitionerName ?? "",
            dayKey: p.to.dayKey,
            status: "saved",
          });
          setProposal(null);
          setProposalBusy(false);
          setLastMove({
            appointmentId: appt.id,
            patientShort,
            moveId: payload.moveId ?? null,
            from: p.from,
            to: p.to,
            at: Date.now(),
            notify: payload.notify ?? null,
          });
          // The Undo affordance retires itself, so a button that would no longer
          // work is never left on screen. Ctrl+Z retires with it.
          if (undoTimer.current) clearTimeout(undoTimer.current);
          undoTimer.current = setTimeout(() => setLastMove(null), UNDO_WINDOW_MS);
          say(movedAnnouncement(patientShort, labelMinutes(p.to.startMin), p.to.practitionerName));
          // Focus is repaired here: a cross-column move unmounts the block from
          // one list and remounts it in another, which sends focus to <body>.
          requestAnimationFrame(() => {
            document.getElementById(`diary-appt-${appt.id}`)?.focus();
          });
          return;
        }

        // reason "unknown" does NOT roll back and does NOT commit. The block draws
        // at its original place with a marker, because snapping back would assert
        // something we do not know.
        if (payload.reason === "unknown") {
          setPendingEntry(appt.id, {
            appointmentId: appt.id,
            startTime,
            finishTime,
            durationMin,
            practitionerId: p.to.practitionerId,
            practitionerName: p.to.practitionerName ?? "",
            dayKey: p.to.dayKey,
            status: "unknown",
          });
          setProposal(null);
          setProposalBusy(false);
          setAlert(unknownOutcomeSentence(patientShort));
          say(unknownOutcomeSentence(patientShort));
          return;
        }

        const message =
          payload.error ?? "That move did not save. The appointment is unchanged.";
        if (opts.viaDialog && !payload.reason) {
          // A refusal from a GUARD (the write gate, the kill switch, a 403, a
          // 409) is shown IN the dialog rather than after the fact, so the reader
          // learns before they walk away that nothing was changed.
          holdAtTruth(appt.id, p);
          setProposalBusy(false);
          setProposalError(message);
          say(message);
          return;
        }

        // ROLLBACK: the block returns to WHERE IT ACTUALLY IS, marked, and the
        // alert carries the server's own words.
        //
        // "Where it actually is" is the proposal's own `from` end, NOT the board's
        // server prop. For a first move the two agree. For a second move or an
        // undo inside the refresh window they do not: the prop still holds the
        // pre-move time while Dentally holds the moved one, so falling back to it
        // drew the appointment in a place it is not, directly contradicting the
        // alert that names the right one.
        setPendingEntry(appt.id, {
          appointmentId: appt.id,
          startTime: isoFromDayMinutes(p.from.dayKey, p.from.startMin),
          finishTime: isoFromDayMinutes(p.from.dayKey, p.from.endMin),
          durationMin: p.from.endMin - p.from.startMin,
          practitionerId: p.from.practitionerId ?? p.to.practitionerId,
          practitionerName: p.from.practitionerName ?? "",
          dayKey: p.from.dayKey,
          status: "failed",
        });
        const timer = failedTimers.current.get(appt.id);
        if (timer) clearTimeout(timer);
        failedTimers.current.set(
          appt.id,
          setTimeout(() => {
            failedTimers.current.delete(appt.id);
            setPendingRef.current((current) => {
              const entry = current.get(appt.id);
              if (!entry || entry.status !== "failed") return current;
              const next = new Map(current);
              next.delete(appt.id);
              return next;
            });
          }, FAILED_LINGER_MS),
        );
        setProposal(null);
        setProposalBusy(false);
        const sentence = notSavedAnnouncement(
          patientShort,
          labelMinutes(p.from.startMin),
          p.from.practitionerName,
        );
        setAlert(`${sentence} ${message}`);
        say(sentence);
      } catch {
        setSavingLine(null);
        setProposalBusy(false);
        // Held at the true position rather than dropped, for the same reason as
        // the refusal branch above.
        holdAtTruth(appt.id, p);
        const sentence = notSavedAnnouncement(
          patientShort,
          labelMinutes(p.from.startMin),
          p.from.practitionerName,
        );
        if (opts.viaDialog) setProposalError(`${sentence} The diary could not reach the server.`);
        else setAlert(`${sentence} The diary could not reach the server.`);
        say(sentence);
      }
    },
    [holdAtTruth, say, setPendingEntry],
  );

  const confirmProposal = useCallback(
    (notifyPatient: boolean) => {
      if (!proposal) return;
      void send(proposal, { notifyPatient, undoOf: proposal.undoOf ?? null, viaDialog: true });
    },
    [proposal, send],
  );

  const cancelProposal = useCallback(() => {
    // NO is a complete no-op: no request, no pending entry, no queued touch and no
    // audit row. The proposal never entered the overlay, so the block is already
    // where it was.
    const p = proposal;
    setProposal(null);
    setProposalError(null);
    setProposalBusy(false);
    if (p) {
      say(
        cancelledAnnouncement(
          shortPatientName(p.appointment.patientName),
          labelMinutes(p.from.startMin),
          p.from.practitionerName,
        ),
      );
    }
  }, [proposal, say]);

  const editProposal = useCallback((to: Partial<MoveEnd>) => {
    setProposal((current) => (current ? { ...current, to: { ...current.to, ...to } } : current));
    setProposalError(null);
  }, []);

  const undo = useCallback(() => {
    const last = lastMove;
    if (!last) return;
    if (Date.now() - last.at > UNDO_WINDOW_MS) return;
    const appt = ctxRef.current.appointmentsById.get(last.appointmentId);
    if (!appt) {
      setAlert("That appointment is no longer on screen, so the move cannot be undone here.");
      return;
    }
    setLastMove(null);
    // UNDO OPENS THE SAME DIALOG. It is a Dentally write and a SECOND text to the
    // same patient ("moved to 2.30pm", then "moved to 9.30am"), and the diary
    // source is transactional so the drain's frequency cap does not hold it back.
    // Committing that on a keystroke, with no statement that the patient is about
    // to be messaged again, is exactly what the confirmation step exists to
    // prevent. The reverse move then goes through the same route, the same gate,
    // the same server-side re-validation and the same read-back.
    setProposal({ appointment: appt, from: last.to, to: last.from, undoOf: last.moveId });
    setProposalError(null);
    setProposalBusy(false);
  }, [lastMove]);
  useEffect(() => {
    undoRef.current = undo;
  }, [undo]);

  const dismissAlert = useCallback(() => setAlert(null), []);

  const openProposal = useCallback((p: MoveProposalState) => {
    setProposal(p);
    setProposalError(null);
    setProposalBusy(false);
  }, []);

  /** Re-run on every dialog edit, so Yes is disabled the moment an edit is illegal. */
  const proposalRefusal = useMemo(() => {
    if (!proposal) return null;
    const column =
      context.columns.find(
        (c) =>
          c.practitionerId === proposal.to.practitionerId && c.dayKey === proposal.to.dayKey,
      ) ?? null;
    // NO DRAWN COLUMN, NOTHING LOCAL TO SAY. A suggested slot or an undo can point
    // at a day the grid is not showing, and there is then no local picture to
    // check it against; the server re-runs all six checks against inputs it
    // fetches itself. This is keyed on the COLUMN and not on `fromSuggestion`,
    // because that flag survived an edit: a reader who opened "Change the time or
    // clinician" on a suggestion and set an illegal time kept the short-circuit
    // and reached an enabled Yes.
    if (!column) return null;
    const p = clampToBounds(
      {
        appointmentId: proposal.appointment.id,
        startMin: proposal.to.startMin,
        endMin: proposal.to.endMin,
        practitionerId: proposal.to.practitionerId,
        dayKey: proposal.to.dayKey,
      },
      context.bounds,
    );
    const verdict = check(p, column, context.bounds, proposal.appointment.id);
    return verdict.ok ? null : verdict.message;
  }, [proposal, context.columns, context.bounds, check]);

  return {
    allowed,
    pending,
    draggingId,
    preview,
    proposal,
    proposalBusy,
    proposalError,
    keyboardMode,
    keyboardId,
    status,
    alert,
    savingLine,
    lastMove,
    registerColumn,
    onBlockPointerDown,
    swallowClick,
    onKeyDown,
    openProposal,
    editProposal,
    cancelProposal,
    confirmProposal,
    undo,
    dismissAlert,
    proposalRefusal,
  };
}
