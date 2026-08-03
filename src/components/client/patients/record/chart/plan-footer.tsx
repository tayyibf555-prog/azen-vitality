import { CreditCard, ReceiptText, CircleCheck } from "lucide-react";
import { CHART_COPY } from "@/lib/patient/tabs";
import { canWriteChartToDentally } from "@/lib/charting/write-gate";
import { cn, gbp } from "@/lib/utils";
import { DisabledControl } from "./disabled-control";

/**
 * The bar under the last appointment card: the plan's money on the left, the three
 * plan-level actions on the right, and the sentence for each of them beneath.
 *
 * THE MONEY IS THE POINT OF THE LEFT HALF. Dentally puts Total Price and Uncharged
 * here and a treatment coordinator reads those two figures before anything else on
 * the screen, so they are rendered as a real pair of figures - tabular-nums, right
 * aligned, two decimals, never rounded to the pound - and not as a muted caption.
 *
 * UNCHARGED IS RENDERED EVEN WHEN IT IS ZERO, and even when it equals the total.
 * PLAN-PANEL.md:71 records that `charged` came back false on all 100 live items
 * sampled, so in practice Uncharged WILL equal Total Price on a real patient. That is
 * the data, not a bug, and hiding the line when it looks uninteresting would remove
 * the one figure that says so.
 *
 * ALL THREE ACTIONS ARE RENDERED AND ALL THREE ARE INERT. A Dentally user's hand goes
 * to this row without reading it; an absence tells them the capability is gone, while
 * an inert control with a sentence tells them where it went. They go through
 * DisabledControl, so each stays FOCUSABLE with aria-disabled and points
 * aria-describedby at a sentence that is actually on the screen, rather than being a
 * `disabled` button carrying a title a keyboard user can never reach.
 *
 * CHARGE HAS ITS OWN SENTENCE AND ITS OWN REASON FOR BEING OFF, and that separation is
 * deliberate. The other two are blocked because Dentally exposes no route. Charge is
 * blocked because it MOVES MONEY, and PLAN-PANEL.md:88 is explicit that it stays off
 * even if a route is found, until the practice owner signs it off in writing and
 * separately from charting. Giving it the same generic sentence as the others would
 * invite the next contributor to switch all three on together the day an endpoint
 * appears.
 *
 * SERVER-SAFE. No "use client", no state, no handlers, no function props, so this
 * renders inside a server component and inside react-dom/server in the node test
 * environment. boundary.test.ts pins that the workspace is the only client module in
 * this directory.
 */

/**
 * The two sentences this bar owns.
 *
 * PROVISIONAL LOCATION. Every other clinical-honesty sentence on this screen lives in
 * CHART_COPY in src/lib/patient/tabs.ts, where tabs.test.ts sweeps it for British
 * English and for em-dashes. These two are here only because this pass does not own
 * that file; they are written to the same standard and the integrator should move them
 * across so they are swept like the rest. Until then they are exported, so a test can
 * still reach them by name rather than by matching a string inside JSX.
 */
export const PLAN_FOOTER_COPY = {
  // NOT the generic write-blocked sentence. This control is off for a commercial
  // reason that survives any API change, and the sentence has to say so.
  charge:
    "Taking a payment moves money, so it does not act from this screen. It stays switched off until the " +
    "practice owner signs it off in writing, separately from charting. Charge this treatment plan in Dentally.",
  submitClaim:
    "NHS claims are submitted in Dentally. The claims connection we have can only be read from, so a claim " +
    "cannot be sent from here.",
  /**
   * THE FIGURES THAT ARE NOT PRINTED WHEN THE LINES COULD NOT BE READ.
   *
   * Total Price and Uncharged are summed from the treatment plan lines. When that
   * stream fails there are no lines, and the sums came out as a confident
   * "£0.00 / £0.00" sitting beside a real private plan value - a positive claim that
   * this plan is worth nothing, made out of a failed read. That is the mistake this
   * file's own comment calls the house's oldest, printed by the very bar that warns
   * against it. The plan's own figures, which come from a different stream, are
   * still shown beside this sentence.
   */
  itemsFailed:
    "The treatment plan lines could not be read from Dentally just now, so this plan's total and uncharged " +
    "figures cannot be worked out. This is a connection problem, not a plan worth nothing.",
} as const;

