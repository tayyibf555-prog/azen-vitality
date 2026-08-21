import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import {
  patientsForSite,
  MOCK_PATIENTS,
  appointmentsForPatient,
  addPatient,
  dobForPatient,
  genderForPatient,
  paymentPlanForPatient,
  resolveMockSiteId,
  type MockPatient,
} from "@/app/api/mock-dentally/_fixtures";
import { patientCreatedAt } from "@/app/api/mock-dentally/_dashboard-fixtures";

export const dynamic = "force-dynamic";

/** Digits-only, so "+447700900001" and "07700900001" compare on suffix. */
function digits(s: string): string {
  return s.replace(/\D/g, "");
}
function phoneMatches(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  return da === db || da.endsWith(db) || db.endsWith(da);
}

/**
 * The seeded fixture's gender in LIVE Dentally's encoding: a boolean, true = male.
 * The fixture table holds "Male"/"Female" because it is written by hand and read by
 * people; the wire must carry what production carries.
 */
function genderAsLiveBoolean(patientId: string): boolean | null {
  const g = genderForPatient(patientId);
  return g === null ? null : g === "Male";
}

/** Most recent past completed appointment = the patient's last visit. */
function lastVisitAt(patientId: string): string | null {
  const past = appointmentsForPatient(patientId)
    .filter((a) => a.state === "completed")
    .sort((x, y) => (x.start_time < y.start_time ? 1 : -1));
  return past[0]?.start_time ?? null;
}

function serialise(p: MockPatient) {
  return {
    id: p.id, first_name: p.first_name, last_name: p.last_name,
    email_address: p.email_address, mobile_phone: p.mobile_phone, site_id: p.site_id,
    use_sms: p.use_sms, use_email: p.use_email, marketing: p.marketing, active: p.active,
    archived: p.archived ?? false, archived_reason: p.archived_reason ?? null,
    dentist_recall_date: p.dentist_recall_date ?? null,
    hygienist_recall_date: p.hygienist_recall_date ?? null,
    // A registered patient echoes what it was written with; a seeded one falls back
    // to the fixture generator.
    date_of_birth: p.date_of_birth ?? dobForPatient(p.id),
    // A BOOLEAN, because that is what LIVE Dentally returns — probe 2026-08-17, GET
    // /v1/patients over 800 real records: 100% boolean, true = male, zero strings.
    // This mock used to answer "Male"/"Female", and that string is why
    // normaliseGender never learned to read a boolean: every local run looked right
    // while live data normalised to "no gender on file" for every single patient.
    // The fixture table stays readable as strings and is converted here, at the wire
    // boundary, which is the only place the shape has to match.
    gender: p.gender ?? genderAsLiveBoolean(p.id),
    title: p.title ?? null,
    // Funding lives HERE, on the patient, not on the appointment. Emitted flat,
    // as live Dentally does. A patient with no plan on file carries null and must
    // resolve to no funding mark at all, never to a default.
    payment_plan_id: p.payment_plan_id ?? paymentPlanForPatient(p.id),
    last_visit_at: lastVisitAt(p.id),
    // Registration date, which the dashboard's "new patients" count needs. Without
    // it the count is genuinely unsourceable and the panel reports it as such, so a
    // deterministic date is generated per patient rather than left off.
    created_at: patientCreatedAt(p.id),
    updated_at: "2026-06-17T00:00:00Z",
  };
}

