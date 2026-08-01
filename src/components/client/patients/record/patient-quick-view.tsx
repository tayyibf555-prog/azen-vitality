"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Loader2, X } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import { londonDateLabel } from "@/lib/time/london";
import { FUNDING_LABEL } from "@/lib/calendar/funding";
import { CANNOT_READ_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { patientStatusChip } from "@/lib/patient/status-chip";
import { gbp } from "@/lib/utils";
import type { PatientDetail, PatientRecord, ReadHealth } from "@/lib/dentally/read";
import type { PatientDerived } from "@/lib/patient/record-derive";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import type { NumberHealth } from "@/lib/messaging/number-health";
import { RecordSummary } from "./record-summary";
import { TabAppointments } from "./tab-appointments";
import { TabNotes } from "./tab-notes";
import { PanelEmpty, PanelFailed, PanelSection } from "./panel";
import { PatientNumberHealth } from "../patient-number-health";

/**
 * The QUICK OVERVIEW: the shallow end of the patient record.
 *
 * It is NOT replaced by the record page and it is not a second implementation of it.
 * It fetches /api/dentally/patients/[id], which serves the same getPatientRecord the
 * page server-renders, behind the same single 30-second cache entry, and it renders
 * the same RecordSummary component from the same `derived` object. That is what makes
 * "no figure may differ between the two surfaces" true by construction rather than by
 * discipline.
 *
 * ACCESSIBILITY THE OLD DRAWER LACKED, all added here:
 *   - role="dialog" and aria-modal, so a screen reader announces a dialog rather than
 *     reading the page behind it.
 *   - a focus TRAP: Tab and Shift+Tab cycle inside the dialog instead of walking off
 *     into the diary underneath.
 *   - focus RETURNED to whatever opened it (handled by the provider, which captured
 *     the trigger element before this mounted).
 *   - a body scroll LOCK, so the page behind does not scroll under the overlay.
 * All three original close paths survive: Escape, the backdrop, and the X, and so
 * does a fourth that had to be added: "View full patient profile" now CLOSES this
 * before it navigates. The provider is mounted in an ancestor layout of the record
 * page, so a client-side navigation did not unmount it: the overlay and its backdrop
 * stayed on top of the record page with the body scroll still locked, and the only
 * way out was Escape.
 *
 * WHAT IT CARRIES THAT THE OLD DRAWER CARRIED. The status chip (including the red
 * "Do not contact" override), the site, marketing consent and the treatment plans.
 * All four were lost in the rebuild, and this is now the ONLY surface the diary, the
 * debtors list, the task queue and the command palette open, which is exactly where
 * somebody is about to ring or message the patient.
 */

interface RecordResponse {
  ok?: boolean;
  patient?: PatientRecord;
  detail?: PatientDetail;
  derived?: PatientDerived;
  reads?: ReadHealth;
  numberHealth?: NumberHealth | null;
  overrideStatus?: PatientAdminStatus | null;
  overrideUnavailable?: boolean;
  siteName?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PatientQuickView({
  patientId,
  siteId,
  recordHref,
  initialName,
  onClose,
}: {
  patientId: string;
  siteId: string;
  /** Exactly the href of the link that opened this, so the button and the link agree. */
  recordHref: string;
  initialName?: string;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<RecordResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nowIso] = useState(() => new Date().toISOString());

  // No synchronous setState here: the provider mounts this with key={site:patient},
  // so a different patient is a fresh mount and the initial state (loading, not
  // failed) is already correct. State is only ever set from the async callbacks.
  useEffect(() => {
    let alive = true;
    fetch(
      `/api/dentally/patients/${encodeURIComponent(patientId)}?siteId=${encodeURIComponent(siteId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((d: RecordResponse) => {
        if (!alive) return;
        if (d.ok && d.patient && d.detail && d.derived && d.reads) setData(d);
        else setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [patientId, siteId]);

  // Body scroll lock. Restored exactly to whatever it was, so a nested overlay cannot
  // leave the page unscrollable when it closes.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Move focus into the dialog on open, so the first Tab starts inside it.
  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, []);

  function trapFocus(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const patient = data?.patient;
  const derived = data?.derived;
  const detail = data?.detail;
  const reads = data?.reads;
  const name = patient?.name ?? initialName ?? "Patient";
  const fundingLabel = derived ? FUNDING_LABEL[derived.funding] : "";
  // The SAME rule the record page's header uses, from the same module, so the two
  // surfaces cannot disagree about whether this patient is do-not-contact.
  const chip = patient
    ? patientStatusChip({
        overrideStatus: data?.overrideStatus ?? null,
        overrideUnavailable: data?.overrideUnavailable,
        active: patient.active,
        archivedReason: patient.archivedReason,
      })
    : null;
  const consent = patient
    ? [patient.smsConsent ? "SMS" : null, patient.emailConsent ? "Email" : null].filter(Boolean).join(", ") ||
      "No marketing consent"
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${name}, quick overview`}
        onKeyDown={trapFocus}
        className="relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-bold tracking-[-0.3px] text-navy">
              {patient?.title ? `${patient.title} ` : ""}
              {name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
              {patient?.dateOfBirth ? (
                <span className="tabular-nums">
                  {londonDateLabel(patient.dateOfBirth)}
                  {derived?.ageLabel ? ` (${derived.ageLabel})` : ""}
                </span>
              ) : patient ? (
                <span>Date of birth not on file</span>
              ) : null}
              {/* Same neutral grey flag as the record page, in the same position and
                  with the same words. Not red (red is a real alert) and not absent
                  (an empty slot reads as "no alert"). */}
              <StatusPill tone="neutral">{CANNOT_READ_COPY.medicalHistoryFlag}</StatusPill>
              {chip ? <StatusPill tone={chip.tone}>{chip.label}</StatusPill> : null}
              {fundingLabel ? <StatusPill tone="neutral">{fundingLabel}</StatusPill> : null}
              {data?.siteName ? <span className="truncate">{data.siteName}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={recordHref}
              // CLOSE, then navigate. The provider lives in an ancestor layout of the
              // record page, so nothing unmounts this on a client-side navigation and
              // the overlay would otherwise sit on top of the page it just opened,
              // with the body scroll still locked.
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-[12.5px] font-medium text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              View full patient profile <ArrowUpRight size={14} />
            </Link>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
              <Loader2 size={15} className="animate-spin" /> Loading record…
            </div>
          ) : failed || !patient || !derived || !detail || !reads ? (
            <PanelFailed>
              We could not load this patient&apos;s record just now. Open the full profile to try again.
            </PanelFailed>
          ) : (
            <>
              <RecordSummary derived={derived} reads={reads} nowIso={nowIso} />

              <PanelSection title="Contact">
                <dl className="flex flex-wrap gap-x-10 gap-y-2 text-[13px]">
                  <div>
                    <dt className="text-[10.5px] font-medium text-muted">Mobile</dt>
                    <dd className="flex items-center gap-2 text-ink">
                      {patient.phone ?? "Not on file"}
                      <PatientNumberHealth health={data?.numberHealth} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10.5px] font-medium text-muted">Email</dt>
                    <dd className="text-ink">{patient.email ?? "Not on file"}</dd>
                  </div>
                  <div>
                    <dt className="text-[10.5px] font-medium text-muted">Dentist recall</dt>
                    <dd className="tabular-nums text-ink">
                      {derived.dentistRecallAt ? londonDateLabel(derived.dentistRecallAt) : "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10.5px] font-medium text-muted">Hygienist recall</dt>
                    <dd className="tabular-nums text-ink">
                      {derived.hygienistRecallAt ? londonDateLabel(derived.hygienistRecallAt) : "Not set"}
                    </dd>
                  </div>
                  {/* The old drawer carried this and the rebuild dropped it. It is the
                      one field that decides whether this patient may be messaged, on
                      the surface somebody opens right before messaging them. */}
                  <div>
                    <dt className="text-[10.5px] font-medium text-muted">Marketing consent</dt>
                    <dd className="text-ink">{consent}</dd>
                  </div>
                </dl>
              </PanelSection>

              {/* Plan balances, as the old drawer showed them. The data was already
                  fetched here and simply not rendered. */}
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
                          <p className="text-[11.5px] text-muted">Plan value {gbp(p.planned)}</p>
                        </div>
                        <StatusPill tone={p.outstanding > 0 ? "warning" : "success"}>
                          {p.outstanding > 0 ? `${gbp(p.outstanding)} due` : "Paid"}
                        </StatusPill>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelSection>

              {/* TabNotes carries its own two headings (practice notes and Dentally's
                  clinical notes), so it is NOT wrapped in another section here. */}
              <TabNotes
                siteId={patient.siteId}
                patientId={patient.id}
                dentallyNotes={detail.notes}
                reads={reads}
                nowIso={nowIso}
              />

              <PanelSection title="Appointments">
                <TabAppointments appointments={detail.appointments} reads={reads} />
              </PanelSection>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
