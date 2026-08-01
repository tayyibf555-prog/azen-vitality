import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { FUNDING_LABEL } from "@/lib/calendar/funding";
import { CANNOT_READ_COPY } from "@/lib/patient/tabs";
import { balanceLabel, type PatientDerived } from "@/lib/patient/record-derive";
import { patientStatusChip } from "@/lib/patient/status-chip";
import type { PatientRecord, ReadHealth } from "@/lib/dentally/read";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import { londonDateLabel } from "@/lib/time/london";
import { gbp } from "@/lib/utils";

/**
 * The patient record's identity row, arranged as Dentally arranges it: identity on
 * the left, practice facts on the right, one dense line each.
 *
 * TWO SLOTS HAVE NO SOURCE AT ALL, and what goes in them was decided rather than
 * guessed:
 *
 *  - MEDICAL HISTORY. Dentally prints a red flag here. We have no medical read of any
 *    kind, so this is a NEUTRAL GREY pill reading "Medical history not read", linked
 *    to the Medical tab. Not red, because red is a real alert and faking one is worse
 *    than saying nothing. Not absent, because a Dentally user's eye goes to this exact
 *    position and finding nothing there reads as "this patient has no medical alert",
 *    which is the confusion the honesty rule exists to prevent. Grey, in place, saying
 *    we cannot read it, cannot be misread in either direction.
 *
 *  - PRACTITIONER. Dentally prints "N15 Vitality Dental (Jan Kupeli)", where the name
 *    is the patient's ASSIGNED dentist. toPatient does not read an assigned dentist,
 *    and the only practitioner we hold sits on individual appointments. A bare name in
 *    parentheses in that position would be read as the assigned dentist, so we render
 *    a different, labelled, TRUE statement in the same slot: "Last seen by Jan Kupeli",
 *    from the newest completed appointment. No appointments, nothing rendered.
 *
 * DENTALLY'S "CLINICAL SIDEBAR" COLLAPSE IS DELIBERATELY OMITTED. We have no clinical
 * sidebar, and a control that collapses nothing is a dead control. Recorded here so
 * the next person does not "restore" it.
 *
 * "HIDE ALL" IS NOT HERE EITHER. It only exists while a pinned note is visible, and
 * only the pinned band knows that, so the band owns it (stage 2).
 */

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function PatientRecordHeader({
  patient,
  derived,
  reads,
  siteName,
  overrideStatus,
  overrideUnavailable = false,
  listHref,
  medicalHref,
}: {
  patient: PatientRecord;
  derived: PatientDerived;
  reads: ReadHealth;
  siteName: string;
  /** The platform admin override, when one is set. Wins over Dentally's active flag. */
  overrideStatus: PatientAdminStatus | null;
  /** The override READ threw. Wins over everything: an outage must never render as a
   *  green "Active" pill on a patient the practice may have marked do_not_contact. */
  overrideUnavailable?: boolean;
  /** Back to the patients list. The page has no Escape, no backdrop and no X. */
  listHref: string;
  /** The Medical tab, so the grey flag is a way in rather than a dead label. */
  medicalHref: string;
}) {
  // Decided in lib/patient/status-chip.ts so the quick overview renders the SAME chip
  // from the same rule rather than a second version of it.
  const chip = patientStatusChip({
    overrideStatus,
    overrideUnavailable,
    active: patient.active,
    archivedReason: patient.archivedReason,
  });

  const dob = patient.dateOfBirth ? londonDateLabel(patient.dateOfBirth) : null;
  const fundingLabel = FUNDING_LABEL[derived.funding]; // "" for unknown, by contract
  // A failed invoice read must never render as a £0 balance: zero is a fact about the
  // account, and presenting an outage as one is exactly the lie this record forbids.
  const balanceUnavailable = reads.invoices === "failed";
  const balance = balanceLabel(derived.outstanding, derived.credit, gbp);

  return (
    <header className="space-y-2.5">
      <Link
        href={listHref}
        className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] font-medium text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
      >
        <ChevronLeft size={13} /> Back to patients
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        {/* Identity */}
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#eef3fa] text-[14px] font-semibold text-side-ink"
          >
            {initialsOf(patient.name)}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[20px] font-bold tracking-[-0.4px] text-navy">
              {patient.title ? `${patient.title} ` : ""}
              {patient.name}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted">
              {dob ? (
                <span className="tabular-nums">
                  {dob}
                  {derived.ageLabel ? ` (${derived.ageLabel})` : ""}
                </span>
              ) : (
                // No date of birth means NO age at all. A partial or guessed age on a
                // clinical record is worse than an absent one.
                <span>Date of birth not on file</span>
              )}
              <Link
                href={medicalHref}
                className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              >
                <StatusPill tone="neutral">{CANNOT_READ_COPY.medicalHistoryFlag}</StatusPill>
              </Link>
              <StatusPill tone={chip.tone}>{chip.label}</StatusPill>
            </div>
          </div>
        </div>

        {/* Practice facts */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
          <div className="text-right">
            <p className="font-semibold text-navy">{siteName}</p>
            {derived.lastSeenBy ? (
              <p className="text-[11.5px] text-muted">Last seen by {derived.lastSeenBy}</p>
            ) : null}
          </div>
          {/* "unknown" has the EMPTY-STRING label by contract, so an unrecognised plan
              id renders nothing at all rather than defaulting to Private. */}
          {fundingLabel ? <StatusPill tone="neutral">{fundingLabel}</StatusPill> : null}
          <div className="text-right">
            <p className="text-[10.5px] font-medium text-muted">Balance</p>
            {balanceUnavailable ? (
              <p className="text-[15px] font-semibold text-muted">Balance unavailable</p>
            ) : (
              <p
                className={
                  balance.tone === "owed"
                    ? "text-[17px] font-bold tabular-nums tracking-[-0.3px] text-status-red"
                    : "text-[17px] font-bold tabular-nums tracking-[-0.3px] text-navy"
                }
              >
                {balance.text}
              </p>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
