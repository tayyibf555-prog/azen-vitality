import { ageFromDob, type Gender } from "@/lib/patient/demographics";

// ===========================================================================
// THE ONE PLACE A NEW DENTALLY PATIENT IS DERIVED.
//
// WHY THIS MODULE EXISTS. Four code paths in this codebase register a patient in
// Dentally, and until now each built its own payload:
//
//     src/app/api/booking/create/route.ts      the public booking calendar
//     src/lib/agent/tools.ts                   register_patient (the 24/7 agent)
//     src/lib/copilot/tools.ts                 create_patient (the owner co-pilot)
//     src/app/api/onboarding/register/route.ts the staff worklist's one-click register
//
// On 2026-07-25 the first genuine end-to-end registration against real Dentally
// failed 422, and it kept failing on every path, because live REQUIRES four fields
// the local mock happily defaulted (DENTALLY.md; memory dentally-createpatient-422):
//
//     date_of_birth: seems to be missing
//     title:         seems to be missing
//     payment_plan:  seems to be missing
//     gender:        must be male or female     <- and it wants a BOOLEAN
//
// The booking calendar was then calibrated against a live GET probe and fixed. The
// other three were not, so three of the four paths still built a payload live would
// refuse — one of them sending `gender: "Male"`, a STRING, which live rejects
// outright. Four copies of a derivation is four chances to drift, and drift is
// exactly what happened.
//
// So the derivation lives here, once, and nothing else may re-implement it. Pure:
// no I/O, no env, no clock of its own (callers pass `now`), so every rule below is
// directly testable and is tested — see patient-payload.test.ts and the live-probe
// assertions in src/app/api/booking/create/live-calibration.test.ts.
//
// WHAT THIS MODULE WILL NOT DO. It never invents a value it was not given. A
// registration missing a title, a date of birth or a payment plan comes back as a
// REFUSAL naming exactly which fields are absent, and the caller says so in its own
// words to its own audience. Defaulting any of them would write a guess — a sex, or
// a funding regime — onto a real person's clinical record.
// ===========================================================================

/**
 * The only titles this practice uses, and the only ones any path may send.
 *
 * PROBE 2026-08-17 (GET /v1/patients, 800 real records: the 500 most recently
 * created + the 300 oldest). Every one of these five appears in live data, and
 * together they are 99.6% of it. The tail is `Dr` (2) and `Rev` (1), and both are
 * DELIBERATELY absent here — see genderFromTitle for why adding them would be a
 * clinical-data regression, not a courtesy.
 */
export const TITLES = ["Mr", "Mrs", "Miss", "Ms", "Master"] as const;
export type Title = (typeof TITLES)[number];

/**
 * Whitelist: the five titles above are the ONLY accepted values, so no arbitrary
 * string a stranger posts (booking/create is public and unauthenticated) or a
 * language model hallucinates (the agent and co-pilot call this too) can land on a
 * real patient record. Returns the canonical spelling, never the caller's.
 */
export function knownTitle(value: string | null | undefined): Title | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim().toLowerCase();
  return TITLES.find((t) => t.toLowerCase() === cleaned);
}

/**
 * Dentally carries sex as a BOOLEAN on the patient record, true = male and
 * false = female, and it is required to register.
 *
 * A DEFAULT DERIVED FROM THE TITLE, AND NOT A FACT ABOUT THE PATIENT. An earlier
 * comment claimed this was "proven against 200 real records"; the wider probe below
 * disproves the word "proven", so it is gone.
 *
 * PROBE 2026-08-17 (GET /v1/patients, 800 real records for this practice):
 *   Mr     -> true  227 / false 5      (232)
 *   Master -> true   23 / false 0       (23)
 *   Mrs    -> true    0 / false 58      (58)
 *   Miss   -> true    0 / false 157    (157)
 *   Ms     -> true    0 / false 172    (172)
 * The female titles are exact. `Mr` is right 227 times in 232 and WRONG 5 times —
 * about 2% — so this is a good starting value, not a derivation that cannot err.
 * That is the honest basis for the decision, and it is enough for one: the practice
 * corrects the record in Dentally, and nothing clinical keys off it.
 *
 * `Dr` and `Rev` are excluded from TITLES for exactly this reason. Live data gives
 * Dr -> true once and Dr -> false once, and Rev -> true once: those titles carry no
 * sex signal at all, so admitting them would mean writing a coin-flip into a real
 * patient record. If the practice ever asks for them, ASK for sex instead of
 * extending this function.
 *
 * A CALLER WHO ACTUALLY KNOWS beats this every time: buildPatientRegistration takes
 * an optional `gender`, and uses it in preference to the derivation. The co-pilot
 * has one whenever the owner stated it; the public funnel deliberately does not ask
 * (a binary male/female question in front of someone booking a check-up is off-
 * putting and adds a step for no patient benefit), so the funnel derives.
 */
