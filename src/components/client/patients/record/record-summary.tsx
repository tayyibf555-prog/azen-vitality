import { londonDateLabel } from "@/lib/time/london";
import { relativeLabel } from "@/lib/time/relative";
import { gbp, num } from "@/lib/utils";
import { balanceLabel, type PatientDerived } from "@/lib/patient/record-derive";
import type { ReadHealth } from "@/lib/dentally/read";

/**
 * The record's six operational figures, on one dense line.
 *
 * EVERY VALUE COMES OFF `derived`. Nothing here is computed, which is the rule that
 * keeps the page and the quick view from ever disagreeing: they render this same
 * component from the same server-produced object.
 *
 * The did-not-attend count is shown, not hidden. It is clinically and commercially
 * material (the front desk needs it before offering a prime slot), and hiding it was
 * one of the defects this rebuild fixes: the underlying read used to exclude
 * cancellations and DNAs outright.
 *
 * A failed read renders "unavailable" in normal ink, never a zero. Zero is a fact
 * about the patient; an outage is not.
 */

function Figure({ label, value, tone }: { label: string; value: string; tone?: "debt" }) {
  return (
    <div className="min-w-0">
      <p className="text-[10.5px] font-medium text-muted">{label}</p>
      <p
        className={
          tone === "debt"
            ? "truncate text-[15px] font-bold tabular-nums tracking-[-0.3px] text-status-red"
            : "truncate text-[15px] font-bold tabular-nums tracking-[-0.3px] text-navy"
        }
      >
        {value}
      </p>
    </div>
  );
}

export function RecordSummary({
  derived,
  reads,
  nowIso,
}: {
  derived: PatientDerived;
  reads: ReadHealth;
  nowIso: string;
}) {
  const now = new Date(nowIso);
  const apptsFailed = reads.appointments === "failed";
  const invoicesFailed = reads.invoices === "failed";
  // Same wording as the header's Balance slot, from the same helper: a patient who
  // overpaid reads "£120.00 in credit" on both, not "£0.00" on both.
  const balance = balanceLabel(derived.outstanding, derived.credit, gbp);

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-line py-2.5 sm:grid-cols-3 lg:grid-cols-6">
      <Figure
        label="Last seen"
        value={apptsFailed ? "Unavailable" : derived.lastSeenAt ? relativeLabel(derived.lastSeenAt, now) : "No record"}
      />
      <Figure
        label="Next appointment"
        value={
          apptsFailed
            ? "Unavailable"
            : derived.nextAppointment
              ? londonDateLabel(derived.nextAppointment.start)
              : "None booked"
        }
      />
      <Figure label="Visits" value={apptsFailed ? "Unavailable" : num(derived.completedVisits)} />
      <Figure label="No-shows" value={apptsFailed ? "Unavailable" : num(derived.didNotAttendCount)} />
      <Figure label="Lifetime spend" value={invoicesFailed ? "Unavailable" : gbp(derived.lifetimeSpend)} />
      <Figure
        label="Outstanding"
        value={invoicesFailed ? "Unavailable" : balance.text}
        tone={!invoicesFailed && balance.tone === "owed" ? "debt" : undefined}
      />
    </dl>
  );
}
