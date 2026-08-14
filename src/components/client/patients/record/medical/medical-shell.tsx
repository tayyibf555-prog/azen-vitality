import { AlertTriangle } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { londonDateTimeLabel } from "@/lib/time/london";
import { questionForKey } from "@/lib/patient-medical/questions";
import type { MedicalReviewState } from "@/lib/patient-medical/review-status";
import type { MedicalClinician, ReviewEvent, StoredQuestionnaire } from "@/lib/patient-medical/types";
import { RecordReview } from "./record-review";

// ===========================================================================
// THE MEDICAL-HISTORY SCREEN — a DUMB server component. No I/O, no clock, no
// clinical rule. It receives computed data and copy from tab-medical.tsx and
// renders it, the way perio-shell renders what tab-perio computes.
//
// FOUR THINGS IT MUST NEVER CONFUSE, and every empty state is worded to keep them
// apart:
//   - the DENTALLY medical_alert (a real read, shown red when set) is a different
//     fact from our questionnaire;
//   - "not captured here" is not "the patient has no medical history";
//   - a FAILED read is not an absence of a record;
//   - the screen with the gate shut is a PREVIEW, not this patient's answers.
//
// Every one of those sentences comes from MEDICAL_COPY (server-only), passed in as
// `copy`, so not a word of clinical-safety text lives in this file.
// ===========================================================================

export interface MedicalShellCopy {
  preview: string;
  twoRecords: string;
  disabled: string;
  notCaptured: string;
  readFailed: string;
  noAuthor: string;
}

export function MedicalShell({
  clientSlug,
  siteId,
  patientId,
  enabled,
  canCapture,
  medicalAlert,
  medicalAlertText,
  questionnaire,
  questionnaireFailed,
  reviews,
  reviewsFailed,
  reviewState,
  clinician,
  captureLink,
  openedAt,
  copy,
}: {
  clientSlug: string;
  siteId: string;
  patientId: string;
  enabled: boolean;
  canCapture: boolean;
  medicalAlert: boolean;
  medicalAlertText: string | null;
  questionnaire: StoredQuestionnaire | null;
  questionnaireFailed: boolean;
  reviews: ReviewEvent[];
  reviewsFailed: boolean;
  reviewState: MedicalReviewState | null;
  clinician: MedicalClinician | null;
  /** The public /mh/<token> link for this patient, or null when no server key is
   *  set. Staff copy it to send; nothing auto-sends it yet. */
  captureLink: string | null;
  openedAt: string;
  copy: MedicalShellCopy;
}) {
  return (
    <div className="max-w-3xl space-y-4">
      {/* 1. THE DENTALLY ALERT MIRROR. Read from the patient payload, so it is shown
          whether or not our own feature is on — and red only when Dentally actually
          flags one. An empty alert is simply not rendered, exactly as Dentally shows
          no flag when there is none. */}
      {medicalAlert ? (
        <section
          className="flex items-start gap-3 rounded-xl border border-tint-red-line bg-tint-red px-4 py-3.5"
          aria-label="Medical alert from Dentally"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-status-red" aria-hidden />
          <div>
            <p className="text-[13.5px] font-semibold text-status-red">Medical alert on this patient in Dentally</p>
            <p className="mt-0.5 text-[13px] leading-[1.5] text-ink">
              {medicalAlertText ?? "Dentally records a medical alert for this patient but no detail is available through the connection we have. Open this patient in Dentally to see it."}
            </p>
          </div>
        </section>
      ) : null}

      {/* 2. THE GATE NOTICE. Preview while shut; the two-records fact while open. */}
      <GateNotice enabled={enabled} copy={copy} />

      {/* 3. THE REVIEW STATUS, only when the feature is on and the read succeeded. */}
      {enabled ? <ReviewStatusLine state={reviewState} /> : null}

      {/* The patient capture link — staff copy it to send before the appointment, or
          open it on an iPad at the desk. Nothing auto-sends it yet. Shown only when a
          server key is configured to mint one. */}
      {enabled && captureLink ? (
        <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2">
          <p className="text-[11px] font-medium text-muted">Patient capture link</p>
          <p className="mt-0.5 break-all font-mono text-[12px] text-ink">{captureLink}</p>
          <p className="mt-1 text-[11px] text-muted">
            Send this to the patient before their appointment, or open it on an iPad at the desk. It is not sent
            automatically.
          </p>
        </div>
      ) : null}

      {/* 4. THE QUESTIONNAIRE, read-only. */}
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">Medical history questionnaire</h3>
        {questionnaireFailed ? (
          <FailedNote>{copy.readFailed}</FailedNote>
        ) : !enabled ? (
          <p className="mt-2 text-[13px] leading-[1.5] text-muted">{copy.preview}</p>
        ) : !questionnaire ? (
          <p className="mt-2 text-[13px] leading-[1.5] text-muted">{copy.notCaptured}</p>
        ) : (
          <Questionnaire questionnaire={questionnaire} />
        )}
      </section>

      {/* 5. THE REVIEW HISTORY — the "reviewed at every appointment" log. */}
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">Review history</h3>
          {enabled && canCapture ? (
            <RecordReview
              clientSlug={clientSlug}
              siteId={siteId}
              patientId={patientId}
              questionnaireId={questionnaire?.id ?? null}
              hasClinician={Boolean(clinician)}
              noAuthorCopy={copy.noAuthor}
              openedAt={openedAt}
            />
          ) : null}
        </div>
        {reviewsFailed ? (
          <FailedNote>{copy.readFailed}</FailedNote>
        ) : !enabled ? (
          <p className="mt-2 text-[13px] leading-[1.5] text-muted">
            The review log is part of the medical-history feature, which is switched off here.
          </p>
        ) : reviews.length === 0 ? (
          <p className="mt-2 text-[13px] leading-[1.5] text-muted">
            No medical-history review has been recorded for this patient in this platform yet. This is not a
            finding that the history was never reviewed — reviews made in Dentally are not read here.
          </p>
        ) : (
          <ReviewList reviews={reviews} />
        )}
      </section>
    </div>
  );
}

