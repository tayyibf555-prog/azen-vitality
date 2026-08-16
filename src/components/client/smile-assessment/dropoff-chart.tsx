import type { StepFunnel } from "@/lib/smile-assessment/step-events";
import { cn } from "@/lib/utils";

// THE DROP-OFF CHART: one horizontal bar per funnel step, with the loss between
// each pair of consecutive steps called out between them.
//
// DUMB, AND STRUCTURALLY SO. No state, no effects, no fetch, nothing focusable and
// no "use client" — every number on screen was computed by aggregateStepEvents and
// rounded there, so this file does no arithmetic that could disagree with the API,
// the CSV or the next surface to render the same funnel. It takes plain data (no
// function props), so a server component can render it directly without the file
// becoming a client boundary.
//
// MOUNTED BY dropoff-section.tsx, on the campaign card, under the live preview of
// the very funnel it measures. That component owns the fetch, the disclosure and
// every failure state (including the 503 that names migration 0080); this file
// owns nothing but the drawing, which is why it can stay free of "use client".
//
// HORIZONTAL, NOT VERTICAL, and that is a legibility decision rather than taste: a
// step's label is a sentence ("Which treatment are you interested in?"), and
// sentences do not fit under a vertical bar. Bar LENGTH is reachedPct — the share
// of the first step's sessions still present — so the bars form the funnel shape
// an owner is looking for, and the loss between two of them is stated as its own
// number rather than left to be eyeballed from the gap.
//
// COLOUR COMES FROM TOKENS ONLY. No hex anywhere: this can end up inside a
// paletteVars wrapper (as the phone strip does), and a literal would be the one
// element that ignored the scheme.

export interface DropoffChartProps {
  funnel: StepFunnel;
  /**
   * What to call each step, keyed by its ordinal. Optional and plain data — a
   * Record rather than a callback, so this component can be rendered from a server
   * component without turning into a client boundary. A step with no label falls
   * back to "Step N", which is honest: the ordinal is what was recorded.
   */
  labels?: Record<number, string>;
  /** Shown when the scan hit its ceiling, so a partial tally never reads as a whole one. */
  truncated?: boolean;
  className?: string;
}

/** A step with no rows still gets a hairline, or the row reads as a missing row. */
const MIN_BAR_PCT = 0.6;

function stepLabel(stepIndex: number, labels?: Record<number, string>): string {
  const given = labels?.[stepIndex];
  return given && given.trim() !== "" ? given : `Step ${stepIndex + 1}`;
}

export function DropoffChart({ funnel, labels, truncated, className }: DropoffChartProps) {
  if (funnel.steps.length === 0) {
    // AN EMPTY FUNNEL IS "nobody has been here yet", NOT "0% of people finished".
    // The route answers 503 when the table is missing, so this state means exactly
    // what it says and can be worded plainly.
    return (
      <div
        className={cn(
          "rounded-[10px] border border-line bg-card px-4 py-6 text-center text-sm text-muted",
          className,
        )}
      >
        No one has reached a step of this funnel yet.
      </div>
    );
  }

  return (
    <div className={cn("rounded-[10px] border border-line bg-card p-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold text-navy">Where people stop</h3>
        <p className="text-xs text-muted">
          <span className="font-semibold text-ink">{funnel.sessions}</span>{" "}
          {funnel.sessions === 1 ? "session" : "sessions"}
          {funnel.completionPct !== null ? (
            <>
              {" · "}
              <span className="font-semibold text-blue-deep">{funnel.completionPct}%</span> reached
              the last step
            </>
          ) : null}
        </p>
      </div>

      <ol className="mt-3 space-y-0">
        {funnel.steps.map((step) => (
          <li key={step.stepIndex}>
            {/* The loss coming INTO this step. null on the first step, and whenever
                the step before it had no sessions — "100% of nobody" is not a fact,
                and the lib returns null rather than 0 for exactly that reason. */}
            {step.dropOffPct !== null ? (
              <div className="flex items-center gap-2 py-1 pl-1">
                <span aria-hidden className="h-4 w-px shrink-0 bg-line-strong" />
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    step.dropOffPct > 0
                      ? "bg-tint-royal text-status-royal"
                      : "bg-card-muted text-faint",
                  )}
                >
                  {step.dropOffPct > 0 ? `${step.dropOffPct}% drop-off` : "no drop-off"}
                </span>
              </div>
            ) : null}

            <div className="rounded-[8px] px-1 py-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-xs font-medium text-ink">
                  {stepLabel(step.stepIndex, labels)}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  <span className="font-semibold text-navy">{step.views}</span> · {step.reachedPct}%
                </span>
              </div>
              {/* The bar. Decorative — every number it encodes is already written
                  beside it in text, so a screen reader is told nothing twice. */}
              <div
                aria-hidden
                className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-card-muted"
              >
                <div
                  className="h-full rounded-full bg-blue-dark"
                  style={{ width: `${Math.max(MIN_BAR_PCT, step.reachedPct)}%` }}
                />
              </div>
            </div>
          </li>
        ))}
      </ol>

      {truncated ? (
        <p className="mt-3 border-t border-line pt-2 text-[11px] text-faint">
          This funnel is based on the most recent events only — there were more than one
          report&rsquo;s worth in this period.
        </p>
      ) : null}
    </div>
  );
}
