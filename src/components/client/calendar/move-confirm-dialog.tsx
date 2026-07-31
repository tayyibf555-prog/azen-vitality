"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { labelMinutes } from "./diary-grid";
import { longDate } from "./calendar-logic";
import { shortPatientName } from "./diary-view";
import { typeLabelFor } from "./treatment-type";
import { moveSubjectLine, notifyNotice, type NotifyBlocker } from "./move-copy";
import { isoFromDayMinutes, type MoveEnd, type MoveProposalState } from "./use-diary-move";

// ---------------------------------------------------------------------------
// "Move this appointment?"
//
// A MODAL IN THE MIDDLE OF THE SCREEN. Not a toast, not an inline popover, not a
// bar at the edge. Dropping a block does not commit anything: this is what
// commits it, and until Yes is pressed nothing at all has been written.
//
// It states the move in plain words and names BOTH ends, so the reader sees what
// is changing FROM as well as TO. A clinician-only move therefore shows the same
// time twice, in muted ink, and reads at a glance as "only the clinician moved".
//
// It also says, before the reader commits, WHETHER THE PATIENT WILL BE TEXTED,
// computed from the same pure predicate the server uses. A person moving an
// appointment has to know whether the patient is about to hear about it.
//
// The full accessibility contract a blocking dialog owes: role="dialog",
// aria-modal, a focus trap whose focusable set is recollected on every Tab, focus
// moved in on open and RESTORED to the block on close, Escape as No, and a
// heading that labels it. The keyboard move path reaches this same dialog.
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** "HH:MM" -> minutes past midnight, or null when it is not a usable time. */
function minutesOfTimeInput(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(mins) && mins >= 0 && mins <= 1440 ? mins : null;
}

function EndRow({
  label,
  end,
  changed,
}: {
  label: string;
  end: MoveEnd;
  changed: { time: boolean; clinician: boolean };
}) {
  return (
    <div className="flex items-baseline gap-3 py-[3px]">
      <dt className="w-[42px] shrink-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-muted">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] font-semibold tabular-nums">
        <span className="text-muted">{longDate(end.dayKey)}</span>
        {/* The CHANGED parts are navy and the unchanged parts muted, on BOTH
            rows, so a clinician-only move visibly shows the same time twice in
            grey and nothing has to be inferred from the absence of a difference. */}
        <span className={changed.time ? "text-navy" : "text-muted"}>{labelMinutes(end.startMin)}</span>
        <span className={changed.clinician ? "text-navy" : "text-muted"}>
          {end.practitionerName ?? "Not assigned"}
        </span>
      </dd>
    </div>
  );
}

export interface MoveConfirmClinician {
  id: string;
  name: string;
}

