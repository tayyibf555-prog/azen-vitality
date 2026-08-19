import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST, GET } from "./route";
import { dentallySiteId } from "@/lib/mock/clients";

// ===========================================================================
// MOCK/LIVE PARITY FOR REGISTRATION — the mock must refuse what live refuses.
//
// THE DEFECT THIS FILE EXISTS TO MAKE IMPOSSIBLE. Every path that registers a
// patient was validated only against this mock, which accepted anything and
// defaulted the rest. On 2026-07-25 the first genuine end-to-end booking against
// real Dentally returned 422 on all four of them (DENTALLY.md; memory
// dentally-createpatient-422):
//
//     date_of_birth: seems to be missing
//     title:         seems to be missing
//     payment_plan:  seems to be missing
//     gender:        must be male or female
//
// A green suite had proven nothing, because the double was more forgiving than the
// thing it doubled. So these tests are written from BOTH directions:
//
//   1. a payload live rejected must now 422 here, field by field, and
//   2. the payload the REAL registration paths derive must be ACCEPTED here —
//      pinning the two halves against each other so neither can drift alone.
//
// (2) is the half that matters most. A validator that merely rejects things is
// easy and useless; what earns confidence is that the exact bytes our production
// code sends pass a gate calibrated to production's own rules.
//
// FOUR PATHS, NOT ONE (added 2026-08-18). Fixing the booking calendar in isolation
// is what let this rot for three weeks: the calendar was calibrated and green while
// the agent, the co-pilot and the onboarding worklist each still built their own
// payload, and each was missing something live demands. The block at the foot of
// this file runs ALL FOUR real code paths and feeds whatever they actually send
// into the REAL mock handler above. There is no payload literal to keep in sync,
// because there is no payload literal: the assertion is that the code, as written,
// gets past a gate calibrated to production's own rules.
// ===========================================================================

const SITE_UUID = dentallySiteId("site-cc");

function post(patient: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/mock-dentally/v1/patients", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ patient }),
    }),
  );
}

/**
 * The payload src/app/api/booking/create/route.ts builds for a first-time patient.
 * Kept byte-identical to the object literal in that route's createPatient call;
 * create-route.test.ts asserts the route really produces this shape, and this file
 * asserts the mock accepts it. Together they close the loop.
 */
function routeDerivedPayload(overrides: Record<string, unknown> = {}) {
  return {
    first_name: "Alex",
    last_name: "Patient",
    title: "Mr",
    date_of_birth: "1990-03-14",
    payment_plan_id: 1,
    gender: true,
    email_address: "alex@example.com",
    mobile_phone: "+447700900123",
    site_id: SITE_UUID,
    use_sms: true,
    use_email: true,
    ...overrides,
  };
}

interface ErrorBody {
  error: { type: string; message: string; errors: Record<string, string[]> };
}

