import "server-only";

// ===========================================================================
// THE MEDICAL-HISTORY GATE.
//
// The exact posture of src/lib/perio/gate.ts, and for the exact reason. This
// module is `import "server-only"`: the flag must never cross the wire. With the
// gate off there is no questionnaire to render, no review to show and no reason
// for a browser to hold an opinion about whether the practice has switched on a
// second clinical record. The server decides, the server answers 503, and the
// flag never reaches the bundle. `import "server-only"` is what makes a client
// import a build error rather than a code-review convention.
//
// WHY THE COPY LIVES HERE. Every sentence that distinguishes "we hold none" from
// "we cannot show this" from "the read failed" is a clinical-safety claim, so it
// is kept in a tested module and swept for honesty in one place rather than
// buried in JSX where it drifts.
// ===========================================================================

/**
 * Whether this practice records medical-history QUESTIONNAIRES and REVIEWS in
 * THIS platform.
 *
 * DEFAULTS FALSE, and the default is the whole point.
 *
 * Dentally's /v1/medical_histories endpoint exists but is permanently empty for
 * this practice (0 rows across 51k patients), so there is nothing to mirror:
 * everything this feature holds is authored here, which makes this platform the
 * system of record for it the moment the flag flips — while Dentally's own
 * medical-history screen and its `medical_alert` flag still exist and still work.
 * Two live clinical records for the same patient is the worst outcome available,
 * so switching this on is the practice's decision, in writing, not a developer's.
 *
 * Read on the SERVER ONLY. Never expose this as NEXT_PUBLIC_.
 */
export function isMedicalHistoryEnabled(): boolean {
  return process.env.MEDICAL_HISTORY_ENABLED === "true";
}

/**
 * Whether a medical-history record may be persisted. Same answer, different
 * question, named separately so a future read-only preview mode has somewhere to
 * diverge without every call site having to be re-read.
 */
export function canCaptureMedicalHistory(): boolean {
  return isMedicalHistoryEnabled();
}

/** The env var this whole module turns on, named once so the 503 can quote it. */
export const MEDICAL_HISTORY_ENV_FLAG = "MEDICAL_HISTORY_ENABLED";

export const MEDICAL_COPY = {
  /**
   * The 503 body. It NAMES the environment variable, because the alternatives are
   * all worse: a 404 says the feature does not exist, and an empty 200 says this
   * patient has no medical history — indistinguishable from a healthy patient who
   * simply has none captured here, and the exact false completeness this whole
   * feature is built to avoid.
   */
  disabled:
    "Medical-history capture is switched off in this platform, so nothing is recorded or shown here. " +
    "This is not a statement about this patient: check Dentally for their medical history and any alert. " +
    `Switching it on is a practice decision and requires ${MEDICAL_HISTORY_ENV_FLAG}.`,

  /**
   * What the SCREEN is while the gate is shut. The tab renders the shape of the
   * questionnaire read-only, so a reader must be told those blank rows are the
   * shape of the feature, not this patient's answers.
   */
  preview:
    "What follows is the shape of the medical-history screen, not this patient's medical history. Nothing on " +
    "it can be entered, amended or saved while the feature is off, and every row below is empty because " +
    "nothing is being read — not because a question was answered no.",

  /**
   * The two-facts sentence, shown wherever the feature is enabled. Dentally's own
   * medical_alert flag is read separately and is a DIFFERENT fact from the
   * questionnaire captured here; a clinician must check both before treating.
   */
  twoRecords:
    "This questionnaire is captured and kept in this platform. Dentally holds its own medical history and its " +
    "own medical alert for this patient, and neither is read into the other, so check both before treating.",

  /**
   * The honesty line that must survive every empty state. An empty questionnaire
   * means "not captured here", never "this patient has no medical history".
   */
  notCaptured:
    "No medical-history questionnaire has been captured for this patient in this platform. This is not a finding " +
    "that they have none — check Dentally for their medical history and any alert.",

  /** A read that failed. Explicitly not the same as "none captured". */
  readFailed:
    "This patient's medical-history record could not be read. This is a failure to read it, not a finding that " +
    "there is none.",

  /** A write that failed. Never phrased as if it might have half-succeeded. */
  saveFailed:
    "That medical-history record was not saved. Nothing has been stored, and nothing has been sent to Dentally.",

  /**
   * Why a REVIEW is refused when the server cannot name the clinician. GDC 4.1.4
   * puts the treating clinician on the record; writing 'Team' onto a clinical
   * review would satisfy the column and fail the standard, so the route refuses.
   * Reads are unaffected — a questionnaire the patient signed themselves is not a
   * clinician's authorship and is captured with a null author on purpose.
   */
  noAuthor:
    "Marking a medical history as reviewed records the clinician who reviewed it, and this server cannot " +
    "currently identify a signed-in clinician, so nothing was saved. Sign in, or ask for authentication to be " +
    "enabled here.",
} as const;
