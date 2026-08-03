import { Plus, LayoutTemplate } from "lucide-react";
import { CHART_COPY } from "@/lib/patient/tabs";
import { canWriteChartToDentally } from "@/lib/charting/write-gate";
import { DisabledControl } from "./disabled-control";

/**
 * The two cards beneath the chart, in Dentally's own words, order and SHAPE.
 *
 * THE SHAPE IS THE POINT OF THIS PASS. DENTALLY.md: "Side by side, full width. Title
 * and one line of body on the left, the action button on the RIGHT edge of each card:
 * a solid blue New treatment plan, and an outline Select template." So each card is a
 * single horizontal band - text left, button hard against the right edge - not a
 * stacked title/body/button column. A Dentally user's hand goes to the right edge of
 * that band without reading, and moving the button under the text costs them that.
 *
 * The two cards are a two-column grid that fills the width beneath the arch, so they
 * sit on the same measure as the chart rather than in a narrower box of their own.
 *
 * SERVER-SAFE, DELIBERATELY. No "use client", no state, no function props, so
 * tab-chart.tsx (a server component) can render it directly. boundary.test.ts pins
 * that this file and chart-workspace are the only two things tab-chart may import
 * from this directory: every other leaf here attaches DOM handlers and would build
 * green and then throw when a server component rendered it.
 *
 * BOTH BUTTONS ARE RENDERED, NOT REMOVED. Dropping a card because we cannot fill it
 * is the failure PRODUCT.md names: a Dentally user comes to this exact position for
 * "New treatment plan" and an absence tells them the capability is gone. They go
 * through DisabledControl, so each carries a sentence a keyboard user can reach
 * rather than a title on an unfocusable control.
 *
 * ===========================================================================
 * SUPERSEDED AS A PERMANENT FIXTURE, FOLDED IN AS THE PLAN PANEL'S EMPTY STATE.
 * ===========================================================================
 * plan-panel.tsx now renders the working half of Dentally's charting screen - the
 * plan chip, the appointment cards, the item rows and the plan totals - which is
 * what these two cards were standing in for while there was nothing to show. They
 * are NOT deleted, and they are not retired to an unused file either:
 *
 *   - they are literally Dentally's own empty state for this area, so PlanPanel
 *     renders them when the patient has no treatment plan to operate on. A reader
 *     with no plan still needs "Add a treatment plan and appointment" in the
 *     position they expect it;
 *   - their two labels and the write-blocked sentence are load bearing elsewhere.
 *     write-gate.test.ts scans this directory for the labels "New treatment plan"
 *     and "Select template" and requires the gate beside them, and
 *     disabled-controls.test.ts imports PlanCards by name, renders it, and follows
 *     every aria-describedby to the sentence below. Deleting either would take
 *     three tests with it and remove a swept clinical sentence from the screen.
 *
 * So the only thing that changes is WHERE they are rendered from: PlanPanel, when
 * there is no plan, rather than unconditionally beneath the chart. When the panel is
 * wired in, tab-chart.tsx must stop rendering PlanCards directly or the two labels
 * and their DOM ids appear twice on one page.
 *
 * THE EXPLANATION SENTENCE IS CLINICAL-SAFETY COPY AND IS RENDERED IN FULL. Putting
 * the button on the right edge would squeeze that sentence into a column beside it,
 * so each card uses DisabledControl's `hideReason` and renders the sentence itself,
 * full width, beneath a hairline, carrying the exact `${id}-reason` id the control's
 * aria-describedby points at. plan-tabs.tsx does the same thing for the round +. The
 * sentence is MOVED, never dropped and never shortened.
 */
export function PlanCards() {
  // There is no create route on any Dentally charting resource, so this gate is false
  // unconditionally. It is READ here rather than assumed: the write-gate test scans
  // source for exactly this call on every file that renders a write control, and the
  // day a create route does exist a contributor is brought straight to these two
  // buttons instead of leaving them inert next to a working endpoint.
  const writeBlocked = !canWriteChartToDentally();

  return (
    <div className="grid w-full gap-4 sm:grid-cols-2">
      <PlanCard
        title="Add a treatment plan and appointment"
        body="Every treatment plan must have at least one appointment."
        controlId="chart-new-treatment-plan"
        writeBlocked={writeBlocked}
      >
        <DisabledControl
          id="chart-new-treatment-plan"
          label="New treatment plan"
          variant="primary"
          icon={<Plus size={15} aria-hidden />}
          reason={CHART_COPY.writeBlockedTitle}
          hideReason
        />
      </PlanCard>

      <PlanCard
        title="Use a treatment plan template"
        body={CHART_COPY.planTemplates}
        controlId="chart-select-plan-template"
        writeBlocked={writeBlocked}
      >
        <DisabledControl
          id="chart-select-plan-template"
          label="Select template"
          icon={<LayoutTemplate size={15} aria-hidden />}
          reason={CHART_COPY.writeBlockedTitle}
          hideReason
        />
      </PlanCard>
    </div>
  );
}

/**
 * One card: the band, then the sentence.
 *
 * `children` is the control rather than a prop-configured button because the two
 * cards want two different DisabledControl variants (solid primary, outline default)
 * and threading a variant through a wrapper only to hand it straight back is a second
 * place for the two to disagree.
 *
 * When the gate is open - which is not today, on any configuration - the band renders
 * with no control and the sentence is not rendered either. That is the loud failure
 * the previous version chose on purpose: an enabled create route needs a real handler,
 * which needs a client leaf, and a silently-inert button beside a working endpoint is
 * worse than an obviously missing one.
 */
function PlanCard({
  title,
  body,
  controlId,
  writeBlocked,
  children,
}: {
  title: string;
  body: string;
  /** The DOM id of the control inside, so the sentence below can carry `${id}-reason`. */
  controlId: string;
  writeBlocked: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-card-muted/40 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">{title}</h3>
          <p className="mt-0.5 text-[12.5px] leading-[1.45] text-muted">{body}</p>
        </div>
        {writeBlocked ? <div className="shrink-0">{children}</div> : null}
      </div>

      {writeBlocked ? (
        <p
          id={`${controlId}-reason`}
          className="mt-3 border-t border-line pt-2.5 text-[11.5px] leading-[1.5] text-faint"
        >
          {CHART_COPY.writeBlockedTitle}
        </p>
      ) : null}
    </section>
  );
}
