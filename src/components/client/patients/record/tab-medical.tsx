import { requireUser } from "@/lib/auth/guard";
import {
  isMedicalHistoryEnabled,
  canCaptureMedicalHistory,
  MEDICAL_COPY,
} from "@/lib/patient-medical/gate";
import { latestQuestionnaire, listReviews } from "@/lib/patient-medical/repository";
import { buildMedicalHistoryLink } from "@/lib/patient-medical/link";
import { medicalReviewStatus, type MedicalReviewState } from "@/lib/patient-medical/review-status";
import type { MedicalClinician, ReviewEvent, StoredQuestionnaire } from "@/lib/patient-medical/types";
import { MedicalShell } from "./medical/medical-shell";

/**
 * The Medical tab's data seam: an async SERVER component, and the only place the
 * reads behind this screen are made. Modelled on tab-perio.tsx, and the same in
 * the way that matters most.
 *
 * THIS IS NOT A MIRROR. Dentally's /v1/medical_histories endpoint exists but is
 * PERMANENTLY EMPTY for this practice (0 rows across 51k patients, verified
 * GET-only), so there is nothing to mirror and no Dentally list to fail soft. The
 * ONE Dentally medical signal is the patient object's own `medical_alert` flag,
 * which arrives on the base patient payload (medicalAlert / medicalAlertText,
 * already in scope) and is a DIFFERENT fact from the questionnaire this tab holds.
 * Everything else this tab shows was AUTHORED here, and the moment
 * MEDICAL_HISTORY_ENABLED is set this platform becomes the system of record for it.
 *
 * WITH THE GATE SHUT, NO READ IS MADE AT ALL. Not a read that returns nothing — no
 * read: the repository THROWS by design rather than returning [], because an empty
 * medical result renders as "this patient has no medical history". So this
 * component does not call it when the gate is shut; the shell renders a preview and
 * says so. The medical_alert banner is unaffected — it rides the base patient read
 * and is shown whether or not our own feature is on.
 *
 * EACH STREAM FAILS SOFT ON ITS OWN, and reports. The questionnaire and the review
 * history are separate reads; one being down must not blank the other, and neither
 * may degrade into an empty result. `questionnaireFailed` / `reviewsFailed` travel
 * to the shell, which prints MEDICAL_COPY.readFailed — "a failure to read it, not a
 * finding that there is none".
 *
 * NO CLINICAL RULE IS IMPLEMENTED HERE. The review-due decision is
 * medicalReviewStatus, pure and tested. This file reads, reports what failed, and
 * hands plain data to one server-safe shell.
 */
export async function TabMedical({
  clientSlug,
  siteId,
  patientId,
  nowIso,
  medicalAlert,
  medicalAlertText,
  appointments,
}: {
  clientSlug: string;
  siteId: string;
  patientId: string;
  nowIso: string;
  /** From the base patient payload — the only Dentally medical mirror. */
  medicalAlert: boolean;
  medicalAlertText: string | null;
  /** For the appointment-aware review rule. Only the start instant is used. */
  appointments: readonly { start: string }[];
}) {
  const enabled = isMedicalHistoryEnabled();
  const canCapture = canCaptureMedicalHistory();
  const scope = { siteId, patientId };

  const [questionnaireRead, reviewsRead, clinician] = await Promise.all([
    enabled
      ? latestQuestionnaire(scope).then(
          (questionnaire) => ({ ok: true, questionnaire }),
          (err) => {
            console.error(`[medical] questionnaire read threw for patient ${patientId}`, err);
            return { ok: false, questionnaire: null as StoredQuestionnaire | null };
          },
        )
      : Promise.resolve({ ok: true, questionnaire: null as StoredQuestionnaire | null }),
    enabled
      ? listReviews(scope).then(
          (reviews) => ({ ok: true, reviews }),
          (err) => {
            console.error(`[medical] review read threw for patient ${patientId}`, err);
            return { ok: false, reviews: [] as ReviewEvent[] };
          },
        )
      : Promise.resolve({ ok: true, reviews: [] as ReviewEvent[] }),
    resolveClinician(),
  ]);

  // The pure rule, run only when the feature is on AND both reads succeeded — a
  // failed read must not feed a confident "up to date". listReviews returns newest
  // first, so reviews[0] is the latest.
  const reviewState: MedicalReviewState | null =
    enabled && questionnaireRead.ok && reviewsRead.ok
      ? medicalReviewStatus({
          latestQuestionnaireAt: questionnaireRead.questionnaire?.recordedAt ?? null,
          latestReviewAt: reviewsRead.reviews[0]?.reviewedAt ?? null,
          appointments,
          now: nowIso,
        })
      : null;

  // The public capture link, minted here (server-only key). Null in dev / when no
  // key is set, in which case the shell shows nothing rather than a dead link.
  // Nothing auto-sends it yet — staff copy it, and the "24h before" job is later.
  const captureLink = enabled ? buildMedicalHistoryLink(siteId, patientId) : null;

  return (
    <MedicalShell
      clientSlug={clientSlug}
      siteId={siteId}
      patientId={patientId}
      enabled={enabled}
      canCapture={canCapture}
      captureLink={captureLink}
      medicalAlert={medicalAlert}
      medicalAlertText={medicalAlertText}
      questionnaire={questionnaireRead.questionnaire}
      questionnaireFailed={!questionnaireRead.ok}
      reviews={reviewsRead.reviews}
      reviewsFailed={!reviewsRead.ok}
      reviewState={reviewState}
      clinician={clinician}
      openedAt={nowIso}
      copy={{
        preview: MEDICAL_COPY.preview,
        twoRecords: MEDICAL_COPY.twoRecords,
        disabled: MEDICAL_COPY.disabled,
        notCaptured: MEDICAL_COPY.notCaptured,
        readFailed: MEDICAL_COPY.readFailed,
        noAuthor: MEDICAL_COPY.noAuthor,
      }}
    />
  );
}

/**
 * The clinician a review would be attributed to, resolved exactly as
 * /api/medical-history/[action] resolves it — same source, same construction, same
 * null. A null clinician does not hide the screen: it refuses authorship, and the
 * shell says why in MEDICAL_COPY.noAuthor's words (GDC 4.1.4).
 */
async function resolveClinician(): Promise<MedicalClinician | null> {
  try {
    const auth = await requireUser();
    if (!auth || auth instanceof Response) return null;
    return { id: auth.id, name: auth.name, gdcNumber: null };
  } catch {
    return null;
  }
}