describe("mock POST /v1/patients rejects exactly what live Dentally rejected", () => {
  it("422s the under-specified payload that failed live, naming all four fields at once", async () => {
    // What the broken paths used to send: names, contact, site — and none of the
    // four fields live demanded.
    const res = await post({
      first_name: "Alex",
      last_name: "Patient",
      mobile_phone: "+447700900123",
      site_id: SITE_UUID,
    });

    expect(res.status, "live answered 422, so the mock must too").toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.type).toBe("invalid_request_error");
    // The four live field/message pairs, verbatim.
    expect(body.error.errors).toEqual({
      date_of_birth: ["seems to be missing"],
      title: ["seems to be missing"],
      payment_plan: ["seems to be missing"],
      gender: ["must be male or female"],
    });
  });

  it.each([
    ["date_of_birth", "seems to be missing"],
    ["title", "seems to be missing"],
    ["payment_plan", "seems to be missing"],
  ])("422s when only %s is missing", async (field, message) => {
    // The payload field is payment_plan_id; live reported it as payment_plan.
    const key = field === "payment_plan" ? "payment_plan_id" : field;
    const payload = routeDerivedPayload();
    delete (payload as Record<string, unknown>)[key];

    const res = await post(payload);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.errors[field]).toEqual([message]);
    // ONLY that field: a validator that fails everything would pass the test above
    // while telling a human nothing about which half broke.
    expect(Object.keys(body.error.errors)).toEqual([field]);
  });

  it("422s a STRING gender, which is what the copilot path actually sent", async () => {
    // create_patient sent gender: "Male". Live wanted a boolean and said so with
    // "must be male or female" — a message that reads like it wants that very
    // string, which is presumably how the bug survived review.
    for (const gender of ["Male", "male", "M", 1, null, undefined]) {
      const res = await post(routeDerivedPayload({ gender }));
      expect(res.status, `gender: ${JSON.stringify(gender)} must be refused`).toBe(422);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.errors.gender).toEqual(["must be male or female"]);
    }
  });

  it("422s an empty-string field, not just an absent one", async () => {
    const res = await post(routeDerivedPayload({ title: "   ", date_of_birth: "" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.errors.title).toEqual(["seems to be missing"]);
    expect(body.error.errors.date_of_birth).toEqual(["seems to be missing"]);
  });

  it("422s a missing name, the other half of Dentally's required set", async () => {
    // DENTALLY.md, "Creating a new patient": first name*, last name*, biological
    // sex*, date of birth* are the asterisked (required) fields.
    const res = await post(routeDerivedPayload({ first_name: undefined, last_name: "" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.errors.first_name).toEqual(["seems to be missing"]);
    expect(body.error.errors.last_name).toEqual(["seems to be missing"]);
  });

  it("stores NOTHING when it refuses", async () => {
    const before = await patientCount();
    await post({ first_name: "Ghost", last_name: "Record", site_id: SITE_UUID });
    expect(await patientCount(), "a refused registration must not appear in the book").toBe(before);
  });
});

describe("mock POST /v1/patients accepts the payload the booking route derives", () => {
  it("201s the real route's payload and echoes the four fields back", async () => {
    const res = await post(routeDerivedPayload());

    expect(res.status, "the fixed booking route must pass a live-calibrated gate").toBe(201);
    const body = (await res.json()) as { patient: Record<string, unknown> };
    expect(body.patient.first_name).toBe("Alex");
    // Echoed from the payload, not regenerated from a fixture table that has never
    // heard of this id — a just-registered patient reads back complete.
    expect(body.patient.date_of_birth).toBe("1990-03-14");
    expect(body.patient.title).toBe("Mr");
    expect(body.patient.payment_plan_id).toBe(1);
    expect(body.patient.gender).toBe(true);
  });

  it("accepts both funding ids the booking page offers (probe: 1 = NHS, 2 = Private)", async () => {
    for (const payment_plan_id of [1, 2]) {
      const res = await post(routeDerivedPayload({ payment_plan_id }));
      expect(res.status).toBe(201);
    }
  });

  it("accepts gender false as readily as true (Mrs/Miss/Ms derive false)", async () => {
    const res = await post(routeDerivedPayload({ title: "Mrs", gender: false }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { patient: Record<string, unknown> };
    expect(body.patient.gender).toBe(false);
  });
});

describe("mock GET /v1/patients carries LIVE's gender encoding", () => {
  it("returns gender as a BOOLEAN, never the string the fixture table holds", async () => {
    // PROBE 2026-08-17 (GET /v1/patients, 800 real records): gender is a boolean on
    // 100% of them, true = male. The mock used to serve "Male"/"Female", and that
    // string is why normaliseGender never learned to read a boolean — every local
    // run looked correct while live data normalised to "no gender on file" for
    // every patient in the practice.
    const res = await GET(
      new Request(`http://localhost/api/mock-dentally/v1/patients?site_id=${SITE_UUID}`, {
        headers: { authorization: "Bearer test-token" },
      }),
    );
    const body = (await res.json()) as { patients: Array<Record<string, unknown>> };
    expect(body.patients.length).toBeGreaterThan(0);

    const withGender = body.patients.filter((p) => p.gender !== null);
    expect(withGender.length, "the fixtures must still carry some gender").toBeGreaterThan(0);
    for (const p of withGender) {
      expect(typeof p.gender, `patient ${String(p.id)} must carry live's encoding`).toBe("boolean");
    }
  });
});

async function patientCount(): Promise<number> {
  const res = await GET(
    new Request(`http://localhost/api/mock-dentally/v1/patients?site_id=${SITE_UUID}`, {
      headers: { authorization: "Bearer test-token" },
    }),
  );
  const body = (await res.json()) as { patients: unknown[] };
  return body.patients.length;
}

// ===========================================================================
// ALL FOUR REGISTRATION PATHS, THROUGH THE REAL GATE.
//
// Every path in this codebase that creates a Dentally patient is driven here FOR
// REAL, and its `createPatient` call is wired to the mock handler at the top of
// this file — the one calibrated to live's own 422. Nothing is asserted about a
// payload literal, because a literal in a test is just a fifth copy of the thing
// that drifted. What is asserted is that the code, as it stands, gets in.
//
//   src/app/api/booking/create/route.ts       the public booking calendar
//   src/lib/agent/tools.ts                    register_patient (the 24/7 agent)
//   src/lib/copilot/tools.ts                  create_patient (the owner co-pilot)
//   src/app/api/onboarding/register/route.ts  the staff worklist's one-click register
//
// Three of the four used to fail this. The agent sent no title, no date of birth
// and no payment plan; the co-pilot sent `gender: "Male"`, a STRING, and no title
// or plan; the worklist sent no title, no plan, no sex, and a date of birth only
// when the form had happened to ask for one. The "OLD PAYLOADS" block at the end
// replays exactly what each of them used to send, and watches the gate refuse it.
// ===========================================================================

const KEY = "parity-key";

/** Every payload that reached the mock this test, with what the mock answered. */
interface WireCall {
  payload: Record<string, unknown>;
  status: number;
  body: unknown;
}
const wire: WireCall[] = [];

/**
 * THE SEAM. Stands exactly where DentallyClient.createPatient stands — same body
 * envelope, same "throw DentallyError(status, text) on a non-2xx" contract — but
 * pointed at the mock handler in this very file. So a path that builds a payload
 * live would refuse fails HERE, in a unit test, instead of in front of a patient.
 */
async function createPatientThroughTheMock(
  payload: Record<string, unknown>,
): Promise<{ patient: { id: string } }> {
  const res = await post(payload);
  const text = await res.clone().text();
  wire.push({
    payload,
    status: res.status,
    body: JSON.parse(text) as unknown,
  });
  if (!res.ok) throw new ParityDentallyError(res.status, text);
  return (await res.json()) as { patient: { id: string } };
}

/** Mirrors DentallyError's shape (name + status) without importing the client. */
class ParityDentallyError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Dentally ${status}: ${body}`);
    this.name = "DentallyError";
  }
}

const lastWire = (): WireCall => wire[wire.length - 1]!;

// --- The seams every path reaches Dentally through. -------------------------
const seam = vi.hoisted(() => ({
  createPatient: vi.fn(),
  findPatientsByPhone: vi.fn(async () => ({ patients: [] as unknown[] })),
  createAppointment: vi.fn(async () => ({ appointment: { id: "appt-parity" } })),
  getAvailability: vi.fn(async () => ({ availability: [] as unknown[] })),
  listPractitioners: vi.fn(async (siteId: string) => ({
    practitioners: [{ id: 101, active: true, site_id: siteId }],
  })),
  getSubmission: vi.fn(),
  setStatus: vi.fn(async () => undefined),
  searchPatients: vi.fn(async () => [] as unknown[]),
  listPatientsRaw: vi.fn(async () => ({ patients: [] as unknown[] })),
  logCopilotAction: vi.fn(async () => undefined),
}));

// The owner kill switch (booking/create reads it fail-closed): on, so the case is
// about the payload and nothing else. Its own behaviour is tested where it lives.
// copilot/tools.ts now reaches the Speed-to-lead contact path (the co-pilot can
// nudge a lead), which opens with `import "server-only"` — a Next.js marker package
// that is not installed and that vitest cannot resolve. Stubbed to an empty module,
// which is exactly what it is at runtime on the server.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
}));
// The write gate: open, and dentallyAgentClient() hands back the seam above. The
// REAL buildManualBookingPayload is kept, so the appointment write stays honest.
vi.mock("@/lib/dentally/write", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    isDentallyWriteEnabled: () => true,
    dentallyAgentClient: () => ({
      getAvailability: seam.getAvailability,
      listPractitioners: seam.listPractitioners,
      findPatientsByPhone: seam.findPatientsByPhone,
      createPatient: seam.createPatient,
      createAppointment: seam.createAppointment,
    }),
  };
});
// Reads, shared by the co-pilot's dedupe and the worklist's dedupe: nobody matches,
// so every case below reaches the create rather than short-circuiting on a duplicate.
vi.mock("@/lib/dentally/read", () => ({
  searchPatients: (...a: unknown[]) => seam.searchPatients(...(a as [])),
  dentallyFromEnv: () => ({ listPatients: (...a: unknown[]) => seam.listPatientsRaw(...(a as [])) }),
  dentallyReadKey: () => "parity-read-key",
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
}));
vi.mock("@/lib/copilot/actions", () => ({
  logCopilotAction: (...a: unknown[]) => seam.logCopilotAction(...(a as [])),
}));
vi.mock("@/lib/onboarding/repository", () => ({
  getSubmission: (...a: unknown[]) => seam.getSubmission(...(a as [])),
  setStatus: (...a: unknown[]) => seam.setStatus(...(a as [])),
}));
// Auth and the per-person capability gate: proven where they live (module-api-guard,
// capability-guard, and the fs coverage sweeps). Open here so these cases stay about
// the payload.
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => ({
    id: "u1",
    email: "owner@vitality.test",
    role: "client_owner",
    clientId: "vitality",
    siteIds: ["site-cc", "site-rv", "site-ng"],
  }),
  requireClientAccess: () => null,
  requireModuleApiAccess: () => null,
}));
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));

import { POST as BOOKING_CREATE } from "@/app/api/booking/create/route";
import { POST as ONBOARDING_REGISTER } from "@/app/api/onboarding/register/route";
import { makeDispatch } from "@/lib/agent/tools";
import { makeCopilotDispatch } from "@/lib/copilot/tools";
import { mintSubmitToken } from "@/lib/smile-assessment/embed-token";

// A slot safely in the future and inside the booking horizon, for the two paths
// that book as well as register.
const SLOT_START = (() => {
  const d = new Date(Date.now() + 3 * 86_400_000);
  d.setUTCHours(10, 0, 0, 0);
  return d.toISOString();
})();
const SLOT_FINISH = new Date(Date.parse(SLOT_START) + 30 * 60_000).toISOString();

// A distinct handset per booking attempt: booking/create keeps an in-process
// per-phone cap that persists for the life of the module.
let handset = 0;
const nextPhone = () => `07700 93${String((handset += 1)).padStart(4, "0")}`;

beforeEach(() => {
  vi.clearAllMocks();
  wire.length = 0;
  seam.createPatient.mockImplementation(createPatientThroughTheMock);
  seam.findPatientsByPhone.mockResolvedValue({ patients: [] });
  seam.createAppointment.mockResolvedValue({ appointment: { id: "appt-parity" } });
  seam.getAvailability.mockResolvedValue({
    availability: [{ start_time: SLOT_START, finish_time: SLOT_FINISH, practitioner_id: 101 }],
  });
  seam.listPractitioners.mockImplementation(async (siteId: string) => ({
    practitioners: [{ id: 101, active: true, site_id: siteId }],
  }));
  seam.searchPatients.mockResolvedValue([]);
  seam.listPatientsRaw.mockResolvedValue({ patients: [] });
  seam.logCopilotAction.mockResolvedValue(undefined);
  seam.setStatus.mockResolvedValue(undefined);
  seam.getSubmission.mockResolvedValue({
    id: "sub-parity",
    clientId: "vitality",
    siteId: "site-cc",
    firstName: "Priya",
    lastName: "Kaur",
    dateOfBirth: "1988-09-21",
    phone: "07700940001",
    email: "priya.kaur@example.co.uk",
    address: null,
    medical: null,
    dental: null,
    heardAbout: null,
    files: [],
    consent: null,
    custom: null,
    status: "reviewed",
    createdAt: "2026-08-01T00:00:00Z",
  });
  vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", KEY);
  // The practice has chosen which plan a conversational registration lands on.
  // Unset (production today) the agent registers nobody — proven in agent/tools.test.ts.
  vi.stubEnv("DENTALLY_DEFAULT_PAYMENT_PLAN_ID", "1");
});
afterEach(() => vi.unstubAllEnvs());

// --- The four drivers. Each returns the payload its path actually sent. ------

let requestIp = 0;
async function driveBookingCalendar(): Promise<Record<string, unknown>> {
  requestIp += 1;
  const res = await BOOKING_CREATE(
    new Request("http://localhost/api/booking/create", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${requestIp % 250}` },
      body: JSON.stringify({
        clientSlug: "vitality",
        siteId: "site-cc",
        slotStart: SLOT_START,
        finish: SLOT_FINISH,
        title: "Miss",
        firstName: "Nadia",
        lastName: "Okafor",
        dateOfBirth: "1994-02-17",
        funding: "Private",
        phone: nextPhone(),
        email: "nadia.okafor@example.co.uk",
        pageToken: mintSubmitToken("vitality", new Date(), KEY),
      }),
    }),
  );
  expect(res.status, "the booking calendar must complete its booking").toBe(200);
  return lastWire().payload;
}