/** A figure Dentally did not send. NOT "£0.00", which is a claim that the plan is
 *  worth nothing, and not a blank, which reads as a rendering fault. */
const NOT_GIVEN = "Not given by Dentally";

/** Hundredths of a UDA as a plain decimal. NO POUND SIGN ANYWHERE NEAR IT: a UDA is
 *  a unit of activity, and printing 3 UDAs as "£3.00" would be a claim about a claim. */
function uda(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}

export function PlanFooter({
  domId,
  itemsPricePence,
  unchargedPence,
  privateTreatmentValuePence,
  nhsUdaHundredths,
  nhsCompletedUdaHundredths,
  itemsFailed = false,
  className,
}: {
  /**
   * The DOM id prefix, REQUIRED. A patient with two treatment plans renders two of
   * these bars on one page; with fixed ids the second bar's three controls would all
   * point their aria-describedby at the FIRST bar's sentences, and a screen-reader
   * user would be told about the wrong plan while the page looked perfect.
   */
  domId: string;
  /**
   * Pence, summed from the rows ON SCREEN by the charting library, so this figure
   * always equals what a reader can count above it. It is deliberately not
   * Dentally's own plan value, which is a different claim and is printed separately
   * below rather than silently substituted.
   */
  itemsPricePence: number;
  /** Pence. Zero is a figure, not an absence, and is rendered as one. */
  unchargedPence: number;
  /** treatment_plan.private_treatment_value, in pence. NULL when Dentally sent none. */
  privateTreatmentValuePence: number | null;
  /** HUNDREDTHS of a UDA, not pence. Null when Dentally sent none. */
  nhsUdaHundredths: number | null;
  nhsCompletedUdaHundredths: number | null;
  /**
   * True when the treatment_plan_items stream failed on this read.
   *
   * The two figures on the left are OUR arithmetic over the lines on screen, so a
   * failed lines read makes them both zero - and a zero on a money line is a claim,
   * not a blank. It is threaded down from the read's per-stream health rather than
   * inferred from `itemsPricePence === 0`, because a genuinely zero-value plan is a
   * real and ordinary thing and must keep printing its real £0.00.
   */
  itemsFailed?: boolean;
  className?: string;
}) {
  // Read rather than assumed, for the same reason plan-cards.tsx reads it: the
  // write-gate test scans the source of every file in this directory that renders a
  // write control, and the day a route does exist a contributor is brought straight
  // here instead of finding three inert buttons beside a working endpoint.
  const writeBlocked = !canWriteChartToDentally();

  return (
    <div className={cn("rounded-xl border border-line bg-card", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-4 py-3">
        {/* THE FIGURES, as a definition list rather than two spans: a screen reader
            then reads "Total price, ninety pounds" instead of two loose numbers. */}
        <dl className="flex flex-wrap items-end gap-x-7 gap-y-2">
          {/* SUPPRESSED, NOT ZEROED, WHEN THE LINES COULD NOT BE READ. Both figures
              are summed from the rows above; with no rows they came out as a
              confident £0.00 beside a real plan value, which is a positive claim
              about what a patient owes derived entirely from a failed read. The
              labels stay so the bar keeps its shape, and the sentence beneath says
              which read failed. */}
          {itemsFailed ? (
            <div className="max-w-[60ch]">
              <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                Total Price and Uncharged
              </dt>
              <dd className="mt-0.5 text-[11.5px] font-medium leading-[1.5] text-faint">
                {PLAN_FOOTER_COPY.itemsFailed}
              </dd>
            </div>
          ) : (
            <>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  Total Price
                </dt>
                <dd className="mt-0.5 text-right text-[17px] font-semibold tabular-nums tracking-[-0.2px] text-navy">
                  {gbp(itemsPricePence / 100, { decimals: true })}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  Uncharged
                </dt>
                <dd className="mt-0.5 text-right text-[17px] font-semibold tabular-nums tracking-[-0.2px] text-navy">
                  {gbp(unchargedPence / 100, { decimals: true })}
                </dd>
              </div>
            </>
          )}

          {/* DENTALLY'S OWN FIGURES, BESIDE OURS AND NEVER INSTEAD OF THEM.
              treatment_plan.private_treatment_value is the practice's recorded value
              for the plan; the Total Price above is the sum of the lines we could
              show. They should agree, and when they do not, the disagreement is the
              information: substituting one for the other would hide exactly the case
              where the panel is missing a line. A value Dentally did not send prints
              as words, never as £0.00. */}
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
              Private plan value
            </dt>
            <dd
              className={cn(
                "mt-0.5 text-right tabular-nums",
                privateTreatmentValuePence === null
                  ? "text-[12px] font-medium tabular-nums text-faint"
                  : "text-[17px] font-semibold tracking-[-0.2px] text-navy",
              )}
            >
              {privateTreatmentValuePence === null
                ? NOT_GIVEN
                : gbp(privateTreatmentValuePence / 100, { decimals: true })}
            </dd>
          </div>

          {/* UDA, WITHOUT A POUND SIGN, and shown only when Dentally sent one of the
              two. A wholly private plan legitimately has neither, and a permanent
              "NHS UDA: not given" on every private plan is a caveat a reader learns
              to skip past, which is how the ones that matter stop being read. */}
          {nhsUdaHundredths !== null || nhsCompletedUdaHundredths !== null ? (
            <>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  NHS UDA
                </dt>
                <dd className="mt-0.5 text-right text-[15px] font-semibold tabular-nums tracking-[-0.2px] text-navy">
                  {nhsUdaHundredths === null ? NOT_GIVEN : uda(nhsUdaHundredths)}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
                  UDA completed
                </dt>
                <dd className="mt-0.5 text-right text-[15px] font-semibold tabular-nums tracking-[-0.2px] text-navy">
                  {nhsCompletedUdaHundredths === null ? NOT_GIVEN : uda(nhsCompletedUdaHundredths)}
                </dd>
              </div>
            </>
          ) : null}
        </dl>

        {writeBlocked ? (
          <div className="flex flex-wrap items-center gap-2">
            <DisabledControl
              id={`${domId}-charge`}
              label="Charge"
              variant="primary"
              icon={<CreditCard size={15} aria-hidden />}
              reason={PLAN_FOOTER_COPY.charge}
              hideReason
            />
            <DisabledControl
              id={`${domId}-complete`}
              label="Complete treatment plan"
              icon={<CircleCheck size={15} aria-hidden />}
              reason={CHART_COPY.writeBlockedTitle}
              hideReason
            />
            <DisabledControl
              id={`${domId}-submit-claim`}
              label="Submit claim"
              icon={<ReceiptText size={15} aria-hidden />}
              reason={PLAN_FOOTER_COPY.submitClaim}
              hideReason
            />
          </div>
        ) : null}
      </div>

      {/* THE THREE SENTENCES, rendered in full and never shortened.
          Each control above uses `hideReason` because a full clinical and commercial
          safety sentence cannot sit beside a button in a row, so the sentence is MOVED
          here, under a hairline, carrying the exact `${id}-reason` id the control's
          aria-describedby already points at. Delete one of these paragraphs and the
          control looks perfect while telling a screen-reader user nothing at all;
          disabled-controls.test.ts renders this and resolves every one of those ids. */}
      {writeBlocked ? (
        <div className="space-y-1.5 border-t border-line px-4 py-2.5">
          <p id={`${domId}-charge-reason`} className="text-[11.5px] leading-[1.5] text-faint">
            {PLAN_FOOTER_COPY.charge}
          </p>
          <p id={`${domId}-complete-reason`} className="text-[11.5px] leading-[1.5] text-faint">
            {CHART_COPY.writeBlockedTitle}
          </p>
          <p id={`${domId}-submit-claim-reason`} className="text-[11.5px] leading-[1.5] text-faint">
            {PLAN_FOOTER_COPY.submitClaim}
          </p>
        </div>
      ) : null}
    </div>
  );
}