// GET /api/mock-dentally/v1/patients?site_id=&mobile_phone=&query=&page=&per_page=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const siteId = resolveMockSiteId(url.searchParams.get("site_id"));
  const phone = url.searchParams.get("mobile_phone");
  const query = url.searchParams.get("query");
  let all = siteId ? patientsForSite(siteId) : MOCK_PATIENTS;
  if (phone) all = all.filter((p) => phoneMatches(p.mobile_phone, phone));
  if (query) {
    // Dentally's `query=` is a name AND CONTACT search, and the contact half is the
    // half that matters: findPatientsByPhone (client.ts) looks a patient up by
    // sending their mobile as `query=`, because live IGNORES a `mobile_phone=`
    // filter and answers with an unfiltered page.
    //
    // PROBE 2026-08-17 (GET /v1/patients, a real patient's own mobile):
    //     query=<mobile>        -> 1 row,  and it is that patient
    //     mobile_phone=<mobile> -> 25 rows (an unfiltered default page)
    // which independently reconfirms the 2026-07-11 calibration noted on
    // findPatientsByPhone.
    //
    // THIS MOCK USED TO MATCH NAMES ONLY, so a phone lookup found nobody and every
    // local booking registered a NEW patient — the duplicate-record failure mode the
    // booking route's whole patient-resolution block exists to prevent, invisible
    // because the double could not perform the search live performs.
    const needle = query.trim().toLowerCase();
    const digitsOf = digits(needle);
    all = all.filter((p) => {
      if (`${p.first_name} ${p.last_name}`.toLowerCase().includes(needle)) return true;
      if (p.email_address && p.email_address.toLowerCase().includes(needle)) return true;
      // A phone matches across formats ("+447700900001" vs "07700 900001"), the
      // same suffix comparison the mobile_phone filter below uses.
      return digitsOf.length >= 6 && phoneMatches(p.mobile_phone, digitsOf);
    });
  }

  // PAGES FOR REAL, and applies live's per_page cap (see _paging.ts).
  //
  // This route used to ignore `page` and `per_page` outright and hand back every
  // matching row on every page. That is looser than live in BOTH directions: live
  // pages this resource (the 2026-08-17 probe recorded `mobile_phone=<mobile>`
  // answering with "25 rows (an unfiltered default page)", which is live's page size
  // showing through), and live silently drops to 25 rows for any per_page over 100.
  // A caller that walks pages until a short one could therefore be handed the same
  // rows forever here while receiving a correctly paged answer in production, and a
  // caller that asked for 500 could never discover it was only ever going to get 25.
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"));
  const start = (page - 1) * perPage;
  return Response.json({ patients: all.slice(start, start + perPage).map(serialise) });
}

function randomPatientId(): string {
  return `pat-${Math.random().toString(36).slice(2, 10)}`;
}

/* ---------------------------------------------------------------------------
 * REGISTRATION VALIDATION — the mock must refuse what LIVE Dentally refuses.
 *
 * WHY THIS EXISTS. On 2026-07-25 the first genuine end-to-end booking against real
 * Dentally failed 422 on every path that registers a patient, and it had gone
 * unnoticed for the whole build because registration had only ever been exercised
 * against THIS handler — which accepted anything, defaulted the missing fields, and
 * returned 201. A mock that is more permissive than production is not a test double,
 * it is a way of proving the wrong thing, and it cost a live failure to discover.
 *
 * WHAT LIVE REJECTED, verbatim (DENTALLY.md; memory dentally-createpatient-422):
 *     date_of_birth: seems to be missing
 *     title:         seems to be missing
 *     payment_plan:  seems to be missing
 *     gender:        must be male or female
 *
 * CALIBRATION, and the honest limit of it. The four FIELD/MESSAGE pairs above are
 * observed from the live 422. The envelope they were wrapped in was not recorded,
 * and THE RULE forbids a write to go and look, so the envelope below is this mock's
 * reconstruction: Dentally's standard `{error:{type,message}}` shape (the same one
 * _auth.ts mirrors for 401) carrying an `errors` map of the observed pairs. Callers
 * only ever read status + body text (DentallyClient throws DentallyError(status,
 * text)), so the status and the messages are what matter here and both are real.
 * Confirming the exact envelope is a step in
 * docs/runbooks/booking-live-calibration.md, for a human with authorisation.
 *
 * `gender` is checked as a BOOLEAN even though the live message says "must be male
 * or female": live patient records read back `gender` as a boolean (probe
 * 2026-08-17, 800 records: 100% boolean, true = male), and a boolean is what the
 * fixed booking route sends. A STRING is what the broken paths sent, so a string
 * must fail here — that is the whole point of this gate.
 * ------------------------------------------------------------------------- */