async function driveAgent(): Promise<Record<string, unknown>> {
  const dispatch = makeDispatch({
    dentally: {
      getAvailability: seam.getAvailability,
      listPractitioners: seam.listPractitioners,
      createPatient: seam.createPatient,
      createAppointment: seam.createAppointment,
      getPatientAppointments: vi.fn(),
      updateAppointment: vi.fn(),
      cancelAppointment: vi.fn(),
    } as never,
    context: {
      patientId: "lead:+447403097500",
      siteId: "site-cc",
      patientName: "there",
      treatment: null,
      fundingType: null,
      phone: "+447403097500",
      isKnownPatient: false,
    } as never,
    writesEnabled: true,
  });
  const out = JSON.parse(
    await dispatch("register_patient", {
      firstName: "Tomasz",
      lastName: "Nowak",
      title: "Mr",
      dateOfBirth: "1979-06-30",
      email: "tomasz.nowak@example.co.uk",
    }),
  ) as { registered: boolean };
  expect(out.registered, "the agent must complete its registration").toBe(true);
  return lastWire().payload;
}

async function driveCopilot(): Promise<Record<string, unknown>> {
  const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");
  const out = JSON.parse(
    await dispatch("create_patient", {
      firstName: "Grace",
      lastName: "Adeyemi",
      title: "Ms",
      dateOfBirth: "1972-11-05",
      funding: "Private",
      phone: "07700940222",
      email: "grace.adeyemi@example.co.uk",
      confirm: true,
    }),
  ) as { created: boolean };
  expect(out.created, "the co-pilot must complete its creation").toBe(true);
  return lastWire().payload;
}

