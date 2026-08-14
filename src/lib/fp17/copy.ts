// ===========================================================================
// FP17 COPY — the honesty sentences, in one tested place.
//
// This feature stores a patient's consent + NHS dental exemption DECLARATION in
// this platform. It does NOT submit anything to the NHS (Compass). Compass
// integration is licensing-blocked and out of scope. The single most important
// job of this module is that the patient form AND every staff view say that
// plainly, so nobody ever believes a declaration captured here reached the NHS.
//
// `notCompass` is load-bearing and appears on the public form, the worklist, and
// the disabled 503. `/v1/nhs_claims` is read for reporting only — it is not a
// submission path and this copy must never imply otherwise.
//
// Kept out of patient-facing NHS-vs-private funding framing: the exemption
// tick-boxes ARE the declaration (so their wording is the form itself and is
// fine), but the surrounding chrome stays neutral per the project's copy rules.
// ===========================================================================

/** The env-independent kill-switch registry slug this feature is gated by. */
export const FP17_SYSTEM_SLUG = "fp17";

export const FP17_COPY = {
  /** Short module title used across staff surfaces. */
  title: "NHS exemption declarations",

  /** One-line description of the module for staff. */
  staffDescription:
    "Consent and NHS dental exemption declarations patients complete from a per-patient link. " +
    "Each declaration is stored here for the practice's records.",

  /**
   * THE LOAD-BEARING SENTENCE. On the patient form, the worklist, and the 503.
   * Never soften it and never imply Compass submission.
   */
  notCompass:
    "This records your declaration for the practice. It is not submitted to the NHS (Compass) from here.",

  /** The staff-facing variant of the same fact (second person is wrong for staff). */
  notCompassStaff:
    "These declarations are stored here for the practice's records. Nothing here is submitted to the NHS (Compass); the NHS claim is still made in Dentally.",

  /** Public form intro under the practice name. Neutral chrome, no funding framing. */
  formIntro:
    "Please confirm your consent to treatment and tell us whether you are claiming free NHS dental care. " +
    "This takes a minute and helps the practice keep an accurate record.",

  /** The declaration-truth statement the patient ticks. */
  declarationTruth:
    "The information I have given on this form is correct. I understand that giving false information may mean I have to pay for my treatment and could face a penalty charge.",

  /** The evidence acknowledgement shown for exemption claims. */
  evidenceAck:
    "I understand I may be asked to show evidence that I am entitled to free NHS dental care, and that I may have to pay if I cannot.",

  /** Front-of-form consent to the course of treatment (required). */
  consentTreatment:
    "I consent to the course of NHS dental treatment the practice has explained to me.",

  /** Optional data-sharing consent. */
  consentDataShare:
    "I am happy for the practice to keep and use these details to look after my care.",

  /**
   * The 503 body when the feature is switched off. It names the kill switch rather
   * than 404-ing (which would say the feature does not exist) or returning an empty
   * 200 (which a caller could read as "no declaration on file").
   */
  disabled:
    "NHS exemption declarations are switched off in this platform, so nothing is captured or shown here. " +
    "This is not a statement about any patient. Turning it on is a practice decision, made from System controls, " +
    "and even when on, nothing here is submitted to the NHS (Compass).",

  /** A read that failed. Explicitly NOT "there are no declarations". */
  readFailed:
    "Declarations could not be loaded. This is a failure to read them, not a finding that there are none.",

  /** A submit that failed, phrased so it never reads as a partial success. */
  saveFailed:
    "We could not save your declaration. Nothing has been stored — please try again in a moment.",

  /** Public thank-you line. */
  thanks:
    "Thank you. Your declaration has been recorded for the practice. There is nothing more you need to do.",
} as const;
