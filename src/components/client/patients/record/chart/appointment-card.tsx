import { ChevronRight, FileText, Mic, MoreVertical, PencilLine } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { CHART_COPY } from "@/lib/patient/tabs";
import { canWriteChartToDentally } from "@/lib/charting/write-gate";
import { FUNDING_LABEL } from "@/lib/calendar/funding";
import {
  PRACTITIONER_UNRESOLVED_EXPLANATION,
  PRACTITIONER_UNRESOLVED_MARK,
  UNASSIGNED_LABEL,
  unreadableFiguresNote,
} from "@/lib/charting/plan-panel-view";
import type {
  PlanAppointmentGroup,
  PlanGroupTotals,
  PlanItemRow,
  PlanUnassignedGroup,
} from "@/lib/charting/plan-panel-view";
import { londonDateLabel, londonDateTimeLabel } from "@/lib/time/london";
import { cn, gbp } from "@/lib/utils";

/**
 * One card of the treatment plan: an appointment's header, its note, its item rows and
 * its own duration and price totals. And, in the same shape, the group of items that
 * belong to NO appointment at all.
 *
 * ================================================================
 * THE UNASSIGNED GROUP IS THE REASON THIS FILE HAS TWO VARIANTS.
 * ================================================================
 * PLAN-PANEL.md:60 records a live probe of production: only 17 of 100 treatment plan
 * items carry a treatment_appointment_id. 83% of a real patient's plan belongs to no
 * appointment card. Built as pure "Appt. 1 / Appt. 2" groups, most of that plan
 * silently disappears AND THE SCREEN STILL LOOKS COMPLETE, which is the same failure
 * class as the blank surfaces and the unparsed Palmer teeth that both shipped on this
 * feature and were caught late. So the unassigned items get their own card, in the
 * same shape as the others so they are read the same way, visually distinct so they
 * are not mistaken for booked work, counted, and carrying the reason in writing. They
 * are never dropped and never folded into the first appointment: a line shown under an
 * appointment it does not belong to reads as work that has been booked.
 *
 * COLLAPSE IS NATIVE <details>, WITH NO JAVASCRIPT AT ALL. The brief asked for the
 * interactivity to be isolated into one small client leaf; a <details> element is
 * strictly better than that, because it needs no leaf. boundary.test.ts pins that
 * chart-workspace.tsx is the ONLY module in this directory carrying "use client", so a
 * second client file here would have to be argued for rather than assumed, and this
 * card would stop being renderable from a server component or from react-dom/server in
 * the node test environment. Native disclosure also arrives keyboard operable and
 * announced, which a hand-rolled toggle would have to earn.
 *
 * THE TWO CONTROLS THAT ARE NOT INSIDE THE <summary> ARE OUTSIDE IT ON PURPOSE. A
 * click anywhere inside a summary toggles the disclosure, so the card's overflow
 * affordance and every row's completed checkbox are positioned OVER the header and the
 * row instead of nested in them. Space is reserved for them with padding rather than
 * taken from the columns, because a Dentally user's eye goes to fixed columns and
 * moving one costs them that.
 *
 * NOTHING HERE WRITES. There is no create route on any Dentally charting resource, so
 * every affordance that would author charting is rendered, inert and explained.
 */

// ---------------------------------------------------------------------------
// THE SHAPE THIS CARD RENDERS — now imported, not declared.
//
// These four types were written provisionally here during the parallel build, from
// PLAN-PANEL.md's verified data model, because the module that owns them did not yet
// exist. They now live in src/lib/charting/plan-panel-view.ts, which is a .ts and so
// is the only side of this seam vitest can reach, and which also owns the JOIN that
// fills them: a ChartItem has no name, no tooth label, no practitioner name and no
// date column, and every one of those cells is a decision that has to be asserted
// somewhere a test can see it.
//
// They are re-exported below, unchanged, so nothing that already imports them from
// this file breaks.
//
// MONEY IS PENCE, EVERYWHERE, and it is divided exactly once, at render. A field that
// is "pounds here and pence there" is how a plan total ends up a hundred times wrong
// on a screen a coordinator quotes from.
// ---------------------------------------------------------------------------

export type { PlanAppointmentGroup, PlanGroupTotals, PlanItemRow, PlanUnassignedGroup };