export function genderFromTitle(title: Title): boolean {
  return title === "Mr" || title === "Master";
}

/** A stated sex, in Dentally's own encoding. true = male, per the probe above. */
export function genderToDentally(gender: Gender): boolean {
  return gender === "male";
}

/**
 * How the patient asked to be seen, mapped to THIS practice's own Dentally payment
 * plan ids. Whitelisted like the title: an unrecognised value is refused rather than
 * passed through.
 *
 * PROBE 2026-08-17 (GET /v1/payment_plans, all 15 active plans): id 1 IS "NHS" and
 * id 2 IS "Private", so the two ids below are confirmed against the live practice
 * rather than assumed.
 *
 * WHAT THE PROBE ALSO SHOWS, and what we are deliberately not doing about it: the
 * practice's third plan, "UDC" (id 47752), is 37% of its 500 most recent
 * registrations — more than Private's 8%. The booking page offers NHS and Private
 * only, so a walk-in urgent-care patient booking through the funnel is registered on
 * one of those two. That is a FUNNEL COPY decision for the owner, not a silent code
 * default: adding 47752 here without adding the option to the form would map nothing
 * to it, and adding the option changes what patients are asked. Left as two until
 * the owner chooses. See docs/runbooks/booking-live-calibration.md.
 *
 * NULL-PROTOTYPE, and that is load-bearing — see knownPaymentPlanId. Exported and
 * frozen so that property can be asserted directly: it is invisible from the outside
 * while the second belt in knownPaymentPlanId stands, so a test of the function alone
 * cannot tell whether it is still there.
 */
export const FUNDING_PLAN_IDS: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    nhs: 1,
    private: 2,
  }),
);

/**
 * The funding choices a form or a staff member may pick, for rendering a control.
 * The VALUE is what knownPaymentPlanId reads; the label is what a human sees.
 *
 * Never show these words to a PATIENT through an agent: project rule, patient-facing
 * agent messages must not name a funding regime. A form field and a staff dropdown
 * are not agent messages — the public booking page has asked this question since it
 * shipped — but an SMS or WhatsApp reply written by a model must not.
 */
export const FUNDING_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "nhs", label: "NHS" },
  { value: "private", label: "Private" },
];

/**
 * THIS IS THE MOCK-VS-LIVE TRAP THE CALIBRATION EXISTS TO CATCH.
 *
 * The lookup used to be a bare index into an object literal, so every key on
 * Object.prototype answered it: `funding: "constructor"` returned the Object
 * constructor, which is not `undefined`, so it sailed through the caller's
 * `=== undefined` guard and became `payment_plan_id: <function>` on the payload.
 * JSON.stringify then DROPS a function value silently, so what left the building was
 * a registration with no payment_plan at all — precisely the field live Dentally
 * 422s on ("payment_plan: seems to be missing", DENTALLY.md), while the local mock
 * accepted it happily. A public, unauthenticated caller could reach it with one word.
 *
 * Two independent belts: the map has a null prototype, and the answer must be a
 * number before it is returned. Either alone would fix it; both are cheap.
 */
export function knownPaymentPlanId(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const id = FUNDING_PLAN_IDS[value.replace(/\s+/g, " ").trim().toLowerCase()];
  return typeof id === "number" ? id : undefined;
}

