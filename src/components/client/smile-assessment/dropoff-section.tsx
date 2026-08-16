"use client";

import { useCallback, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { StepFunnel } from "@/lib/smile-assessment/step-events";
import { DropoffChart } from "./dropoff-chart";

// WHERE PEOPLE STOP, on the campaign card. The owner-facing half of A3: the
// guarded GET, one fetch, and the dumb chart.
//
// ON THE CARD, NOT ON A PAGE OF ITS OWN, and directly under the live preview of
// the funnel it measures. The card already answers "what is this assessment and is
// it running"; this answers "and is it working", about the very funnel the preview
// above it is showing. A separate analytics page would put the number and the thing
// it describes on two different screens.
//
// LAZY, AND THAT IS THE REASON IT IS A DISCLOSURE RATHER THAN A PANEL. The read is
// a paged scan (maxDuration 60 on the route), and this panel renders EVERY campaign
// a practice has. Fetching on mount would mean one scan per campaign on every visit
// to the page, for a number most visits are not about. Opened, it fetches once and
// keeps the answer.
//
// WHAT THE BARS MEAN ON A BRANCHING FUNNEL, said here because this is the surface
// somebody reads them on. Bar LENGTH is reachedPct — the share of the first
// screen's sessions still present — and that is exact for every screen, branch or
// no branch. The "% drop-off" chip between two bars is the loss between those two
// ORDINALS, which is a real transition on a straight funnel and, between two
// SIBLING branches at the same depth, is not: a session takes one of them, so the
// other legitimately shows a loss nobody suffered. The chip is still the honest
// reading of the rows the lib is given (aggregateStepEvents says so in as many
// words); the number to trust across branches is the bar.
//
// EVERY FAILURE IS SPOKEN. Especially the 503: on a deployment where migration
// 0080 has not been applied, the route answers with a sentence NAMING the file, and
// swallowing it here would leave an owner looking at "no sessions" — which reads as
// "nobody uses my funnel" rather than as "this has never been switched on". Same
// call the re-colour row makes for 0079.

interface DropOffResponse {
  ok?: boolean;
  error?: string;
  flowVersion?: number;
  truncated?: boolean;
  funnel?: StepFunnel;
  /** Absent when the route could not name the steps (an older flow version). */
  labels?: Record<number, string>;
  stepCount?: number;
}

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: DropOffResponse };

/** The window the route defaults to. Named here only so the caption can say it. */
const WINDOW_DAYS = 30;

export function DropoffSection({
  clientSlug,
  campaignSlug,
  flowVersion,
}: {
  clientSlug: string;
  campaignSlug: string;
  /** The funnel's current save, for the caption. The route defaults to it anyway. */
  flowVersion?: number;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "idle" });

  const fetchFunnel = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const res = await fetch(
        `/api/smile-assessment/campaign/${encodeURIComponent(campaignSlug)}/drop-off?client=${encodeURIComponent(clientSlug)}`,
        { headers: { accept: "application/json" } },
      );
      const data = (await res.json().catch(() => null)) as DropOffResponse | null;
      if (!res.ok || !data?.ok || !data.funnel) {
        setLoad({
          state: "error",
          // The route's own words when it has any — they are written for an owner
          // and the 503 names the migration.
          message: data?.error || `The drop-off report could not be loaded (${res.status}).`,
        });
        return;
      }
      setLoad({ state: "ready", data });
    } catch {
      setLoad({ state: "error", message: "The drop-off report could not be loaded." });
    }
  }, [campaignSlug, clientSlug]);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Once. Re-opening shows what was already read; the refresh control re-reads.
    if (next && load.state === "idle") void fetchFunnel();
  }

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-xs font-semibold text-navy transition-colors hover:text-blue-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <BarChart3 size={14} />
          Where people stop
        </button>
        {open ? (
          <span className="inline-flex items-center gap-2 text-[11px] text-faint">
            <span>
              Last {WINDOW_DAYS} days
              {typeof flowVersion === "number" ? ` · funnel v${flowVersion}` : ""}
            </span>
            <button
              type="button"
              onClick={() => void fetchFunnel()}
              disabled={load.state === "loading"}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-40"
            >
              {load.state === "loading" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              Refresh
            </button>
          </span>
        ) : null}
      </div>

      {open ? (
        <div className="mt-2">
          {load.state === "loading" || load.state === "idle" ? (
            <p className="rounded-[10px] border border-line bg-card px-4 py-6 text-center text-sm text-muted">
              <Loader2 size={14} className="mr-1.5 inline animate-spin align-[-2px]" />
              Reading the funnel…
            </p>
          ) : load.state === "error" ? (
            // VERBATIM, not summarised: the one failure this path really has is
            // "0080 has not been applied on this deployment", and the route says
            // exactly that, naming the file.
            <p className="rounded-[10px] border border-warning/25 bg-warning/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-status-amber">
              {load.message}
            </p>
          ) : (
            <DropoffChart
              funnel={load.data.funnel!}
              labels={load.data.labels}
              truncated={load.data.truncated}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
