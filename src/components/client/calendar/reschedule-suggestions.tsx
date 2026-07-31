"use client";

import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import type { Proposal, ProposalBreakdown } from "@/lib/calendar/propose";
import { labelMinutes } from "./diary-grid";
import { longDate } from "./calendar-logic";

// ---------------------------------------------------------------------------
// "Find another time."
//
// When a patient cancels or asks to reschedule, this is what the platform
// offers. A slot only appears when BOTH hold: the clinician genuinely has
// availability then, from Dentally's own windows, and the clinician is SUITED to
// the treatment. The filter runs on the server BEFORE the sort, so no ordering
// rule here can relax it.
//
// WHEN NOTHING IS BOTH AVAILABLE AND SUITED, this proposes NOTHING and says why.
// The criteria are never widened automatically: widening is a button a person
// presses, and a widened result says it was widened. Proposing a hygienist for an
// extraction because nothing else was free is the failure mode that matters here.
// ---------------------------------------------------------------------------

export interface ProposalResponse {
  ok?: boolean;
  proposals?: Proposal[];
  /** True when part of the period could not be read, so the list may be short. */
  partial?: boolean;
  daysNotRead?: number;
  seeded?: boolean;
  seededNotice?: string | null;
  breakdown?: ProposalBreakdown;
  treatment?: string;
  windowDays?: number;
  windowTo?: string;
  siteName?: string;
  error?: string;
}

/**
 * Why the list is short or empty, in whole sentences.
 *
 * ALWAYS rendered alongside the result, never only when it is empty: a blank list
 * with no explanation is a confident empty, and "nobody can do this", "nobody is
 * free" and "we never recorded who can do this" call for three different actions.
 */
function breakdownSentence(b: ProposalBreakdown, treatment: string): string {
  const parts: string[] = [];
  parts.push(
    b.capable === 1
      ? `1 clinician can do ${treatment}.`
      : `${b.capable} clinicians can do ${treatment}.`,
  );
  if (b.capableWithNoFreeTime > 0) {
    parts.push(
      b.capableWithNoFreeTime === 1
        ? "1 has no free time in this period."
        : `${b.capableWithNoFreeTime} have no free time in this period.`,
    );
  }
  if (b.cannot > 0) {
    parts.push(b.cannot === 1 ? "1 does not do this treatment." : `${b.cannot} do not do this treatment.`);
  }
  if (b.unknown > 0) {
    parts.push(
      b.unknown === 1
        ? "1 has no capability recorded, so they are not offered."
        : `${b.unknown} have no capability recorded, so they are not offered.`,
    );
  }
  return parts.join(" ");
}

export function RescheduleSuggestions({
  siteId,
  appointmentId,
  day,
  onPick,
}: {
  siteId: string;
  appointmentId: string;
  day: string;
  onPick: (p: Proposal) => void;
}) {
  const [state, setState] = useState<ProposalResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [widened, setWidened] = useState(false);

  const load = useCallback(
    async (windowDays: 14 | 30) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/calendar/propose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ siteId, appointmentId, day, windowDays }),
        });
        const payload = (await res.json()) as ProposalResponse;
        if (!res.ok || payload.ok !== true) {
          // The server's own words, verbatim. A generic shrug would leave the
          // reader unable to tell "nobody is suited" from "the read failed", and
          // those are not the same fact.
          setError(payload.error ?? "Times could not be worked out. Nothing has been changed.");
          setState(null);
          return;
        }
        setState(payload);
        setWidened(windowDays > 14);
      } catch {
        setError("Times could not be worked out. Nothing has been changed.");
        setState(null);
      } finally {
        setBusy(false);
      }
    },
    [siteId, appointmentId, day],
  );

  if (state === null) {
    return (
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(14)}
          className="rounded-md border border-line-strong bg-card px-3 py-[6px] text-[12px] font-medium text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-40"
        >
          {busy ? "Looking" : "Find another time"}
        </button>
        {error ? (
          <p role="alert" className="mt-2 text-[11.5px] leading-[1.45] text-ink">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const proposals = state.proposals ?? [];
  const treatment = state.treatment ?? "this treatment";

  return (
    <div>
      {/* The seed is mock data and the panel SAYS so wherever it is in force, so
          nobody mistakes an example capability for the practice's own answer. */}
      {state.seeded && state.seededNotice ? (
        <p className="mb-2 rounded-md border border-tint-amber-line bg-tint-amber px-2.5 py-1.5 text-[11px] leading-[1.4] text-ink">
          {state.seededNotice}
        </p>
      ) : null}

      {widened ? (
        <p className="mb-2 text-[11px] font-medium text-muted">
          Widened to the next {state.windowDays} days.
        </p>
      ) : null}

      {/* A short list has two possible reasons and they are not the same fact.
          When part of the period could not be read, the reader is told, so an
          absence of offers is never taken for an absence of free time. */}
      {state.partial ? (
        <p className="mb-2 rounded-md border border-tint-amber-line bg-tint-amber px-2.5 py-1.5 text-[11px] leading-[1.4] text-ink">
          Part of this period could not be read, so times in it are not offered here. This list may
          be shorter than the diary really is.
        </p>
      ) : null}

      {proposals.length === 0 ? (
        <div>
          <p className="text-[12.5px] font-semibold text-navy">
            No suitable appointment found in the next {state.windowDays} days.
          </p>
          <p className="mt-1 text-[11.5px] leading-[1.45] text-ink">
            Nobody who can do {treatment} has free time at {state.siteName ?? "this site"} before{" "}
            {state.windowTo ? longDate(state.windowTo) : "then"}. Widen the dates, try another site, or
            ring the patient to agree a time.
          </p>
        </div>
      ) : (
        <ul className="space-y-1">
          {proposals.map((p) => (
            <li key={`${p.dayKey}-${p.startMin}-${p.practitionerId}`}>
              <button
                type="button"
                onClick={() => onPick(p)}
                className={cn(
                  "flex w-full items-baseline justify-between gap-2 rounded-md border border-line px-2.5 py-[6px] text-left transition-colors",
                  "hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                )}
              >
                <span className="min-w-0 truncate text-[12.5px] font-semibold tabular-nums text-navy">
                  {longDate(p.dayKey)} {labelMinutes(p.startMin)}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11.5px] font-medium text-muted">{p.practitionerName}</span>
                  {/* 'supervised' is a real level, not a rounding of 'can': a
                      foundation dentist doing extractions with a supervisor
                      present is a different thing to book. */}
                  {p.level === "supervised" ? (
                    <span className="rounded-[3px] border border-tint-amber-line bg-tint-amber px-1 text-[9.5px] font-semibold text-ink">
                      Supervised
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The reason breakdown is ALWAYS shown, not only when the list is empty. */}
      {state.breakdown ? (
        <p className="mt-2 text-[11px] leading-[1.45] text-muted">
          {breakdownSentence(state.breakdown, treatment)}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || widened}
          onClick={() => void load(30)}
          className="rounded-md border border-line-strong bg-card px-2.5 py-[5px] text-[11.5px] font-medium text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-40"
        >
          Look 30 days ahead
        </button>
        <span className="text-[11px] text-muted">
          To try another site, switch practice on the diary above.
        </span>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[11.5px] leading-[1.45] text-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
