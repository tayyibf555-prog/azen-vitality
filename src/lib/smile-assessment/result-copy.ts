// Patient-facing "thank you" copy for the Smile Assessment quiz. Pure, no I/O.
//
// H1 fix: only a HIGH-band, fast-tracked submission is ever actually contacted
// by the practice (it is bridged into Speed-to-lead and gets an instant SMS/
// email). Every other outcome, including a MEDIUM band and a HIGH band that
// was not fast-tracked (e.g. an untrusted embed submit), must never promise a
// callback that is not going to happen. Instead it gives the patient a clear,
// warm next step they can take themselves right now: book online if the
// practice has online booking switched on, otherwise get in touch directly.
//
// `leadCreated` mirrors the submit route's own signal for "a real Speed-to-lead
// lead now exists for this contact" (see src/app/api/smile-assessment/submit/
// route.ts) — it is the one place this component-owned copy trusts the server,
// because it is a plain fact (a lead row exists / does not), not prose.
//
// British English throughout. No em dash or en dash. Never NHS, private or
// privately. No invented statistics or clinical claims, and nothing that reads
// as a diagnosis — this is a marketing questionnaire, not a clinical assessment.

import type { AssessmentBand } from "./scoring";

export function resultCopy(
  band: AssessmentBand,
  leadCreated: boolean,
  hasBookingUrl: boolean,
): string {
  if (band === "high" && leadCreated) {
    return "Thanks for sharing that with us. Someone from the practice will be in touch with you very shortly.";
  }

  if (band === "low") {
    return hasBookingUrl
      ? "Thanks for taking the time to tell us about your smile. Whenever you're ready to take things further, you're welcome to book an appointment online."
      : "Thanks for taking the time to tell us about your smile. Whenever you're ready to take things further, you're welcome to get in touch with the practice.";
  }

  // Medium band, and a high band that was not fast-tracked (leadCreated false):
  // same honest, self-service next step, no contact promise.
  return hasBookingUrl
    ? "Thanks for taking the time to tell us about your smile. Based on what you've told us, the best next step is to book an appointment online, at a time that suits you."
    : "Thanks for taking the time to tell us about your smile. Based on what you've told us, the best next step is to get in touch with the practice to arrange an appointment.";
}
