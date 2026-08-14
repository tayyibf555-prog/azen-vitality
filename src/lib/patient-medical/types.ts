// ===========================================================================
// THE MEDICAL-HISTORY CONTRACT.
//
// Types only. No logic, no I/O, and there is NO index.ts barrel in this
// directory — the same rule perio/types.ts states: a barrel lets a client
// component reach a server-only repository, which builds green and then drags
// the service-role client into the client graph.
//
// READ THIS BEFORE YOU ADD A FIELD. This is NOT a mirror of Dentally.
// Dentally's /v1/medical_histories endpoint EXISTS but is permanently empty for
// this practice (0 rows across 51k patients, verified GET-only), so there is
// nothing to mirror: every questionnaire and every review described by this file
// is AUTHORED in this platform, and this platform becomes the system of record
// for it the moment MEDICAL_HISTORY_ENABLED is set. The ONLY Dentally medical
// signal we read is the patient object's own `medical_alert` flag + free text,
// and that lives on PatientRecord (src/lib/dentally/read.ts), not here — it is a
// DIFFERENT FACT from the questionnaire below and the two must never be conflated.
//
// That is why, exactly as with perio:
//   1. Every review carries a clinician and an instant (GDC 4.1.4).
//   2. Amendments APPEND — supersedesId names the row this one replaces; nothing
//      is overwritten and nothing is hard-deleted (GDC 4.1.5).
//   3. An empty questionnaire read is "not captured here", NEVER "the patient has
//      no medical history". A failed read is not an absence of findings.
//
// TIME IS ALWAYS AN ISO-8601 STRING SUPPLIED BY THE CALLER. Nothing in this
// directory reads the clock in a render path.
// ===========================================================================

/** A single yes/no/unknown answer to one question from the versioned bank. */
export type MedicalAnswerValue = "yes" | "no" | "unknown";

export interface MedicalAnswer {
  /** A key from questions.ts. An answer whose key is not in the bank is dropped. */
  key: string;
  answer: MedicalAnswerValue;
  /** Free text where the question invites it (e.g. "which allergy"). Null otherwise. */
  detail: string | null;
}

/** How the questionnaire reached us. Kept because a patient self-capture and a
 *  staff-entered fallback are different provenance, and a signature drawn on an
 *  iPad at the desk is different again. */
export type MedicalCaptureMethod = "public-link" | "ipad" | "staff";

export type SignatureMethod = "drawn" | "typed" | "ipad";

/**
 * A captured signature. `value` is a data-url for a drawn signature or the typed
 * name for a typed one — patient identifying data, which is why the row it lives
 * on is RLS-locked with no policy (server-only) exactly as the perio tables are.
 */
export interface MedicalSignature {
  method: SignatureMethod;
  value: string;
  /** ISO. When the patient signed, which is not always when the row was written. */
  signedAt: string;
}

/** The clinician a review is attributed to. A fabricated GDC number is not
 *  allowed; a null one is, where the practice does not hold it (GDC 4.1.4). */
export interface MedicalClinician {
  id: string;
  name: string;
  gdcNumber: string | null;
}

/**
 * One stored medical-history questionnaire, with its append-only envelope.
 *
 * `authorUserId` is null for a patient self-capture over the public link — the
 * patient answered, no clinician did — and set for a staff-entered fallback.
 */
export interface StoredQuestionnaire {
  id: string;
  siteId: string;
  patientId: string;
  /** 1-based per (site, patient), assigned by the database. An amendment is n+1. */
  version: number;
  /** Which questions.ts version these answers were given against. */
  questionBankVersion: string;
  /** The patient's name as they signed it, or as staff recorded it. Null when
   *  unknown. Identifying, hence the locked table. */
  patientName: string | null;
  answers: MedicalAnswer[];
  medicationsText: string | null;
  allergiesText: string | null;
  signature: MedicalSignature | null;
  capturedVia: MedicalCaptureMethod;
  /** ISO — when the questionnaire was completed. */
  recordedAt: string;
  createdAt: string;
  authorUserId: string | null;
  authorName: string | null;
  supersedesId: string | null;
  amendmentReason: string | null;
  retractedAt: string | null;
  retractionReason: string | null;
}

/** The result of a review at an appointment: nothing changed, or the history was
 *  updated (which is captured as a NEW questionnaire version alongside). */
export type MedicalReviewOutcome = "no-changes" | "updated";

/**
 * The "medical history reviewed at this appointment" clinical event — the legal
 * obligation this feature exists to record. A review always carries a named
 * clinician (GDC 4.1.4); it optionally links to the appointment it was done at
 * and to the questionnaire that was current at the time.
 */
export interface ReviewEvent {
  id: string;
  siteId: string;
  patientId: string;
  /** The Dentally appointment id this review was done at, when known. */
  appointmentId: string | null;
  /** The questionnaire that was current when reviewed, when there was one. */
  questionnaireId: string | null;
  outcome: MedicalReviewOutcome;
  /** ISO — when the review happened. */
  reviewedAt: string;
  createdAt: string;
  authorUserId: string;
  authorName: string;
  authorGdcNumber: string | null;
}

/** One patient's medical-history summary in one site: the standing questionnaire
 *  and the last review, the pair the record screen and the header pill read. */
export interface MedicalSummary {
  latestQuestionnaire: StoredQuestionnaire | null;
  latestReview: ReviewEvent | null;
}