async function driveOnboardingWorklist(): Promise<Record<string, unknown>> {
  const res = await ONBOARDING_REGISTER(
    new Request("http://localhost/api/onboarding/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // title + funding are the staff member's choice in the confirm dialogue.
      body: JSON.stringify({ submissionId: "sub-parity", title: "Mrs", funding: "NHS" }),
    }),
  );
  expect(res.status, "the onboarding worklist must complete its registration").toBe(200);
  return lastWire().payload;
}

const SITES: ReadonlyArray<[string, () => Promise<Record<string, unknown>>]> = [
  ["the public booking calendar", driveBookingCalendar],
  ["the 24/7 agent's register_patient", driveAgent],
  ["the owner co-pilot's create_patient", driveCopilot],
  ["the onboarding worklist's register", driveOnboardingWorklist],
];

describe("every registration path passes the live-calibrated gate", () => {
  it.each(SITES)("%s is ACCEPTED, and sends all four fields live demands", async (_name, drive) => {
    const payload = await drive();
    const answered = lastWire();

    expect(answered.status, "live would have created this patient").toBe(201);
    // The four fields the live 422 named, each present and each the right SHAPE.
    expect(typeof payload.title).toBe("string");
    expect(payload.date_of_birth as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof payload.payment_plan_id).toBe("number");
    // A BOOLEAN. The co-pilot sent the string "Male" and the other two sent nothing
    // at all; live answers "must be male or female" to both.
    expect(typeof payload.gender).toBe("boolean");
    // And the identity half of live's required set.
    expect(payload.first_name).toBeTruthy();
    expect(payload.last_name).toBeTruthy();
    // Dentally's own site UUID, never our internal "site-cc".
    expect(payload.site_id).toBe(SITE_UUID);
  });

  it.each(SITES)(
    "%s would be REFUSED, in live's own words, if it ever dropped one of them again",
    async (_name, drive) => {
      const payload = await drive();

      for (const [field, key, message] of [
        ["date_of_birth", "date_of_birth", "seems to be missing"],
        ["title", "title", "seems to be missing"],
        // The payload field is payment_plan_id; live reported it as payment_plan.
        ["payment_plan", "payment_plan_id", "seems to be missing"],
        ["gender", "gender", "must be male or female"],
      ] as const) {
        const without = { ...payload };
        delete (without as Record<string, unknown>)[key];
        const res = await post(without);
        expect(res.status, `dropping ${key} must 422`).toBe(422);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.type).toBe("invalid_request_error");
        expect(body.error.errors[field]).toEqual([message]);
        expect(Object.keys(body.error.errors)).toEqual([field]);
      }
    },
  );

  it("sends a boolean sex derived from the title, and gets the live majority right", async () => {
    // Every path derives sex from the title rather than asking (the co-pilot uses a
    // stated one when the owner gave it). The four drivers above choose Miss, Mr, Ms
    // and Mrs between them, so this covers a real spread rather than one branch.
    const expected: Record<string, boolean> = { Mr: true, Master: true, Mrs: false, Miss: false, Ms: false };
    for (const [, drive] of SITES) {
      const payload = await drive();
      const title = payload.title as string;
      expect(payload.gender, `${title} follows its live majority`).toBe(expected[title]);
    }
  });

  it("registers against a payment plan that genuinely exists at this practice", async () => {
    // PROBE 2026-08-17, GET /v1/payment_plans: 1 IS "NHS" and 2 IS "Private". A path
    // that invented an id would be accepted by any validator that only checks the
    // TYPE, so the value is pinned to the two the practice actually offers online.
    for (const [name, drive] of SITES) {
      const payload = await drive();
      expect([1, 2], `${name} must use a real plan id`).toContain(payload.payment_plan_id);
    }
  });
});