/**
 * The sentences this card owns.
 *
 * PROVISIONAL LOCATION, exactly as in plan-footer.tsx: every other honesty sentence on
 * this screen lives in CHART_COPY in src/lib/patient/tabs.ts where tabs.test.ts sweeps
 * it for British English and for em-dashes. These are written to that standard and
 * should be moved across at integration. Exported so a test can reach them by name
 * rather than by matching a string inside JSX.
 */
export const APPOINTMENT_CARD_COPY = {
  // THE MOST IMPORTANT SENTENCE ON THIS SCREEN. It is what stops a reader concluding
  // that a plan with three booked items is the whole of the plan.
  unassigned:
    "Dentally returns most treatment plan items with no appointment against them, so these lines belong to " +
    "this treatment plan but to none of the appointments above. They are shown here in full, counted, rather " +
    "than folded into the first appointment, because a line shown under an appointment it does not belong to " +
    "reads as work that has been booked.",
  // THE FALLBACK ONLY. charting-read.ts resolves each card against the diary and
  // returns a sentence saying WHICH of four things went wrong - never booked, the
  // diary read failed, a dangling appointment id it names so it can be looked up by
  // hand, or an appointment carrying no start time. Those are different statements to
  // a clinician, and `group.unresolvedReason` carries whichever one is true. This line
  // is used only when the read gave none at all, so that a card is never headed by a
  // blank space where a date belongs.
  noLinkedAppointment:
    "This appointment is not linked to a diary appointment, so there is no date, time or practitioner to show " +
    "for it.",
  noNote: "There is no note on this appointment in Dentally.",
} as const;

/** The ONE column definition, shared by every row and by the card's own totals line,
 *  so a total sits exactly under the column it totals. Written out in full rather than
 *  composed at runtime: Tailwind v4 scans RAW SOURCE, and an interpolated arbitrary
 *  value produces no CSS at all. */
const ROW_GRID =
  "grid grid-cols-[18px_96px_58px_minmax(0,1fr)_36px_70px_56px_84px] items-center gap-x-2";

export function AppointmentCard({
  group,
  /** Stable DOM id prefix. Every id inside this card is built from it, so two cards on
   *  one screen never collide and every aria-describedby resolves inside this card. */
  domId,
  className,
}: {
  group: PlanAppointmentGroup;
  domId: string;
  className?: string;
}) {
  const appointmentNumber = group.position === null ? null : group.position + 1;
  const linked = group.appointmentId !== null && group.startsAtIso !== null;

  return (
    <Card
      domId={domId}
      tone="appointment"
      title={appointmentNumber === null ? "Appointment" : `Appt. ${appointmentNumber}`}
      meta={
        linked ? (
          <>
            <span className="text-ink">{londonDateTimeLabel(group.startsAtIso ?? "")}</span>
            {group.practitioner ? (
              <>
                <Dot />
                <span>{group.practitioner}</span>
              </>
            ) : null}
          </>
        ) : (
          // NOT a blank space where a date belongs, and NOT one generic sentence for
          // four different truths. The read already worked out which of them applies
          // and wrote it; this prints that, and falls back only when it gave none.
          <span className="text-faint">
            {group.unresolvedReason ?? APPOINTMENT_CARD_COPY.noLinkedAppointment}
          </span>
        )
      }
      badge={
        <StatusPill tone={group.completed ? "success" : "neutral"}>
          {group.completed ? "Completed" : "Not completed"}
        </StatusPill>
      }
      note={group.note}
      rows={group.rows}
      totals={group.totals}
      className={className}
    />
  );
}

/**
 * The items that belong to this plan and to no appointment on it.
 *
 * VISUALLY DISTINCT AND LABELLED WITH ITS COUNT, because it is not an edge case: on
 * the live sample it is 83 of every 100 items. Amber, which is this screen's existing
 * "read this before you rely on it" tint (the truncation notice and the failed-read
 * notice both use it), rather than a red that would read as an error in the data or a
 * grey that would read as unimportant.
 */