/** The live 422's field -> message pairs, exactly as Dentally worded them. */
const MISSING = "seems to be missing";
const GENDER_INVALID = "must be male or female";

/**
 * Every reason live Dentally would refuse this registration, in the order the
 * live error listed them. Empty means live would accept it.
 *
 * Deliberately NOT a schema library: it must stay a literal transcription of an
 * observed production error, so that a future reader can diff it against the real
 * thing without decoding a validator.
 */
function liveRejections(p: Record<string, unknown>): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const present = (k: string): boolean => {
    const v = p[k];
    return typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null;
  };
  // Dentally's own required set for a new patient (DENTALLY.md, "Creating a new
  // patient": first name*, last name*, biological sex*, date of birth*).
  if (!present("first_name")) errors.first_name = [MISSING];
  if (!present("last_name")) errors.last_name = [MISSING];
  if (!present("date_of_birth")) errors.date_of_birth = [MISSING];
  if (!present("title")) errors.title = [MISSING];
  // The payload field is `payment_plan_id`; live reported the error against
  // `payment_plan`, and that asymmetry is reproduced rather than tidied away.
  if (!present("payment_plan_id")) errors.payment_plan = [MISSING];
  // Present AND boolean. `gender: "Male"` (what copilot's create_patient sent) and
  // a missing gender both fail, which is exactly what live did.
  if (typeof p.gender !== "boolean") errors.gender = [GENDER_INVALID];
  return errors;
}

/** The 422 body, in Dentally's error envelope. See the block comment above. */
function unprocessable(errors: Record<string, string[]>): Response {
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        message: Object.entries(errors)
          .map(([field, msgs]) => `${field}: ${msgs.join(", ")}`)
          .join("; "),
        errors,
      },
    },
    { status: 422 },
  );
}

// POST /api/mock-dentally/v1/patients — register (onboard) a new patient.
// Reads the real Dentally shape { "patient": {...} }, stores it, and returns it.
export async function POST(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { type: "invalid_request_error", message: "Request body must be valid JSON." } },
      { status: 400 },
    );
  }

  const p =
    payload.patient && typeof payload.patient === "object"
      ? (payload.patient as Record<string, unknown>)
      : {};

  // BEFORE anything is stored: refuse what live would refuse, so no local run can
  // ever "prove" a registration that production would 422.
  const errors = liveRejections(p);
  if (Object.keys(errors).length > 0) return unprocessable(errors);

  const str = (k: string): string | undefined => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const bool = (k: string, dflt: boolean): boolean => (typeof p[k] === "boolean" ? (p[k] as boolean) : dflt);

  const created: MockPatient = {
    id: randomPatientId(),
    first_name: str("first_name") ?? "New",
    last_name: str("last_name") ?? "Patient",
    email_address: str("email_address") ?? str("email") ?? "",
    mobile_phone: str("mobile_phone") ?? str("phone") ?? "",
    use_sms: bool("use_sms", true),
    use_email: bool("use_email", true),
    marketing: typeof p.marketing === "number" ? (p.marketing as number) : 1,
    active: true,
    site_id: str("site_id") ?? "site-cc",
    // Echoed back rather than regenerated — liveRejections has already proven all
    // three are present and well-typed, so there is nothing left to default.
    date_of_birth: str("date_of_birth"),
    gender: p.gender as boolean,
    title: str("title"),
    payment_plan_id: typeof p.payment_plan_id === "number" ? p.payment_plan_id : undefined,
  };
  addPatient(created);
  return Response.json({ patient: serialise(created) }, { status: 201 });
}
