import { Plus } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { CHART_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { canWriteChartToDentally } from "@/lib/charting/write-gate";
import type { ChartReadHealth, PlanRow } from "@/lib/charting/types";
import { cn } from "@/lib/utils";
import { DisabledControl } from "./disabled-control";

/**
 * Bottom left of the chart: Dentally's round blue + that creates a treatment plan,
 * then one tab per open plan. Completed plans live in History, as the reference does
 * it, and this strip says so rather than dropping them without a word.
 *
 * THE + IS BLOCKED AND THE TABS ARE LIVE, and the distinction is the whole point of
 * this file. Creating a plan is a WRITE and Dentally publishes no create route, so
 * the + goes through DisabledControl. Selecting a plan is a READ: it filters the arch
 * and the history to that plan, which is exactly what a clinician reconciling against
 * Dentally needs, and nothing about it touches Dentally.
 *
 * A FAILED PLANS READ IS NOT AN EMPTY PLAN STRIP. The plans read is its own stream
 * with its own health key precisely so "we could not read the plans" and "this
 * patient has no treatment plans" can be told apart: they are different clinical
 * statements, and rendering the first as the second would tell a clinician that a
 * patient with a live plan has none.
 */

const STATUS_LABEL: Record<PlanRow["status"], string> = {
  accepted: "Accepted",
  unaccepted: "Not accepted",
  completed: "Completed",
};

export function PlanTabs({
  plans,
  activePlanId,
  onSelectPlan,
  health,
  itemCountFor,
  className,
}: {
  plans: PlanRow[];
  /** null means "every plan", which is the unfiltered chart. */
  activePlanId: string | null;
  onSelectPlan: (planId: string | null) => void;
  health: ChartReadHealth;
  /** Items on a plan, so a tab carries a figure and not just a name. */
  itemCountFor?: (planId: string) => number;
  className?: string;
}) {
  // Read for the same reason plan-cards reads it: the write-gate test scans source for
  // this call on every file rendering a write control, and no configuration can turn
  // it on because the endpoint does not exist.
  const writeBlocked = !canWriteChartToDentally();
  const failed = health.plans === "failed";
  const open = plans.filter((p) => p.status !== "completed");
  const completed = plans.filter((p) => p.status === "completed");

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-end gap-3">
        {writeBlocked ? (
          <DisabledControl
            id="chart-new-plan-plus"
            label="New treatment plan"
            variant="round"
            icon={<Plus size={16} aria-hidden />}
            reason={CHART_COPY.writeBlockedTitle}
            hideReason
            className="mb-[3px]"
          />
        ) : null}

        {failed ? null : (
          <nav aria-label="Treatment plans" className="min-w-0 flex-1 border-b border-line">
            <ul className="-mb-px flex gap-0.5 overflow-x-auto">
              <li className="shrink-0">
                <button
                  type="button"
                  aria-pressed={activePlanId === null}
                  onClick={() => onSelectPlan(null)}
                  className={cn(
                    "inline-block border-b-2 px-3 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                    activePlanId === null
                      ? "border-navy font-semibold text-navy"
                      : "border-transparent text-muted hover:border-line-strong hover:text-navy",
                  )}
                >
                  All plans
                </button>
              </li>
              {open.map((plan) => {
                const active = plan.id === activePlanId;
                const count = itemCountFor?.(plan.id);
                return (
                  <li key={plan.id} className="shrink-0">
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => onSelectPlan(active ? null : plan.id)}
                      className={cn(
                        "inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                        active
                          ? "border-navy font-semibold text-navy"
                          : "border-transparent text-muted hover:border-line-strong hover:text-navy",
                      )}
                    >
                      <span className="max-w-[190px] truncate">{plan.label}</span>
                      {/* The status is on the tab, not behind it: an item drawn from a
                          plan the patient never accepted must not be read as planned
                          treatment, and the tab is where that is cheapest to say. */}
                      <StatusPill tone={plan.status === "unaccepted" ? "neutral" : "info"}>
                        {STATUS_LABEL[plan.status]}
                      </StatusPill>
                      {typeof count === "number" ? (
                        <span className="tabular-nums text-[11px] text-faint">{count}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>

      {/* The + is rendered with hideReason, so its sentence is rendered HERE, under the
          strip where there is room for it, carrying the id its aria-describedby points
          at. The explanation is never dropped, only moved. */}
      {writeBlocked ? (
        <p id="chart-new-plan-plus-reason" className="text-[11px] leading-[1.45] text-faint">
          {CHART_COPY.writeBlockedTitle}
        </p>
      ) : null}

      {failed ? (
        <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] text-ink">
          {FAILED_COPY.plans}
        </p>
      ) : plans.length === 0 ? (
        <p className="text-[11.5px] text-faint">{EMPTY_COPY.plans}</p>
      ) : completed.length > 0 ? (
        <p className="text-[11.5px] text-faint">
          {completed.length} completed{" "}
          {completed.length === 1 ? "plan is" : "plans are"} in History, as they are in Dentally.
        </p>
      ) : null}
    </div>
  );
}
