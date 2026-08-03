// What POST /api/onboarding/register can answer, and what the worklist dialogue
// must say about each answer.
//
// WHY THIS IS A MODULE AND NOT A BRANCH INSIDE THE DIALOGUE. The route used to
// compute isDentallyWriteEnabled() and then use it only as a LABEL: the create ran
// unconditionally, the response carried `dryRun: true`, and the dialogue rendered
// "Registered in Dentally / Recorded in test mode". With DENTALLY_BASE_URL unset or
// pointed at production, that "test mode" line sat under a patient who had just been
// created for real in a book of ~51,000 people. The route now refuses (503) instead,
// and the reading of that refusal lives here, in a pure function with a test, rather
// than in a React closure where it cannot be exercised.

/** A likely-existing Dentally record, as the route returns it on a dedupe hit. */
export interface RegisterMatch {
  id: string;
  name: string;
  dateOfBirth: string | null;
  site: string;
  matchedOn: string;
}

/** The JSON body POST /api/onboarding/register answers with, in every branch. */
export interface RegisterApiResponse {
  ok?: boolean;
  created?: boolean;
  duplicate?: boolean;
  match?: RegisterMatch;
  patientId?: string;
  error?: string;
}

export type RegisterOutcome =
  /** Registering is switched off upstream. NOTHING was created. */
  | { kind: "blocked"; message: string }
  | { kind: "duplicate"; match: RegisterMatch }
  | { kind: "success"; patientId: string }
  | { kind: "error"; message: string };

/**
 * The refusal, said the same way by the API and by the dialogue.
 *
 * Deliberately states that nothing was created. The old copy said the opposite
 * ("Registered in Dentally... Recorded in test mode"), which is the one sentence a
 * receptionist acts on: they close the dialogue believing the patient is on file.
 * Mirrors WRITE_GATE_OFF_PANEL in the calendar, which is the same situation.
 */
export const REGISTER_WRITES_OFF =
  "Registering a patient in Dentally is not switched on yet. Nothing has been created. Ask your administrator to enable it.";

/** The dialogue's words when the request never reached the server. */
export const REGISTER_UNREACHABLE = "Could not reach the server. Please try again.";

/** The dialogue's words for a 2xx whose body says nothing we recognise. */
export const REGISTER_UNEXPECTED = "Unexpected response from the server.";

/** The dialogue's words for a failure the server did not explain. */
export const REGISTER_FAILED = "Could not register this patient.";

/**
 * Read one register response into the state the dialogue should show.
 *
 * ORDER MATTERS. The 503 refusal is also `ok: false`, so it has to be recognised
 * BEFORE the generic failure branch, or "registering is switched off" degrades into
 * a red error box that reads like something went wrong — which invites a retry.
 *
 * `status` is the HTTP status, not res.ok, so the caller cannot pass one and forget
 * the other. A null body means the response was not JSON at all.
 */
export function classifyRegisterResponse(
  status: number,
  json: RegisterApiResponse | null,
): RegisterOutcome {
  if (!json) return { kind: "error", message: REGISTER_UNREACHABLE };
  if (status === 503) {
    return { kind: "blocked", message: json.error || REGISTER_WRITES_OFF };
  }
  const ok = status >= 200 && status < 300;
  if (!ok || json.ok === false) {
    return { kind: "error", message: json.error || REGISTER_FAILED };
  }
  if (json.duplicate && json.match) return { kind: "duplicate", match: json.match };
  if (json.created && json.patientId) return { kind: "success", patientId: json.patientId };
  return { kind: "error", message: REGISTER_UNEXPECTED };
}
