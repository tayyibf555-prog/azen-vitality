import { CalendarPlus, Plus } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { CHART_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { canWriteChartToDentally } from "@/lib/charting/write-gate";
import { cn } from "@/lib/utils";
import type {
  PlanAppointmentGroup,
  PlanGroupTotals,
  PlanItemRow,
  PlanPanelViewModel,
  PlanUnassignedGroup,
} from "@/lib/charting/plan-panel-view";
import { DisabledControl } from "./disabled-control";
import { PlanCards } from "./plan-cards";
import { AppointmentCard, UnassignedItemsCard } from "./appointment-card";
import { PlanFooter } from "./plan-footer";

/**
 * THE TREATMENT PLAN PANEL: the working half of Dentally's charting screen.
 *
 * Everything above this on the tab is the arch, which is a picture. This is the part a
 * clinician actually operates during an appointment - the plan chip, the appointment
 * cards, the item rows, the totals and the five actions - and it is built to
 * PLAN-PANEL.md's reference layout, measured off the owner's full-resolution Dentally
 * screenshot rather than invented.
 *
 * =========================================================================
 * IT IS A READ-ONLY MIRROR, EXACTLY LIKE THE CHART ABOVE IT.
 * =========================================================================
 * Dentally publishes no create route on any charting resource: POST 404s on
 * treatment_plans, treatment_plan_items and treatment_appointments alike, there is no
 * PUT on treatment_plans, and nhs_claims is GET only. So every action control on this
 * panel is RENDERED, INERT AND EXPLAINED. Removing the ones we cannot fill would be
 * the worse failure: a Dentally user's hand goes to these positions without reading,
 * and an absence tells them the capability is gone rather than telling them where it
 * went. Nothing here calls a Dentally write path, and canWriteChartToDentally() is
 * read on every file that renders one of these controls so the day a route exists a
 * contributor is brought straight to them.
 *
 * =========================================================================
 * THE FINDING THAT SHAPES THE WHOLE PANEL.
 * =========================================================================
 * From a live probe of production on 2026-08-02: ONLY 17 OF 100 TREATMENT PLAN ITEMS
 * CARRY A treatment_appointment_id. 83% of a real patient's plan belongs to no
 * appointment card at all. Built as pure "Appt. 1 / Appt. 2" groups, most of that plan
 * silently vanishes and the screen still looks complete - the same failure class as
 * the blank surfaces and the unparsed Palmer teeth, both of which shipped on this
 * feature and were caught late. So the unassigned items are a card of their own,
 * counted, visually distinct, with the reason stated in writing, rendered whenever
 * there is one item in it. Never dropped, never folded into the first appointment.
 *
 * It follows that the unassigned card is NOT a rare branch: on live data it is the
 * commonest thing on this screen, and a reviewer who sees it should not read it as an
 * error state.
 *
 * =========================================================================
 * SERVER-SAFE, AND WITH NO CLIENT LEAF AT ALL.
 * =========================================================================
 * The brief allowed one small client leaf for collapse and expand. This uses native
 * <details> instead and therefore needs none: boundary.test.ts pins that
 * chart-workspace.tsx is the ONLY module in this directory carrying "use client", so a
 * second one would have to be argued for rather than assumed, and it would stop this
 * panel being renderable from a server component or from react-dom/server in vitest's
 * node environment. Native disclosure is also keyboard operable and announced without
 * anything being written for it.
 *
 * NO CLOCK IS READ ANYWHERE UNDER THIS PANEL. Every time printed comes from an ISO
 * instant Dentally sent. There is no Date.now(), no new Date() with no argument, and
 * no "x minutes ago": Dentally's own note row carries a "Last updated" line and the
 * payload gives us no timestamp for it, so it is omitted rather than filled with the
 * read time, which would put an unsupported age on a clinical note.
 *
 * MONEY IS PENCE ALL THE WAY IN, divided exactly once at the point of render, printed
 * tabular-nums, right aligned and to two decimals. A total rounded to the pound is a
 * figure a treatment coordinator quotes to a patient.
 */

// Re-exported so a consumer imports one module rather than reaching into the card.
// The types themselves now live in src/lib/charting/plan-panel-view.ts, which is the
// side of this seam vitest can reach and which owns the join that fills them.
export type {
  PlanAppointmentGroup,
  PlanItemRow,
  PlanGroupTotals,
  PlanPanelViewModel,
  PlanUnassignedGroup,
};

/**
 * The sentences this panel owns.
 *
 * PROVISIONAL LOCATION, as in the other two files of this pass: every other honesty
 * sentence on this screen lives in CHART_COPY in src/lib/patient/tabs.ts, where
 * tabs.test.ts sweeps it for British English and for em-dashes. Written to the same
 * standard; the integrator should move them across.
 */
export const PLAN_PANEL_COPY = {
  addAppointment:
    "Appointments are added to a treatment plan in Dentally. Dentally publishes no way for this platform to " +
    "create one, so this control is shown for reference and cannot act from here.",
  // Rendered only when the panel's own arithmetic says a row went missing between the
  // charting library and this screen. It is the sentence that stops a short table
  // being read as a complete plan.
  unbalanced:
    "Some lines on this treatment plan could not be placed on this screen, so what is shown below is " +
    "incomplete. Read this treatment plan in Dentally before relying on it.",
} as const;

export function PlanPanel({
  plan,
  /** True when the treatment plan read itself failed. A failed read is NOT an empty
   *  plan: "we could not read this patient's treatment plans" and "this patient has no
   *  treatment plans" are different clinical statements, and printing the second when
   *  the first is true tells a clinician that a patient with live planned treatment
   *  has none. */
  failed = false,
  /**
   * True when the treatment_plan_items stream failed on this read.
   *
   * SEPARATE FROM `failed`, which means the PLANS read failed and there is no panel
   * to draw at all. This one means the panel is real - Dentally gave us the plan and
   * its money - but the LINES under it could not be read, so the footer's Total
   * Price and Uncharged would be summed over nothing and print £0.00 beside a real
   * plan value. Threaded down from the read's per-stream health rather than guessed
   * from a zero total, because a plan genuinely worth nothing must still print its
   * real £0.00.
   */
  itemsFailed = false,
  /** The round + at the top left. DEFAULTS OFF, because the surrounding screen
   *  already renders one: plan-tabs.tsx, inside the workspace above this panel, has
   *  its own "New treatment plan" +, and two controls with the same purpose on one
   *  page is one too many - as would be two panels each rendering their own. It stays
   *  a prop rather than being deleted so this panel remains complete on its own. */
  showAddPlan = false,
  className,
}: {
  plan: PlanPanelViewModel | null;
  failed?: boolean;
  itemsFailed?: boolean;
  showAddPlan?: boolean;
  className?: string;
}) {
  // Read rather than assumed. write-gate.test.ts scans the source of every file in
  // this directory that renders a Dentally write control for exactly this call.
  const writeBlocked = !canWriteChartToDentally();

  if (failed) {
    return (
      <section className={cn("space-y-3", className)}>
        <p className="rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink">
          {FAILED_COPY.plans}
        </p>
      </section>
    );
  }

  if (plan === null) {
    // THE EMPTY STATE IS THE TWO CARDS, folded in rather than retired. They are
    // literally Dentally's own empty state for this area ("Add a treatment plan and
    // appointment", "Use a treatment plan template"), they carry the write-blocked
    // sentence the copy sweep and disabled-controls.test.ts both depend on, and they
    // are the correct thing to show a reader who has no plan to operate on.
    return (
      <section className={cn("space-y-3", className)}>
        <p className="text-[12px] text-faint">{EMPTY_COPY.plans}</p>
        <PlanCards />
      </section>
    );
  }

  const unassignedCount = plan.unassigned?.rows.length ?? 0;
  // EVERY DOM ID UNDER THIS PANEL HANGS OFF THIS. A patient with two treatment plans
  // renders two panels on one page, and duplicate ids would make every
  // aria-describedby in the second panel resolve to the first panel's sentence.
  const domId = plan.domId;

  return (
    <section aria-label="Treatment plan" className={cn("space-y-3", className)}>
      {/* THE HEADER: Dentally's blue + and, beside it, the plan chip. The chip carries
          the treatment_plan id because that is what Dentally prints there and it is
          the number a coordinator reads down the phone to reconcile against Dentally.
          The nickname sits beside it rather than replacing it: a nickname is editable
          in Dentally and two plans can share one, so it identifies nothing on its own. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {writeBlocked && showAddPlan ? (
          <DisabledControl
            id={`${domId}-add-plan`}
            label="New treatment plan"
            variant="round"
            icon={<Plus size={16} aria-hidden />}
            reason={CHART_COPY.writeBlockedTitle}
            hideReason
          />
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-card px-2.5 py-1">
          {/* THE SYNTHETIC PANEL HAS NO PLAN AND SAYS SO. charting-read.ts builds one
              to hold treatment whose treatment_plan_id is null or names a plan we did
              not receive; those rows would otherwise be dropped by the per-plan split.
              Printing an empty chip beside the word "Plan" would present them as
              belonging to a plan numbered nothing. */}
          {plan.synthetic ? (
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              No plan
            </span>
          ) : (
            <>
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                Plan
              </span>
              <span className="tabular-nums text-[13.5px] font-semibold tracking-[-0.1px] text-navy">
                {plan.id}
              </span>
            </>
          )}
          {plan.nickname ? (
            <span className="min-w-0 truncate text-[12.5px] text-muted">{plan.nickname}</span>
          ) : null}
          {plan.synthetic ? null : (
            <StatusPill tone={plan.completed ? "success" : "neutral"}>
              {plan.completed ? "Completed" : "Not completed"}
            </StatusPill>
          )}
        </div>
      </div>

      {/* The + is rendered with hideReason so the header stays one line, and its
          sentence is rendered here, full width, carrying the exact id its
          aria-describedby points at. Moved, never dropped and never shortened. */}
      {writeBlocked && showAddPlan ? (
        <p id={`${domId}-add-plan-reason`} className="text-[11px] leading-[1.45] text-faint">
          {CHART_COPY.writeBlockedTitle}
        </p>
      ) : null}

      {/* THE COUNT THAT PROVES THE SCREEN IS WHOLE. The view model flattens the
          charting library's one row-bearing field into cards and a bucket, which is
          the single place in this build where rows could go missing again; when the
          two counts disagree the panel says so at the top rather than presenting a
          short table as a plan. */}
      {plan.reconciliation.balanced ? null : (
        <p className="rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink">
          {PLAN_PANEL_COPY.unbalanced}
        </p>
      )}

      <div className="space-y-2.5">
        {plan.appointments.map((group) => (
          <AppointmentCard key={group.key} group={group} domId={`${domId}-appt-${group.key}`} />
        ))}

        {/* NOT AN EDGE CASE, AND NOT LAST BY ACCIDENT. It sits after the appointment
            cards because that is where a reader expects "and also these", and it is
            rendered whenever it holds a single item. On the live sample it holds 83 of
            every 100. */}
        {plan.unassigned && unassignedCount > 0 ? (
          <UnassignedItemsCard group={plan.unassigned} domId={`${domId}-unassigned`} />
        ) : null}
      </div>

      {/* Dentally's centred "add appointment" affordance, between the last card and
          the totals. Its sentence is rendered directly beneath it, so this one does
          not use hideReason at all. */}
      {writeBlocked ? (
        <div className="flex flex-col items-center gap-1 py-1 text-center">
          <DisabledControl
            id={`${domId}-add-appointment`}
            label="add appointment"
            icon={<CalendarPlus size={15} aria-hidden />}
            reason={PLAN_PANEL_COPY.addAppointment}
            reasonClassName="max-w-[62ch] text-center"
          />
        </div>
      ) : null}

      <PlanFooter
        domId={domId}
        itemsPricePence={plan.totals.itemsPricePence}
        unchargedPence={plan.totals.unchargedPence}
        privateTreatmentValuePence={plan.totals.privateTreatmentValuePence}
        nhsUdaHundredths={plan.totals.nhsUdaHundredths}
        nhsCompletedUdaHundredths={plan.totals.nhsCompletedUdaHundredths}
        itemsFailed={itemsFailed}
      />
    </section>
  );
}