export function UnassignedItemsCard({
  group,
  domId,
  className,
}: {
  group: PlanUnassignedGroup;
  domId: string;
  className?: string;
}) {
  const count = group.rows.length;
  return (
    <Card
      domId={domId}
      tone="unassigned"
      // THE LABEL COMES FROM THE LIBRARY, not from here. It was spelled twice, once
      // as UNASSIGNED_LABEL ("Not in an appointment") and once as this string ("Not
      // on an appointment"), so the constant was dead and the screen carried an
      // unowned second copy of a heading. One spelling, one place.
      title={UNASSIGNED_LABEL}
      meta={
        <span className="tabular-nums text-ink">
          {count} {count === 1 ? "item" : "items"}
        </span>
      }
      badge={null}
      note={null}
      // TWO PARAGRAPHS, AND BOTH ARE LOAD-BEARING. The first is the charting
      // library's COUNTED sentence, which says how many of these items Dentally
      // attached to no appointment at all and how many name an appointment that was
      // not returned with the plan - a paging or permissions gap, which is a
      // different problem with a different fix. The second is the standing
      // explanation of why they are shown here rather than folded into the first
      // card. Printing only the second would lose the counts; printing only the
      // first would leave a reader wondering why this box exists.
      reason={
        <>
          <p>{group.reason}</p>
          <p className="mt-1.5">{APPOINTMENT_CARD_COPY.unassigned}</p>
        </>
      }
      rows={group.rows}
      totals={group.totals}
      className={className}
    />
  );
}

// ---------------------------------------------------------------------------
// The card itself. One implementation, two tones, so the unassigned group is read
// with the same eye movement as a real appointment instead of being a second,
// unfamiliar shape at the bottom of the screen.
// ---------------------------------------------------------------------------

function Card({
  domId,
  tone,
  title,
  meta,
  badge,
  note,
  reason,
  rows,
  totals,
  className,
}: {
  domId: string;
  tone: "appointment" | "unassigned";
  title: string;
  meta: React.ReactNode;
  badge: React.ReactNode;
  note: string | null;
  /** The explanation rendered under the header, for the unassigned group. A NODE
   *  rather than a string because that group needs two paragraphs: the counted one
   *  and the standing one. */
  reason?: React.ReactNode;
  rows: PlanItemRow[];
  totals: PlanGroupTotals;
  className?: string;
}) {
  // Read, not assumed: write-gate.test.ts scans every file in this directory that
  // renders a write control for exactly this call, so the day Dentally publishes a
  // create route a contributor is brought here rather than leaving these controls
  // inert beside a working endpoint.
  const writeBlocked = !canWriteChartToDentally();
  // ONE sentence per card, shared by the overflow affordance, the two note-editing
  // affordances and every row's completed checkbox. They are all off for the same
  // reason, so repeating it once per row would be noise a reader learns to skip.
  const reasonId = `${domId}-write-reason`;

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card",
        tone === "unassigned" ? "border-tint-amber-line" : "border-line",
        className,
      )}
    >
      {/* Outside the <summary>, and over it. A click inside a summary toggles the
          disclosure, so an overflow affordance nested in the header would collapse the
          card instead of doing nothing visibly. Space for it is reserved by the
          header's right padding.

          NOT ON THE UNASSIGNED GROUP. That box is OURS, not Dentally's: it exists
          because 83% of a plan belongs to no appointment, and Dentally has no overflow
          menu on a thing it does not have. Rendering one there put a control labelled
          "More actions for this appointment" on a group that is by definition not an
          appointment - caught by reading the rendered markup, not by a test. */}
      {writeBlocked && tone === "appointment" ? (
        <div className="absolute right-2.5 top-2.5 z-10">
          <InertControl
            id={`${domId}-overflow`}
            describedBy={reasonId}
            label="More actions for this appointment"
            icon={<MoreVertical size={15} aria-hidden />}
            iconOnly
          />
        </div>
      ) : null}

      <details open className="group/card">
        <summary
          className={cn(
            "flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 pr-11",
            "[&::-webkit-details-marker]:hidden",
            tone === "unassigned"
              ? "bg-tint-amber"
              : "border-b border-line bg-card-muted/45",
          )}
        >
          <ChevronRight
            size={15}
            aria-hidden
            className="shrink-0 text-muted transition-transform group-open/card:rotate-90"
          />
          <h3 className="text-[13.5px] font-semibold tracking-[-0.1px] text-navy">{title}</h3>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
            {meta}
          </div>
          {badge}
        </summary>

        {reason ? (
          <div className="border-b border-tint-amber-line bg-tint-amber/50 px-3 py-2 text-[11.5px] leading-[1.5] text-ink">
            {reason}
          </div>
        ) : null}

        {/* THE NOTE ROW BELONGS TO AN APPOINTMENT, so the unassigned group does not
            get one. treatment_appointment.notes is a field on a record the bucket does
            not have; rendering the row there printed "There is no note on this
            appointment in Dentally" against a group that is not an appointment, and
            offered to dictate a note into nothing. */}
        {tone === "appointment" ? (
          <NoteRow domId={domId} note={note} reasonId={reasonId} writeBlocked={writeBlocked} />
        ) : null}

        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.id}>
              <ItemRow row={row} domId={domId} reasonId={reasonId} writeBlocked={writeBlocked} />
            </li>
          ))}
        </ul>

        {/* THE CARD'S OWN TOTALS, on the same grid as the rows so the figures sit
            under the columns they total. Summed from the rows by the charting library:
            Dentally stores neither, and a total that does not equal the rows above it
            is the kind of discrepancy a coordinator quotes to a patient. */}
        <div
          className={cn(
            ROW_GRID,
            "border-t border-line bg-card-muted/30 px-3 py-2 pr-11 text-[12.5px] font-semibold text-navy",
          )}
        >
          <span aria-hidden />
          <span aria-hidden />
          <span aria-hidden />
          <span aria-hidden />
          <span aria-hidden />
          <span aria-hidden />
          <span className="text-right tabular-nums">{totals.durationMin} min</span>
          <span className="text-right tabular-nums">
            {gbp(totals.pricePence / 100, { decimals: true })}
          </span>
        </div>

        {/* THE FOOTER CAVEATING ITSELF. plan-panel.ts counts the rows whose duration
            or price was not a finite number, and the two sums above leave those rows
            out. Nothing rendered that count, so a short total was presented as a
            complete one — the same class of claim as a plan that quietly omits a
            line. Null when there is nothing to say, so no card carries a permanent
            "0 excluded" that a reader learns to skip. */}
        {unreadableFiguresNote(totals.unreadableFigures) ? (
          <p className="border-t border-tint-amber-line bg-tint-amber px-3 py-2 text-[11.5px] leading-[1.5] text-ink">
            {unreadableFiguresNote(totals.unreadableFigures)}
          </p>
        ) : null}

        {/* THE ONE SENTENCE every inert control in this card points at. It is inside
            the card rather than at the panel level so that rendering this card on its
            own still resolves every aria-describedby: disabled-controls.test.ts renders
            each surface in isolation and follows every one of those ids. */}
        {writeBlocked ? (
          <p
            id={reasonId}
            className="border-t border-line px-3 py-2 text-[11.5px] leading-[1.5] text-faint"
          >
            {CHART_COPY.writeBlockedTitle}
          </p>
        ) : null}
      </details>
    </section>
  );
}