function GateNotice({ enabled, copy }: { enabled: boolean; copy: MedicalShellCopy }) {
  if (!enabled) {
    return (
      <section
        className="space-y-1.5 rounded-xl border border-line bg-card-muted/40 px-5 py-4"
        aria-label="Medical-history capture is switched off"
      >
        <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">
          This is a preview of the medical-history screen
        </h3>
        <p className="text-[13px] leading-[1.5] text-ink">{copy.preview}</p>
      </section>
    );
  }
  return (
    <section
      className="space-y-1.5 rounded-xl border border-tint-amber-line bg-tint-amber px-5 py-4"
      aria-label="Medical history is kept in two places"
    >
      <h3 className="text-[14px] font-semibold tracking-[-0.1px] text-navy">
        Medical history can now exist in two places
      </h3>
      <p className="text-[13px] leading-[1.5] text-ink">{copy.twoRecords}</p>
    </section>
  );
}

function ReviewStatusLine({ state }: { state: MedicalReviewState | null }) {
  if (state === "review-due") {
    return (
      <div className="flex items-center gap-2 text-[13px]">
        <StatusPill tone="warning">Review due</StatusPill>
        <span className="text-muted">A medical-history review is outstanding for this patient.</span>
      </div>
    );
  }
  if (state === "never-captured") {
    return (
      <div className="flex items-center gap-2 text-[13px]">
        <StatusPill tone="warning">Not captured</StatusPill>
        <span className="text-muted">No questionnaire has been captured in this platform yet.</span>
      </div>
    );
  }
  if (state === "up-to-date") {
    return (
      <div className="flex items-center gap-2 text-[13px]">
        <StatusPill tone="success">Up to date</StatusPill>
        <span className="text-muted">The medical history has been reviewed since it was last captured.</span>
      </div>
    );
  }
  return null;
}

function Questionnaire({ questionnaire }: { questionnaire: StoredQuestionnaire }) {
  const answerTone = (v: string) => (v === "yes" ? "warning" : v === "unknown" ? "neutral" : "success");
  const answerLabel = (v: string) => (v === "yes" ? "Yes" : v === "no" ? "No" : "Not sure");
  return (
    <div className="mt-3 space-y-3">
      <p className="text-[11.5px] text-muted">
        Captured {londonDateTimeLabel(questionnaire.recordedAt)} ·{" "}
        {questionnaire.capturedVia === "public-link"
          ? "completed by the patient"
          : questionnaire.capturedVia === "ipad"
            ? "completed on an iPad at the practice"
            : `entered by ${questionnaire.authorName ?? "staff"}`}
        {questionnaire.retractedAt ? " · retracted" : ""}
      </p>

      <ul className="divide-y divide-line">
        {questionnaire.answers.map((a) => {
          const q = questionForKey(a.key);
          return (
            <li key={a.key} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-[13px] leading-[1.4] text-ink">{q?.prompt ?? a.key}</p>
                {a.detail ? <p className="mt-0.5 text-[12px] text-muted">{a.detail}</p> : null}
              </div>
              <StatusPill tone={answerTone(a.answer)}>{answerLabel(a.answer)}</StatusPill>
            </li>
          );
        })}
      </ul>

      {questionnaire.medicationsText ? (
        <Field label="Current medicines">{questionnaire.medicationsText}</Field>
      ) : null}
      {questionnaire.allergiesText ? <Field label="Allergies">{questionnaire.allergiesText}</Field> : null}
      {questionnaire.signature ? (
        <p className="text-[11.5px] text-muted">
          Signed
          {questionnaire.patientName ? ` by ${questionnaire.patientName}` : ""} ·{" "}
          {londonDateTimeLabel(questionnaire.signature.signedAt)}
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2">
      <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-[1.5] text-ink">{children}</p>
    </div>
  );
}

function ReviewList({ reviews }: { reviews: ReviewEvent[] }) {
  return (
    <ul className="mt-3 divide-y divide-line">
      {reviews.map((r) => (
        <li key={r.id} className="flex items-start justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-navy">
              {r.outcome === "updated" ? "Reviewed — history updated" : "Reviewed — no changes"}
            </p>
            <p className="text-[11.5px] text-muted">
              {r.authorName}
              {r.authorGdcNumber ? ` (GDC ${r.authorGdcNumber})` : ""} · {londonDateTimeLabel(r.reviewedAt)}
            </p>
          </div>
          <StatusPill tone={r.outcome === "updated" ? "warning" : "success"}>
            {r.outcome === "updated" ? "Updated" : "No change"}
          </StatusPill>
        </li>
      ))}
    </ul>
  );
}

function FailedNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[13px] leading-[1.5] text-ink">
      {children}
    </p>
  );
}