export function MoveConfirmDialog({
  proposal,
  clinicians,
  busy,
  error,
  refusal,
  notifyBlocker,
  dryRun,
  onEdit,
  onNo,
  onYes,
}: {
  proposal: MoveProposalState;
  /** The day's clinicians, for the disclosure. Unassigned is never offered. */
  clinicians: MoveConfirmClinician[];
  busy: boolean;
  /** A refusal from the SERVER, shown here rather than after the fact. */
  error: string | null;
  /** A refusal from the shared validator, re-run live as the reader edits. */
  refusal: string | null;
  notifyBlocker: NotifyBlocker;
  dryRun: boolean;
  onEdit: (to: Partial<MoveEnd>) => void;
  onNo: () => void;
  onYes: (notifyPatient: boolean) => void;
}) {
  const headingId = useId();
  const fieldId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const noRef = useRef<HTMLButtonElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  const appt = proposal.appointment;
  const patientShort = shortPatientName(appt.patientName);

  // Focus moves IN on open and is RESTORED to the BLOCK on close, by any route:
  // Yes, No, Escape or the scrim. The block is found by id rather than by the
  // stored node, because a cross-column move unmounts and remounts it.
  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    noRef.current?.focus();
    const id = appt.id;
    // NO `inert` ON THE APP SHELL, deliberately. This dialog is a DOM descendant
    // of .app-frame, so making the shell inert would make the dialog itself inert
    // and leave a blocking confirmation nobody could answer. The background is
    // held off by three things that do work from inside: aria-modal="true" hides
    // it from assistive tech, the full-viewport scrim takes every pointer event
    // (and answers No), and the Tab trap below keeps focus in the panel.
    return () => {
      requestAnimationFrame(() => {
        const block = document.getElementById(`diary-appt-${id}`);
        if (block) block.focus();
        else restoreTo.current?.focus();
      });
    };
  }, [appt.id]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // stopPropagation, so Escape can never also reach the grid's own handler
        // and close something else behind this dialog.
        event.stopPropagation();
        onNo();
        return;
      }
      if (event.key !== "Tab") return;
      // Recollected on EVERY Tab, so the disclosure below cannot let focus escape
      // the trap the moment it is opened.
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onNo],
  );

  const changed = {
    time:
      proposal.from.startMin !== proposal.to.startMin ||
      proposal.from.endMin !== proposal.to.endMin ||
      proposal.from.dayKey !== proposal.to.dayKey,
    clinician: proposal.from.practitionerId !== proposal.to.practitionerId,
  };

  // Both ends come from the PROPOSAL, not from appt.start: after an earlier saved
  // move the board's server prop can still hold the old time, and the reader is
  // looking at the optimistic overlay. The same two instants the server will
  // compare are compared here, through the same predicate.
  const notice = useMemo(
    () =>
      notifyNotice({
        from: { startIso: isoFromDayMinutes(proposal.from.dayKey, proposal.from.startMin) },
        to: { startIso: isoFromDayMinutes(proposal.to.dayKey, proposal.to.startMin) },
        blocker: notifyBlocker,
        dryRun,
      }),
    [
      proposal.from.dayKey,
      proposal.from.startMin,
      proposal.to.dayKey,
      proposal.to.startMin,
      notifyBlocker,
      dryRun,
    ],
  );

  const subject = moveSubjectLine({
    patientShort,
    treatment: typeLabelFor(appt.reason) ?? appt.reason,
    minutes: proposal.to.endMin - proposal.to.startMin,
  });

  const blocked = refusal !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="No, do not move this appointment"
        onClick={onNo}
        className="absolute inset-0"
        style={{ background: "rgba(11, 32, 73, 0.35)" }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className="shadow-chip relative w-full max-w-[420px] rounded-[10px] border border-line-strong bg-card px-5 py-[18px]"
      >
        <h2 id={headingId} className="text-[15px] font-semibold text-navy">
          Move this appointment?
        </h2>
        <p className="mt-1 text-[12.5px] leading-[1.45] text-ink">{subject}</p>

        <dl className="mt-3 border-y border-line py-1.5">
          <EndRow label="From" end={proposal.from} changed={changed} />
          <EndRow label="To" end={proposal.to} changed={changed} />
        </dl>

        {/* Accurate by construction: the same predicate the server runs, never a
            sentence hand-written per case. */}
        <p
          className={cn(
            "mt-3 rounded-md px-2.5 py-1.5 text-[11.5px] leading-[1.45]",
            notice.tone === "amber"
              ? "border border-tint-amber-line bg-tint-amber text-status-amber"
              : "text-ink",
          )}
        >
          {notice.text}
        </p>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-2 text-[11px] font-medium text-blue-deep underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          Change the time or clinician
        </button>

        {/* Not a nicety: below lg the grid draws a single column, so without this
            a clinician cannot be changed by pointer at all on a laptop-narrow
            window. */}
        {open ? (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <label htmlFor={`${fieldId}-time`} className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.04em] text-muted">
                Start
              </span>
              <input
                id={`${fieldId}-time`}
                type="time"
                step={300}
                value={labelMinutes(proposal.to.startMin)}
                onChange={(e) => {
                  const mins = minutesOfTimeInput(e.target.value);
                  if (mins === null) return;
                  const length = proposal.to.endMin - proposal.to.startMin;
                  onEdit({ startMin: mins, endMin: mins + length });
                }}
                className="w-full rounded-md border border-line-strong bg-card px-2 py-[5px] text-[12.5px] tabular-nums text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              />
            </label>
            <label htmlFor={`${fieldId}-prac`} className="block">
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.04em] text-muted">
                Clinician
              </span>
              <select
                id={`${fieldId}-prac`}
                value={proposal.to.practitionerId ?? ""}
                onChange={(e) => {
                  const id = e.target.value;
                  const picked = clinicians.find((c) => c.id === id) ?? null;
                  onEdit({ practitionerId: picked?.id ?? null, practitionerName: picked?.name ?? null });
                }}
                className="w-full rounded-md border border-line-strong bg-card px-2 py-[5px] text-[12.5px] text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              >
                {clinicians.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {refusal ? (
          <p role="alert" className="mt-3 text-[11.5px] leading-[1.45] text-ink">
            {refusal}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-[11.5px] leading-[1.45] text-ink">
            {error}
          </p>
        ) : null}

        {/* Exactly two, in DOM order No then Yes. There is no close X. */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            ref={noRef}
            type="button"
            onClick={onNo}
            className="rounded-md border border-line-strong bg-card px-3 py-[6px] text-[12px] font-medium text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            No
          </button>
          <button
            type="button"
            disabled={busy || blocked}
            onClick={() => onYes(notice.willQueue)}
            className="rounded-md bg-navy px-3 py-[6px] text-[12px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Saving" : "Yes"}
          </button>
        </div>
      </div>
    </div>
  );
}
