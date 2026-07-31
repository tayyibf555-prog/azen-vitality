"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { longDate, safeDayKey, stateDotClass, stateLabel, STATE_BADGE_TONE } from "./calendar-logic";
import { blockTimes, stateGlyph, type DiaryAppointment } from "./diary-view";

// ---------------------------------------------------------------------------
// The read-only detail panel.
//
// It shows only what is already in hand: no second fetch, no balance, no recall,
// no history. It carries no control that changes anything, and it says so in
// plain words at the foot, which is the single most important line on the
// screen: without it a clinician who tries to drag a block concludes the
// software is broken.
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

export function AppointmentPanel({
  appointment,
  clinicianName,
  siteName,
  clientSlug,
  onClose,
}: {
  appointment: DiaryAppointment;
  clinicianName: string | null;
  siteName: string;
  clientSlug: string;
  onClose: () => void;
}) {
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

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
              <Row label="Clinician" value={clinicianName ?? appointment.practitioner ?? "Not assigned"} />
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
            <p className="text-[11px] text-muted">
              This diary is read only. Appointments are booked and changed in Dentally.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
