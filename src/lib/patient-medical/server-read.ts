import "server-only";
import { isMedicalHistoryEnabled } from "./gate";
import { getSummary } from "./repository";
import { medicalReviewStatus, type MedicalReviewRead, type ReviewAppointment } from "./review-status";

// ===========================================================================
// The record HEADER's medical read, resolved on the server so the header stays a
// dumb component.
//
// It returns MedicalReviewRead — { ok, state } — or null when the feature is off.
// null is the "not computed" signal the header pill treats as "fall back to the
// Dentally alert mirror alone", so with the gate shut the header does exactly what
// it did before this feature: shows the red alert or nothing, and nothing else.
//
// WITH THE GATE OFF NO READ IS MADE AT ALL. Not a read that returns nothing — no
// read: the repository throws MedicalDisabledError by design, so this returns null
// without touching it.
//
// IT FAILS SOFT AND SAYS SO. A thrown read returns { ok: false, state: null }, and
// the pill renders "Medical review not read" rather than silently reading as
// up-to-date. An empty successful read is a real "no review due", which is a
// different fact and the caller is allowed to render it as such.
// ===========================================================================

export interface MedicalHeaderReadInput {
  siteId: string;
  patientId: string;
  /** The patient's appointments, so the appointment-aware rule can run. */
  appointments: readonly ReviewAppointment[];
  nowIso: string;
}

export async function readMedicalReviewForHeader(
  input: MedicalHeaderReadInput,
): Promise<MedicalReviewRead | null> {
  if (!isMedicalHistoryEnabled()) return null;
  try {
    const summary = await getSummary({ siteId: input.siteId, patientId: input.patientId });
    const state = medicalReviewStatus({
      latestQuestionnaireAt: summary.latestQuestionnaire?.recordedAt ?? null,
      latestReviewAt: summary.latestReview?.reviewedAt ?? null,
      appointments: input.appointments,
      now: input.nowIso,
    });
    return { ok: true, state };
  } catch (err) {
    console.error(`[medical] header review read threw for patient ${input.patientId}`, err);
    return { ok: false, state: null };
  }
}