// ---------------------------------------------------------------------------
// THE OLD PAYLOADS. What each broken path used to send, replayed against the gate.
//
// This is the regression stated as evidence rather than as prose: if someone
// reverts one of the four call sites to the shape it had on 2026-08-17, this is the
// failure they see, and it names the site.
// ---------------------------------------------------------------------------
describe("the payloads these paths used to send are refused, one site at a time", () => {
  it.each([
    [
      "the 24/7 agent's register_patient",
      {
        first_name: "Tomasz",
        last_name: "Nowak",
        email_address: "tomasz.nowak@example.co.uk",
        mobile_phone: "+447403097500",
        site_id: SITE_UUID,
        use_sms: true,
        use_email: true,
      },
      ["date_of_birth", "title", "payment_plan", "gender"],
    ],
    [
      "the owner co-pilot's create_patient",
      {
        first_name: "Grace",
        last_name: "Adeyemi",
        date_of_birth: "1972-11-05",
        email_address: "grace.adeyemi@example.co.uk",
        mobile_phone: "+447700940222",
        // THE STRING. Live carries sex as a boolean on 100% of 800 probed records and
        // answers "must be male or female" to anything else — a message that reads
        // like it wants this very string, which is presumably how the bug survived.
        gender: "Female",
        site_id: SITE_UUID,
        use_sms: true,
        use_email: true,
      },
      ["title", "payment_plan", "gender"],
    ],
    [
      "the onboarding worklist's register",
      {
        first_name: "Priya",
        last_name: "Kaur",
        date_of_birth: "1988-09-21",
        email_address: "priya.kaur@example.co.uk",
        mobile_phone: "+447700940001",
        site_id: SITE_UUID,
        use_sms: true,
        use_email: true,
      },
      ["title", "payment_plan", "gender"],
    ],
  ] as const)("%s: 422, naming %#", async (_name, oldPayload, expectedFields) => {
    const before = await patientCount();
    const res = await post(oldPayload as unknown as Record<string, unknown>);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(Object.keys(body.error.errors).sort()).toEqual([...expectedFields].sort());
    expect(await patientCount(), "a refused registration creates nobody").toBe(before);
  });
});
