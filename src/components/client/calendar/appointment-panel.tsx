"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { FUNDING_LABEL, type FundingCode } from "@/lib/calendar/funding";
import type { Proposal } from "@/lib/calendar/propose";
import { longDate, safeDayKey, stateDotClass, stateLabel, STATE_BADGE_TONE } from "./calendar-logic";
import { blockTimes, stateGlyph, type DiaryAppointment } from "./diary-view";
import { typeLabelFor } from "./treatment-type";
import { WRITE_GATE_OFF_PANEL, WRITE_GATE_ON_PANEL } from "./move-copy";
import { RescheduleSuggestions } from "./reschedule-suggestions";

// ---------------------------------------------------------------------------
// The appointment detail panel.
//
// It shows what is already in hand plus two things it has to fetch: the record of
// every time this appointment has been MOVED, and, on request, replacement times
// that are both available and clinically suitable.
//
// The foot of the panel is the single most important line on the screen, and it
// must be ACCURATE about what this diary can currently do. With the Dentally
// write gate shut it says so plainly, because a clinician who drags a block and
// sees nothing happen concludes the software is broken. With the gate open it
// says how to move an appointment and that every move is confirmed first.
//
// APPOINTMENT UPDATE IS UNPROVEN AGAINST LIVE DENTALLY. createAppointment has
// been exercised against the real API; PUT /v1/appointments/:id has not. Nothing
// in this panel presents it as verified.
// ---------------------------------------------------------------------------

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="border-b border-line pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
      {children}
    </h3>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="shrink-0 text-[11px] font-medium text-muted">{label}</span>
      <span className="min-w-0 text-right text-[12.5px] font-bold tabular-nums text-navy">{value}</span>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface MoveRow {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  actorRole: string | null;
  fromStartAt: string | null;
  toStartAt: string | null;
  outcome: string;
  detail: string | null;
  touchId: string | null;
  notifyIntent: boolean;
}

const MOVE_OUTCOME_LABEL: Record<string, string> = {
  saved: "Saved",
  refused: "Refused",
  not_saved: "Did not save",
  unknown: "Not confirmed",
};