/**
 * The note row under the card header.
 *
 * THE NOTE IS READ AND THE EDITING IS NOT. treatment_appointment.notes is readable
 * (PLAN-PANEL.md:52), so it is rendered in full; Dentally's own Draft and dictation
 * affordances sit beside it, inert, because there is no PUT to send an edited note
 * through. An absent note says so in words rather than leaving the row blank, which a
 * reader would take as "there is nothing to know here".
 *
 * NO "Last updated" LINE. Dentally's own row carries one and we have no timestamp for
 * the note in the payload, so inventing one, or quietly reusing the read time, would
 * put an unsupported age on a clinical note.
 */
function NoteRow({
  domId,
  note,
  reasonId,
  writeBlocked,
}: {
  domId: string;
  note: string | null;
  reasonId: string;
  writeBlocked: boolean;
}) {
  const text = note?.trim() ?? "";
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-line bg-band/40 px-3 py-2">
      <FileText size={14} aria-hidden className="mt-[2px] shrink-0 text-muted" />
      <p
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-[1.5]",
          text ? "text-ink" : "text-faint",
        )}
      >
        {text || APPOINTMENT_CARD_COPY.noNote}
      </p>
      {writeBlocked ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <InertControl
            id={`${domId}-note-dictate`}
            describedBy={reasonId}
            label="Dictate this note"
            icon={<Mic size={14} aria-hidden />}
            iconOnly
          />
          <InertControl
            id={`${domId}-note-draft`}
            describedBy={reasonId}
            label="Draft"
            icon={<PencilLine size={14} aria-hidden />}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One treatment plan item.
 *
 * THE COLUMN ORDER IS THE CONTRACT: expand chevron, date, TOOTH, treatment name,
 * practitioner initials, funding badge, duration, price, completed checkbox. A
 * Dentally user's eye goes to fixed positions rather than to labels, so every one of
 * those columns holds its width whether or not the row has a value for it. An empty
 * cell says "Dentally sent nothing here"; a shifted column says nothing at all and
 * costs the reader the habit.
 *
 * THE TOOTH IS NEVER DERIVED HERE. It arrives already converted from Palmer to FDI by
 * the charting library, which is exhaustively tested, because an off-by-one-quadrant
 * conversion labels the contralateral tooth. When the teeth value would not parse, the
 * raw value Dentally sent is printed instead of a blank.
 */
function ItemRow({
  row,
  domId,
  reasonId,
  writeBlocked,
}: {
  row: PlanItemRow;
  domId: string;
  reasonId: string;
  writeBlocked: boolean;
}) {
  const funding = FUNDING_LABEL[row.funding];
  const details = detailPairs(row);

  return (
    <div className="relative">
      <details className="group/row">
        <summary
          className={cn(
            ROW_GRID,
            "cursor-pointer list-none px-3 py-[7px] pr-11 text-[12.5px] hover:bg-card-muted/30",
            "[&::-webkit-details-marker]:hidden",
          )}
        >
          <ChevronRight
            size={14}
            aria-hidden
            className="text-line-strong transition-transform group-open/row:rotate-90"
          />
          <span className="truncate tabular-nums text-muted">
            {row.dateIso ? londonDateLabel(row.dateIso) : ""}
          </span>
          {/* THE TOOTH COLUMN. Bold and monospaced-by-figures because it is the one
              cell a clinician scans down the card looking for. */}
          <span className="truncate font-semibold tabular-nums text-navy">
            {row.toothLabel ?? row.rawTeeth ?? ""}
          </span>
          <span className="truncate text-ink">{row.name}</span>
          {/* THE CLINICIAN COLUMN, AND ITS THREE STATES.
              Initials when we can name them. An EMPTY cell only when Dentally named
              nobody on the line, which is what an empty cell on this table means. A
              marked cell when Dentally DID name somebody and we could not look them
              up: that used to render as the empty one, which made a false statement
              about who treated a patient on a screen that looked complete, and it
              was the state 83% of a live plan sat in because the only names in the
              read came off resolved appointment cards. */}
          <span className="truncate text-[11.5px] font-medium text-muted">
            {row.practitionerUnresolved ? (
              <span title={PRACTITIONER_UNRESOLVED_EXPLANATION}>
                <span aria-hidden>{PRACTITIONER_UNRESOLVED_MARK}</span>
                <span className="sr-only">{PRACTITIONER_UNRESOLVED_EXPLANATION}</span>
              </span>
            ) : (
              (row.practitionerInitials ?? "")
            )}
          </span>
          <span className="min-w-0">
            {/* FUNDING_LABEL is the empty string for "unknown" on purpose: a patient
                whose payment plan we cannot resolve renders NOTHING, because a badge
                reading Private on a guess is a commercial claim about a person. */}
            {funding ? (
              <StatusPill
                tone={row.funding === "nhs" ? "info" : "neutral"}
                className="px-1.5 py-0 text-[10.5px]"
              >
                {funding}
              </StatusPill>
            ) : null}
          </span>
          {/* NULL IS A FIGURE WE COULD NOT READ, and it renders as nothing. It used
              to render as the literal strings "NaN min" and "£NaN" while the card
              footer silently excluded the row; the exclusion is now stated by the
              caveat under the totals, and the cell itself makes no claim. A real 0
              is not null and still prints as "0 min" and "£0.00". */}
          <span className="text-right tabular-nums text-muted">
            {row.durationMin === null ? "" : `${row.durationMin} min`}
          </span>
          <span className="text-right font-medium tabular-nums text-navy">
            {row.pricePence === null ? "" : gbp(row.pricePence / 100, { decimals: true })}
          </span>
        </summary>

        {details.length > 0 ? (
          <dl className="grid gap-x-6 gap-y-1 border-t border-line bg-card-muted/25 px-3 py-2 pl-9 text-[11.5px] sm:grid-cols-2">
            {details.map(([term, value]) => (
              <div key={term} className="flex gap-1.5">
                <dt className="shrink-0 font-medium text-muted">{term}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </details>

      {/* THE COMPLETED CHECKBOX. Outside the <summary> for the same reason as the
          card's overflow: a click inside a summary toggles the disclosure, and a
          control whose only visible effect is to expand a row is worse than an inert
          one that says why it cannot act. Space is reserved by the summary's pr-11. */}
      {writeBlocked ? (
        <div className="absolute right-3 top-[6px]">
          <InertControl
            id={`${domId}-complete-${row.id}`}
            describedBy={reasonId}
            label={`Mark ${row.name} completed`}
            icon={<CheckBox checked={row.completed} />}
            iconOnly
          />
        </div>
      ) : null}
    </div>
  );
}

/** The facts behind the chevron. Only what Dentally actually returned: an absent field
 *  is omitted rather than printed as an empty row, which would read as a value of
 *  "none" on a clinical record. */
function detailPairs(row: PlanItemRow): [string, string][] {
  const pairs: [string, string][] = [];
  if (row.nomenclature) pairs.push(["Code", row.nomenclature]);
  // Verbatim, never converted to an anatomical name. DENTALLY.md:147: we know where a
  // region sits on the diagram, not whether it is buccal or mesial, and naming it
  // would be a wrong-surface clinical claim.
  if (row.surfacesLabel) pairs.push(["Surfaces", row.surfacesLabel]);
  if (row.udaBand) pairs.push(["UDA band", row.udaBand]);
  if (row.nhsTreatmentCat) pairs.push(["NHS category", row.nhsTreatmentCat]);
  if (row.completed && row.completedAtIso) {
    pairs.push(["Completed", londonDateLabel(row.completedAtIso)]);
  }
  // Rendered for every row, both ways round. PLAN-PANEL.md:71 records that `charged`
  // was false on all 100 live items sampled, so "No" is the normal answer and its
  // absence would be read as "not applicable" rather than as "not yet charged".
  pairs.push(["Charged", row.charged ? "Yes" : "No"]);
  if (row.notes) pairs.push(["Note", row.notes]);
  return pairs;
}

/** Dentally's completed tick, as a box rather than a real <input>: there is nothing to
 *  submit and a real checkbox would be a form control a browser would let a user
 *  change, leaving the screen disagreeing with Dentally until it was reloaded. */
function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[15px] items-center justify-center rounded-[3px] border",
        checked ? "border-navy bg-navy text-white" : "border-line-strong bg-card",
      )}
    >
      {checked ? (
        <svg viewBox="0 0 12 12" className="size-[9px]" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M2 6.4 4.7 9 10 3.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * An inert control that shares ONE sentence with the rest of its card.
 *
 * WHY NOT DisabledControl. That component derives its reason id from its own id
 * (`${id}-reason`), which is exactly right for a control with a sentence of its own.
 * These do not have one: a card can hold twenty rows, and twenty copies of the same
 * clinical sentence is noise a reader learns to skip past, which is the failure the
 * rule exists to prevent. So they point at one sentence rendered once per card. The
 * rest of DisabledControl's contract is kept exactly: FOCUSABLE with aria-disabled
 * rather than `disabled`, so a keyboard user can reach it and hear the explanation;
 * aria-describedby pointing at a sentence that is really on the screen; and `title`
 * as a bonus, never as the explanation.
 */
function InertControl({
  id,
  describedBy,
  label,
  icon,
  iconOnly = false,
}: {
  id: string;
  describedBy: string;
  label: string;
  icon: React.ReactNode;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      id={id}
      aria-disabled="true"
      aria-describedby={describedBy}
      title={CHART_COPY.writeBlockedTitle}
      className={cn(
        // `relative` FOR THE SAME REASON AS disabled-control.tsx: the iconOnly label is
        // an `sr-only` span and Tailwind's sr-only is `position: absolute`, so without a
        // positioned ancestor it resolves against the initial containing block, escapes
        // .app-frame's overflow:hidden and grows documentElement.scrollHeight. Today
        // these particular spans happen to be contained anyway, because the card's
        // <section> is already `relative` for the overflow affordance and the completed
        // checkbox sits in an `absolute` wrapper. That is incidental: it holds only for
        // as long as those two unrelated decisions hold. Owning the containing block on
        // the button itself makes it a property of this control rather than a lucky
        // consequence of its surroundings. The span stays rendered and stays this
        // button's accessible name.
        "relative inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-card-muted/60 font-medium text-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30",
        iconOnly ? "size-[26px] justify-center" : "px-2 py-[3px] text-[11.5px]",
      )}
    >
      {icon}
      {iconOnly ? <span className="sr-only">{label}</span> : label}
    </button>
  );
}

function Dot() {
  return <span aria-hidden className="text-line-strong">&middot;</span>;
}