/**
 * A real calendar date as YYYY-MM-DD.
 *
 * An impossible date (2001-13-40, 31 February) fails the UTC round trip rather than
 * being written through because it was merely regex-shaped. ANCHORED AT BOTH ENDS:
 * live carries a date-only string on 100% of 800 probed records, callers include a
 * public endpoint, and a timestamp or trailing junk is refused rather than truncated
 * into something that looks right.
 */
export function canonicalDob(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The oldest verified human was 122. Anything past this is a typo, not a patient. */
const MAX_AGE_YEARS = 120;

// ---------------------------------------------------------------------------
// The builder.
// ---------------------------------------------------------------------------

/**
 * What a caller knows about the person it wants to register.
 *
 * Every field is taken RAW and re-derived here, because two of the four callers are
 * driven by a language model and one is public and unauthenticated. A caller that
 * has already whitelisted a value loses nothing by passing it again.
 */
export interface PatientRegistrationInput {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  /** A title, whitelisted here against TITLES. */
  title: string | null | undefined;
  /** Date of birth in any form; only YYYY-MM-DD survives. */
  dateOfBirth: string | null | undefined;
  /** How they are to be seen ("NHS"/"Private"), whitelisted here. */
  funding?: string | null;
  /**
   * A payment plan id resolved by the caller instead of a funding name — for a
   * caller that reads the practice's configured default rather than asking. Used
   * only when `funding` maps to nothing. Must be a positive integer.
   */
  paymentPlanId?: number | null;
  /** A sex somebody actually stated. Beats the title derivation when present. */
  gender?: Gender | null;
  email?: string | null;
  phone?: string | null;
  /** Dentally's OWN site UUID. Callers map their internal id first (dentallySiteId). */
  dentallySiteId: string;
  useSms: boolean;
  useEmail: boolean;
  /** For the age sanity check. Callers pass it so this module keeps no clock. */
  now?: Date;
}

/** The fields live Dentally names in its 422, plus the two names it also requires. */
export type MissingPatientField =
  | "first_name"
  | "last_name"
  | "title"
  | "date_of_birth"
  | "payment_plan"
  | "gender";

/**
 * Exactly what goes on the wire. Optional keys are absent, never null.
 *
 * A `type` and not an `interface` on purpose: DentallyClient.createPatient takes a
 * `Record<string, unknown>`, and TypeScript grants an implicit index signature to a
 * type alias of an object type but not to an interface. So this stays precisely
 * typed here and still passes straight to the client without a cast.
 */
export type DentallyPatientPayload = {
  first_name: string;
  last_name: string;
  title: Title;
  date_of_birth: string;
  payment_plan_id: number;
  gender: boolean;
  email_address?: string;
  mobile_phone?: string;
  site_id: string;
  use_sms: boolean;
  use_email: boolean;
}

export type PatientRegistrationResult =
  | { ok: true; payload: DentallyPatientPayload }
  | { ok: false; missing: MissingPatientField[]; reason: string };

/**
 * How to name a set of missing fields to a HUMAN OR A MODEL THAT SPEAKS TO STAFF.
 *
 * Not for patients. "payment_plan" reads as a funding regime, and no patient-facing
 * agent message may name one (project rule) — an agent that cannot register someone
 * says so without explaining which field Dentally wanted.
 */
const FIELD_WORDS: Record<MissingPatientField, string> = {
  first_name: "a first name",
  last_name: "a last name",
  title: "a title (Mr, Mrs, Miss, Ms or Master)",
  date_of_birth: "a date of birth (YYYY-MM-DD)",
  payment_plan: "how they are to be seen (NHS or Private)",
  gender: "a sex",
};

/** "a title (…), a date of birth (…) and how they are to be seen (NHS or Private)" */
export function describeMissing(missing: readonly MissingPatientField[]): string {
  const words = missing.map((f) => FIELD_WORDS[f]);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * Build the registration payload live Dentally accepts, or refuse and say why.
 *
 * THE ONLY WAY ANY PATH MAY REGISTER A PATIENT. A refusal is not an error condition
 * to be logged and worked around: it means we do not know something about a real
 * person that their clinical record requires, and the caller's job is to go and ask.
 *
 * `gender` is never in `missing` on its own — it is derived from the title, so a
 * missing title is the thing to ask for. It appears only alongside `title`, which is
 * how live reported it too.
 */
export function buildPatientRegistration(
  input: PatientRegistrationInput,
): PatientRegistrationResult {
  const missing: MissingPatientField[] = [];

  const firstName = (input.firstName ?? "").trim();
  const lastName = (input.lastName ?? "").trim();
  if (!firstName) missing.push("first_name");
  if (!lastName) missing.push("last_name");

  const dob = canonicalDob(input.dateOfBirth);
  // A future date of birth (ageFromDob -> null) or an implausible age is treated as
  // ABSENT, not as a value to send: live would take 2999-01-01 without complaint and
  // the practice would inherit a record nobody can explain.
  const age = dob ? ageFromDob(dob, input.now ?? new Date()) : null;
  if (!dob || age === null || age > MAX_AGE_YEARS) missing.push("date_of_birth");

  const title = knownTitle(input.title);
  if (!title) missing.push("title");

  // The funding NAME first (what a form or a person chose), then a caller-resolved
  // id. `Number.isInteger` and `> 0` because an id is what live keys a plan by and a
  // 0/NaN/float would be a silent nonsense write.
  const resolvedPlanId =
    knownPaymentPlanId(input.funding) ??
    (typeof input.paymentPlanId === "number" &&
    Number.isInteger(input.paymentPlanId) &&
    input.paymentPlanId > 0
      ? input.paymentPlanId
      : undefined);
  if (resolvedPlanId === undefined) missing.push("payment_plan");

  // Stated beats derived; derived needs a title, so a missing title takes `gender`
  // down with it — exactly as the live 422 listed them together.
  const gender = input.gender ? genderToDentally(input.gender) : title ? genderFromTitle(title) : undefined;
  if (gender === undefined) missing.push("gender");

  // The second half is TYPE NARROWING, not a second rule: every `missing.push`
  // above is paired with exactly one of these, so an empty `missing` here means all
  // four values are present. It is written out rather than asserted away with `!` so
  // that a future edit which adds a field WITHOUT pushing its name still refuses
  // (with a slightly vaguer sentence) instead of sending an incomplete payload.
  if (missing.length > 0 || !title || !dob || resolvedPlanId === undefined || gender === undefined) {
    const named = describeMissing(missing);
    return {
      ok: false,
      missing,
      reason: named
        ? `Dentally will not create a patient without ${named}.`
        : "Dentally will not create a patient from these details.",
    };
  }

  const email = (input.email ?? "").trim();
  const phone = (input.phone ?? "").trim();

  // Key order mirrors the booking route's original literal, so a diff of what leaves
  // the building against what left it before this module existed reads clean.
  return {
    ok: true,
    payload: {
      first_name: firstName,
      last_name: lastName,
      title,
      date_of_birth: dob,
      payment_plan_id: resolvedPlanId,
      gender,
      // Absent rather than null: live treats an explicit null as a value.
      ...(email ? { email_address: email } : {}),
      ...(phone ? { mobile_phone: phone } : {}),
      site_id: input.dentallySiteId,
      use_sms: input.useSms,
      use_email: input.useEmail,
    },
  };
}

/**
 * The practice's configured default payment plan, for the ONE caller that cannot
 * ask: the 24/7 patient-facing agent.
 *
 * WHY AN ENVIRONMENT SWITCH AND NOT A CONSTANT. The booking page asks the patient
 * how they want to be seen; the co-pilot asks the owner; the worklist asks the staff
 * member. The agent can ask nobody — naming NHS or Private to a patient is forbidden
 * (project rule), and guessing writes a funding regime onto a real record. So the
 * agent registers nobody until the owner has DELIBERATELY chosen which plan a
 * conversational registration lands on, exactly the way real Dentally writes
 * themselves stay off until DENTALLY_WRITE_ENABLED is set on purpose.
 *
 * Unset (the default, and what production runs today) means the agent refuses and
 * routes the patient to the onboarding form or a colleague — a path that works now.
 *
 * Returns null for anything that is not a positive integer, so a typo in the
 * deployment config can never become a plan id.
 */
export function configuredDefaultPaymentPlanId(): number | null {
  const raw = process.env.DENTALLY_DEFAULT_PAYMENT_PLAN_ID;
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const id = Number(raw.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
