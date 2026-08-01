"use client";

import { useMemo, useState } from "react";
import { StatusPill } from "@/components/primitives";
import { PatientProfileEditor } from "../patient-profile-editor";
import { PatientStatusManager } from "../patient-status-manager";
import { PatientNumberHealth } from "../patient-number-health";
import { FactRow, PanelEmpty, PanelFailed, PanelNote, PanelSection } from "./panel";
import { EMPTY_COPY, FAILED_COPY, NOT_HELD_COPY } from "@/lib/patient/tabs";
import { FUNDING_LABEL } from "@/lib/calendar/funding";
import { londonDateLabel } from "@/lib/time/london";
import { relativeLabel } from "@/lib/time/relative";
import { gbp } from "@/lib/utils";
import type { PatientDetail, PatientRecord, ReadHealth } from "@/lib/dentally/read";
import type { PatientDerived } from "@/lib/patient/record-derive";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import type { NumberHealth } from "@/lib/messaging/number-health";
import type { PatientProfile } from "@/lib/patient/profile";

/**
 * Details: the tab a Dentally user lands on, and the only one that WRITES.
 *
 * It reuses the three existing controls UNMODIFIED, because each of them already
 * carries behaviour that took work to get right and that must not be re-derived:
 *   - PatientProfileEditor: 13-field whitelist, touched-only diff, per-field
 *     validation, an `expected` snapshot with a 409 reload, Discard, read-only mode
 *     when the write gate is shut, and its own per-field change history.
 *   - PatientStatusManager: the three-state override with a confirm step, the named
 *     consequence, the optional reason and its own status history.
 *   - PatientNumberHealth: the deliverability chip beside the mobile.
 *
 * Treatment plans live here rather than on one of Dentally's eleven tabs because
 * Dentally has no Plans tab: they belong with the record's commercial summary, and
 * the Account tab cross-references them.
 *
 * NOTHING NUMERIC IS COMPUTED HERE. Every figure comes off `derived`, which the
 * server produced once for both this page and the quick view.
 */
export function TabDetails({
  patient,
  detail,
  derived,
  reads,
  numberHealth,
  siteName,
  nowIso,
  initialOverride,
  overrideUnavailable = false,
  onOverrideChange,
}: {
  patient: PatientRecord;
  detail: PatientDetail;
  derived: PatientDerived;
  reads: ReadHealth;
  numberHealth: NumberHealth | null;
  /** Resolved server-side: getSite() is not reachable from a client component. */
  siteName: string;
  nowIso: string;
  initialOverride: PatientAdminStatus | null;
  /** The server's override read threw, so we do not know this patient's status. */
  overrideUnavailable?: boolean;
  /** Lets a parent surface (the quick view's header chip) follow a status change. */
  onOverrideChange?: (next: PatientAdminStatus | null) => void;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [overrideStatus, setOverrideStatus] = useState<PatientAdminStatus | null>(initialOverride);
  // The record after a save. The props are a snapshot from the server render, so once
  // details have been edited we paint from the saved truth instead of waiting for a
  // reload. Only the fields the editor owns; every derived figure stays as it was.
  const [edited, setEdited] = useState<PatientProfile | null>(null);

  const phone = edited ? edited.mobile_phone : patient.phone;
  const email = edited ? edited.email_address : patient.email;
  const dob = edited ? edited.date_of_birth : patient.dateOfBirth;
  const consent =
    [patient.smsConsent ? "SMS" : null, patient.emailConsent ? "Email" : null].filter(Boolean).join(", ") ||
    "No marketing consent";
  const fundingLabel = FUNDING_LABEL[derived.funding];

  return (
    <div className="space-y-5">
      <PatientStatusManager
        siteId={patient.siteId}
        patientId={patient.id}
        dentallyActive={patient.active}
        status={overrideStatus}
        statusUnavailable={overrideUnavailable}
        onChange={(next) => {
          setOverrideStatus(next);
          onOverrideChange?.(next);
        }}
        now={now}
      />

      <PatientProfileEditor
        // Remount on a different patient, so no half-edited form or stale snapshot can
        // carry across from the record viewed before this one.
        key={patient.id}
        siteId={patient.siteId}
        patientId={patient.id}
        now={now}
        onSaved={setEdited}
      />

      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
        <PanelSection title="Patient details">
          <dl className="divide-y divide-line">
            <FactRow label="Mobile">
              <span className="flex flex-wrap items-center gap-2">
                {phone ?? "Not on file"}
                <PatientNumberHealth health={numberHealth} />
              </span>
            </FactRow>
            <FactRow label="Email">{email ?? "Not on file"}</FactRow>
            <FactRow label="Date of birth">
              {dob ? (
                <span className="tabular-nums">
                  {londonDateLabel(dob)}
                  {derived.ageLabel ? ` (${derived.ageLabel})` : ""}
                </span>
              ) : (
                "Not on file"
              )}
            </FactRow>
            <FactRow label="Dentist recall">
              {derived.dentistRecallAt ? (
                <span className="tabular-nums">
                  {londonDateLabel(derived.dentistRecallAt)}{" "}
                  <span className="text-muted">({relativeLabel(derived.dentistRecallAt, now)})</span>
                </span>
              ) : (
                "Not set"
              )}
            </FactRow>
            <FactRow label="Hygienist recall">
              {derived.hygienistRecallAt ? (
                <span className="tabular-nums">
                  {londonDateLabel(derived.hygienistRecallAt)}{" "}
                  <span className="text-muted">({relativeLabel(derived.hygienistRecallAt, now)})</span>
                </span>
              ) : (
                "Not set"
              )}
            </FactRow>
            <FactRow label="Marketing consent">{consent}</FactRow>
            <FactRow label="Plan">{fundingLabel || <span className="text-faint">Not recognised</span>}</FactRow>
            <FactRow label="Site">{siteName}</FactRow>
          </dl>
          {/* Category C, as ONE quiet line at the foot of the section rather than a
              chip per absent field. These arrive on the same GET /v1/patients/:id
              payload we already call; toPatient simply does not pick them, so this is
              a mapper gap, not an endpoint gap. Nothing in this repo proves live
              Dentally returns them, so they must be probed against the live account
              before any tab promises them. */}
          <PanelNote>{NOT_HELD_COPY.detailsFields}</PanelNote>
        </PanelSection>

        <PanelSection title="Treatment plans">
          {reads.plans === "failed" ? (
            <PanelFailed>{FAILED_COPY.plans}</PanelFailed>
          ) : detail.plans.length === 0 ? (
            <PanelEmpty>{EMPTY_COPY.plans}</PanelEmpty>
          ) : (
            <ul className="divide-y divide-line">
              {detail.plans.map((p, i) => (
                <li key={`${p.name}-${i}`} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-navy">{p.name}</p>
                    <p className="text-[11.5px] text-muted">
                      Plan value {gbp(p.planned)}
                      {p.acceptedAt ? ` · ${londonDateLabel(p.acceptedAt)}` : ""}
                    </p>
                  </div>
                  <StatusPill tone={p.outstanding > 0 ? "warning" : "success"}>
                    {p.outstanding > 0 ? `${gbp(p.outstanding)} due` : "Paid"}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      </div>
    </div>
  );
}
