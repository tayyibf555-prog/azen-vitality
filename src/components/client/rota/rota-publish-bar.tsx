"use client";

import { AlertTriangle, CheckCircle2, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PrePublishSummary } from "@/lib/rota/publish";
import { weekRangeLabel } from "./shared";

// ---------------------------------------------------------------------------
// The Publish control, and the summary that has to be read before it is pressed.
//
// PUBLISHING TEXTS REAL PHONES. So this never renders a bare button: it renders
// what pressing it will do -- how many shifts, how many differ from what people
// were last told, and how many are rostered on somebody's agreed time off -- and
// only then the button. The counts come from `summarisePrePublish`, a tested pure
// function, not from `.filter()` calls in this file.
//
// THREE STATES THIS REFUSES TO HIDE:
//   * the kill switch is off  -> the button is disabled and SAYS SO. A control that
//     looks live and fails on press reads as a broken screen rather than a locked one.
//   * MESSAGING_DRY_RUN is on -> the button says "Publish (simulated)". A manager
//     must never believe the team was texted when nothing left the building.
//   * nothing has changed     -> the button still works (a deliberate re-send is a
//     real need) but the copy says nobody will be told anything new.
// ---------------------------------------------------------------------------

export interface PublishState {
  summary: PrePublishSummary;
  canPublish: boolean;
  dryRun: boolean;
  lastPublishedAt: string | null;
}

function Figure({ value, label, tone = "plain" }: { value: number; label: string; tone?: "plain" | "warn" }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className={
          tone === "warn"
            ? "text-sm font-semibold tabular-nums text-amber-700"
            : "text-sm font-semibold tabular-nums text-navy"
        }
      >
        {value}
      </span>
      <span className="text-xs text-muted">{label}</span>
    </span>
  );
}

export function RotaPublishBar({
  weekStart,
  state,
  busy,
  result,
  error,
  onPublish,
}: {
  weekStart: string;
  /** Null while the summary is still loading, so the button never appears before its warnings. */
  state: PublishState | null;
  busy: boolean;
  result: string | null;
  error: string | null;
  onPublish: () => void;
}) {
  if (!state) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-card-muted/30 px-3 py-2.5 text-xs text-muted">
        <Loader2 size={14} className="animate-spin" />
        Working out what publishing would send...
      </div>
    );
  }

  const { summary, canPublish, dryRun, lastPublishedAt } = state;
  const nothingToSay = !summary.firstPublish && summary.changeCount === 0;

  return (
    <div className="rounded-xl border border-line bg-card-muted/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-navy">
            {summary.firstPublish
              ? `Publish ${weekRangeLabel(weekStart)}`
              : `Version ${summary.version} of ${weekRangeLabel(weekStart)}`}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Figure value={summary.shiftCount} label={summary.shiftCount === 1 ? "shift" : "shifts"} />
            <Figure value={summary.staffCount} label={summary.staffCount === 1 ? "person" : "people"} />
            <Figure
              value={summary.changeCount}
              label={summary.firstPublish ? "to send" : "changed since last time"}
            />
            {summary.conflicts.length > 0 ? (
              <Figure value={summary.conflicts.length} label="on agreed time off" tone="warn" />
            ) : null}
          </p>
        </div>

        <Button variant="primary" size="sm" onClick={onPublish} disabled={busy || !canPublish}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          {dryRun ? "Publish (simulated)" : "Publish and tell staff"}
        </Button>
      </div>

      {!canPublish ? (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-line-strong bg-card px-3 py-2 text-xs text-ink">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          Staff rota is switched off in System controls, so nothing can be published. Nobody would be
          told about it. Turn it back on there first.
        </p>
      ) : null}

      {canPublish && dryRun ? (
        <p className="mt-2 rounded-lg border border-line-strong bg-card px-3 py-2 text-xs text-ink">
          Messages are in simulation while the practice is being set up. Publishing records the version
          and shows you exactly who would be told, and no text or email leaves the building.
        </p>
      ) : null}

      {canPublish && !dryRun && summary.conflicts.length > 0 ? (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {summary.conflicts.length === 1
            ? "One shift is on a day that person has agreed off."
            : `${summary.conflicts.length} shifts are on days those people have agreed off.`}{" "}
          Publishing tells them they are working. Check that is what you mean.
        </p>
      ) : null}

      {canPublish && nothingToSay ? (
        <p className="mt-2 text-xs text-muted">
          Nothing has changed since version {summary.version - 1}. Publishing again records a new
          version and tells nobody, unless you have changed something they need to know.
        </p>
      ) : null}

      {lastPublishedAt ? (
        <p className="mt-2 text-[11px] text-muted">
          Last published {new Date(lastPublishedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}.
        </p>
      ) : null}

      {result ? (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-xs text-success">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          {result}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