export function AppointmentPanel({
  appointment,
  clinicianName,
  siteName,
  siteId,
  dayKey,
  funding = "unknown",
  fundingFailed = false,
  clientSlug,
  canMove = false,
  writeEnabled = false,
  moveBlockedReason = null,
  onPickProposal,
  onClose,
}: {
  appointment: DiaryAppointment;
  clinicianName: string | null;
  siteName: string;
  siteId: string;
  /** The London day this appointment sits on, for the proposal read. */
  dayKey: string;
  /** Resolved from the PATIENT's payment plan, never from the appointment. */
  funding?: FundingCode;
  /** True when the funding read itself failed, which is a DIFFERENT fact from
   *  "nothing on file" and gets its own words rather than an omitted row. */
  fundingFailed?: boolean;
  clientSlug: string;
  /** Role-gated and read-gated, from the same list the server enforces. */
  canMove?: boolean;
  /** isDentallyWriteEnabled(). The foot of the panel says which it is. */
  writeEnabled?: boolean;
  /** Set when a read failed and moving is therefore refused at this site. */
  moveBlockedReason?: string | null;
  onPickProposal?: (p: Proposal) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [moves, setMoves] = useState<MoveRow[] | null>(null);
  const [movesFailed, setMovesFailed] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // The move record. A FAILED read is reported as failed and never as an empty
  // history: migration 0063 is checked in but not applied, so locally this
  // genuinely cannot be read, and "this has never been moved" would be a lie.
  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    const params = new URLSearchParams({ site: siteId });
    fetch(`/api/calendar/appointment/${encodeURIComponent(appointment.id)}?${params.toString()}`, {
      headers: { accept: "application/json" },
    })
      .then(async (res) => {
        const body = (await res.json()) as { ok?: boolean; moves?: MoveRow[]; failed?: boolean };
        if (!res.ok || body.ok !== true) throw new Error("move history read failed");
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setMoves(body.moves ?? []);
        setMovesFailed(body.failed === true);
      })
      .catch(() => {
        if (cancelled) return;
        setMoves([]);
        setMovesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [appointment.id, siteId]);

  // Escape closes, and Tab is trapped inside the panel while it is open.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
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
    [onClose],
  );

  const times = blockTimes(appointment);
  // safeDayKey, never dayKey: dayKey throws on an unparseable start, and the
  // panel is exactly where a row with a missing start time gets opened to find
  // out what is wrong with it.
  const dateKey = safeDayKey(appointment.start);
  const tone = STATE_BADGE_TONE[appointment.state];
  const label = stateLabel(appointment.state);
  const glyph = stateGlyph(appointment.state);
  const typeLabel = typeLabelFor(appointment.reason);
  // Three distinct answers, never collapsed into two: we could not find out, we
  // asked and there is nothing on file, and the code itself.
  const fundingValue = fundingFailed
    ? "Could not be loaded"
    : funding === "unknown"
      ? "Not on file"
      : FUNDING_LABEL[funding];

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        type="button"
        aria-label="Close appointment details"
        onClick={onClose}
        className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className="shadow-shell relative ml-auto flex h-full w-full max-w-[380px] flex-col overflow-y-auto border-l border-line bg-card"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-card px-4 py-3">
          <div className="min-w-0">
            <h2 id={headingId} className="truncate text-[15px] font-semibold tracking-[-0.3px] text-navy">
              {appointment.patientName}
            </h2>
            <span className="mt-1 flex items-center gap-1.5">
              {tone ? (
                <StatusPill tone={tone}>{label}</StatusPill>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted">
                  <i aria-hidden className={cn("inline-block h-[6px] w-[6px] rounded-full", stateDotClass(appointment.state))} />
                  {label}
                </span>
              )}
              {glyph?.kind === "text" ? (
                <span aria-hidden className="text-[10px] font-bold text-faint">
                  {glyph.text}
                </span>
              ) : null}
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-card-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 px-4 py-4">
          <section>
            <PanelTitle>This appointment</PanelTitle>
            <div className="pt-1">
              <Row label="Date" value={dateKey ? longDate(dateKey) : "Not recorded"} />
              <Row
                label="Time"
                value={times ? `${times.startLabel} to ${times.endLabel}` : "Not recorded"}
              />
              <Row label="Length" value={times ? `${times.minutes} minutes` : "Not recorded"} />
              <Row label="Reason" value={appointment.reason ?? "No reason recorded"} />
              {/* The type label only when it says something the raw reason did
                  not: repeating the same words on two rows is noise, not density. */}
              {typeLabel && typeLabel.toLowerCase() !== (appointment.reason ?? "").trim().toLowerCase() ? (
                <Row label="Treatment type" value={typeLabel} />
              ) : null}
              <Row label="Clinician" value={clinicianName ?? appointment.practitioner ?? "Not assigned"} />
              {/* NEVER omitted. A failed read and an empty record look identical on
                  the grid, so the panel is where the two are told apart in words. */}
              <Row label="Funding" value={fundingValue} />
              <Row label="Site" value={siteName} />
              <Row label="State" value={label} />
            </div>
          </section>

          {/* Omitted entirely when there is no note, never rendered as an empty line. */}
          {appointment.note ? (
            <section>
              <PanelTitle>Booking note</PanelTitle>
              <p className="mt-1.5 rounded-md bg-card-muted px-2.5 py-2 text-[12.5px] leading-[1.45] text-navy">
                {appointment.note}
              </p>
            </section>
          ) : null}

          {/* Replacement times, on request. A slot only appears when the clinician
              genuinely has availability then AND is suited to the treatment; the
              filter runs on the server before the ordering, so nothing here can
              relax it. */}
          {canMove && onPickProposal ? (
            <section>
              <PanelTitle>Cancel or reschedule</PanelTitle>
              <div className="pt-1.5">
                <RescheduleSuggestions
                  siteId={siteId}
                  appointmentId={appointment.id}
                  day={dayKey}
                  onPick={onPickProposal}
                />
              </div>
            </section>
          ) : null}

          {/* Every move on this appointment: who, when, and what happened to the
              patient's text. Automated and manual action alike is shown rather
              than made to feel magical. */}
          <section>
            <PanelTitle>Moved</PanelTitle>
            <div className="pt-1.5">
              {movesFailed ? (
                <p className="text-[11.5px] leading-[1.45] text-ink">
                  The move record could not be read, so this list is not the whole story.
                </p>
              ) : moves === null ? (
                <p className="text-[11.5px] text-muted">Reading the move record.</p>
              ) : moves.length === 0 ? (
                <p className="text-[11.5px] text-muted">This appointment has not been moved.</p>
              ) : (
                <ul className="space-y-1.5">
                  {moves.map((m) => (
                    <li key={m.id} className="text-[11.5px] leading-[1.45] text-ink">
                      <span className="font-semibold tabular-nums text-navy">
                        {MOVE_OUTCOME_LABEL[m.outcome] ?? m.outcome}
                      </span>{" "}
                      {m.actorEmail ?? "somebody"}
                      {m.actorRole ? ` (${m.actorRole})` : ""}
                      {m.createdAt ? `, ${new Date(m.createdAt).toLocaleString("en-GB")}` : ""}.
                      {m.detail ? ` ${m.detail}` : ""}
                      {m.outcome === "saved" ? (
                        <span className="text-muted">
                          {" "}
                          {m.touchId
                            ? "A text was queued for the patient."
                            : m.notifyIntent
                              ? "No text was queued."
                              : "No text was asked for."}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <PanelTitle>Reference</PanelTitle>
            <p className="pt-1 text-[10px] tabular-nums text-faint">{appointment.id}</p>
          </section>

          <div className="mt-auto space-y-2 border-t border-line pt-3">
            {appointment.patientId ? (
              <Link
                href={`/c/${clientSlug}/patients?patient=${encodeURIComponent(appointment.patientId)}`}
                className="inline-block text-[12.5px] font-medium text-blue-deep underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              >
                Open patient file
              </Link>
            ) : null}
            {/* ACCURATE about what this diary can currently do, in every state,
                and in the order the reader can act on. The ROLE comes first: a
                receptionist who may not move anything does not need to be told to
                reload the page, and a reload would not help them. */}
            <p className="text-[11px] text-muted">
              {!canMove
                ? "Appointments are moved by the practice manager and the practice owners."
                : moveBlockedReason
                  ? moveBlockedReason
                  : writeEnabled
                    ? WRITE_GATE_ON_PANEL
                    : WRITE_GATE_OFF_PANEL}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
