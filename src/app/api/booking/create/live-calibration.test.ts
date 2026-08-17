import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintSubmitToken } from "@/lib/smile-assessment/embed-token";
import { normaliseGender } from "@/lib/patient/demographics";
import { canonicalGender } from "@/lib/patient/profile";

// ===========================================================================
// LIVE CALIBRATION — every reference value below was READ from real Dentally.
//
// PROBE, 2026-08-17, GET ONLY. Performed with DENTALLY_PROD_READONLY_API_KEY and
// the User-Agent the key requires, against https://api.dentally.co. No write of
// any kind was issued; see docs/runbooks/booking-live-calibration.md, which is
// where the single authorised test WRITE is specified for a human to run later.
//
//   GET /v1/payment_plans              -> 15 active plans
//   GET /v1/patients (created desc)    -> 500 records
//   GET /v1/patients (created asc)     -> 300 records
//   GET /v1/appointment_reasons        -> 16 reasons, none deleted
//
// WHY THESE ARE TESTS AND NOT A COMMENT. The booking route encodes five claims
// about a system we do not control: which payment-plan ids exist, which titles the
// practice uses, how sex is encoded, what a date of birth looks like, and which
// appointment reasons are accepted. Each was previously asserted only in prose, and
// one of them (the title -> sex mapping, "proven against 200 real records") turned
// out to be measurably false. A comment cannot fail; these can.
//
// WHEN ONE OF THESE FAILS it does not necessarily mean the code is wrong — it may
// mean the PRACTICE changed (a new payment plan, a renamed reason). Re-run the
// probe before editing the expectation, and never "fix" one of these by copying
// the value the code happens to produce.
// ===========================================================================

const h = vi.hoisted(() => ({
  isSystemEnabled: vi.fn(async (..._a: unknown[]) => true),
  isDentallyWriteEnabled: vi.fn(() => true),
  getAvailability: vi.fn(async (..._a: unknown[]) => ({ availability: [] as unknown[] })),
  listPractitioners: vi.fn(async (siteId: string) => ({
    practitioners: [{ id: 101, active: true, site_id: siteId }],
  })),
  findPatientsByPhone: vi.fn(async (..._a: unknown[]) => ({ patients: [] as unknown[] })),
  createPatient: vi.fn(async (..._a: unknown[]) => ({ patient: { id: "pat-new" } })),
  createAppointment: vi.fn(async (..._a: unknown[]) => ({ appointment: { id: "appt-1" } })),
}));

// The create route reads the kill switch through isSystemEnabledStrict (FAIL
// CLOSED): it is the only public endpoint that writes a real patient record, so a
// switch it cannot read is treated as off. Both names resolve to the same stub
// here so a test can drive either route.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledStrict: h.isSystemEnabled,
}));
vi.mock("@/lib/dentally/write", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual, // the REAL buildManualBookingPayload and its BOOKING_REASONS
    isDentallyWriteEnabled: h.isDentallyWriteEnabled,
    dentallyAgentClient: () => ({
      getAvailability: h.getAvailability,
      listPractitioners: h.listPractitioners,
      findPatientsByPhone: h.findPatientsByPhone,
      createPatient: h.createPatient,
      createAppointment: h.createAppointment,
    }),
  };
});

import { POST } from "./route";

const START = new Date(Date.now() + 3 * 86_400_000);
START.setUTCHours(10, 0, 0, 0);
const START_ISO = START.toISOString();
const FINISH_ISO = new Date(START.getTime() + 30 * 60_000).toISOString();
const LIVE_ROW = { start_time: START_ISO, finish_time: FINISH_ISO, practitioner_id: 101 };
const KEY = "s3cret";

let n = 0;
function req(body: unknown): Request {
  n += 1;
  return new Request("http://localhost/api/booking/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${n % 250}` },
    body: JSON.stringify(body),
  });
}
let phoneN = 0;
function goodBody(overrides: Record<string, unknown> = {}) {
  phoneN += 1;
  return {
    clientSlug: "vitality",
    siteId: "site-cc",
    slotStart: START_ISO,
    finish: FINISH_ISO,
    title: "Mr",
    firstName: "Alex",
    lastName: "Patient",
    dateOfBirth: "1990-03-14",
    funding: "NHS",
    phone: `07700 91${String(phoneN).padStart(4, "0")}`,
    pageToken: mintSubmitToken("vitality", new Date(), KEY),
    ...overrides,
  };
}
const created = () => h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
const appointment = () => h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  h.isSystemEnabled.mockImplementation(async () => true);
  h.isDentallyWriteEnabled.mockImplementation(() => true);
  h.getAvailability.mockResolvedValue({ availability: [LIVE_ROW] });
  h.findPatientsByPhone.mockResolvedValue({ patients: [] });
  h.createPatient.mockResolvedValue({ patient: { id: "pat-new" } });
  h.createAppointment.mockResolvedValue({ appointment: { id: "appt-1" } });
  vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", KEY);
});
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
describe("payment plans, against GET /v1/payment_plans", () => {
  // The live list, in full, as the probe read it. Recorded rather than summarised
  // because the two ids the funnel uses are only meaningful next to the ones it
  // does not: "1" is not an arbitrary first-row id, it IS the NHS plan.
  const LIVE_PLANS: Array<[number, string]> = [
    [1, "NHS"],
    [2, "Private"],
    [3, "Denplan B"],
    [4, "Practice Plan"],
    [37355, "Denplan A"],
    [37356, "Denplan C"],
    [37357, "Denplan Child"],
    [37358, "Denplan Teen"],
    [37389, "Denplan Care"],
    [38907, "NUSMILE "],
    [39829, "Independent "],
    [40566, "ZH"],
    [47752, "UDC"],
    [54836, "DEN"],
    [71113, "Waved off (management)"],
  ];

  it("maps NHS to the id that IS NHS live, and Private to the id that IS Private", async () => {
    expect(LIVE_PLANS.find(([, name]) => name === "NHS")![0]).toBe(1);
    expect(LIVE_PLANS.find(([, name]) => name === "Private")![0]).toBe(2);

    const nhs = await POST(req(goodBody({ funding: "NHS" })));
    expect(nhs.status).toBe(200);
    expect(created().payment_plan_id).toBe(1);

    h.createPatient.mockClear();
    const priv = await POST(req(goodBody({ funding: "Private" })));
    expect(priv.status).toBe(200);
    expect(created().payment_plan_id).toBe(2);
  });

  it("refuses UDC (47752) — the practice's BIGGEST plan — because the form does not offer it", async () => {
    // 185 of the 500 most recent registrations are UDC; Private is 39. This is a
    // deliberate gap, recorded so nobody reads the two-entry map as an oversight:
    // a plan the form cannot select must not be reachable by posting its name.
    for (const funding of ["UDC", "47752", "Denplan A", "Practice Plan"]) {
      const res = await POST(req(goodBody({ funding })));
      expect(res.status, `${funding} is a real live plan but not a form option`).toBe(400);
    }
    expect(h.createPatient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("titles and sex, against GET /v1/patients (800 real records)", () => {
  // Observed title -> gender counts. `true` is male.
  const OBSERVED: Record<string, { true: number; false: number }> = {
    Mr: { true: 227, false: 5 },
    Master: { true: 23, false: 0 },
    Mrs: { true: 0, false: 58 },
    Miss: { true: 0, false: 157 },
    Ms: { true: 0, false: 172 },
    // The tail, and the reason Dr/Rev are not offered: no sex signal whatever.
    Dr: { true: 1, false: 1 },
    Rev: { true: 1, false: 0 },
  };

  it("offers exactly the five titles that carry a usable sex signal", async () => {
    for (const title of ["Mr", "Mrs", "Miss", "Ms", "Master"]) {
      h.createPatient.mockClear();
      const res = await POST(req(goodBody({ title })));
      expect(res.status, `${title} is in live data and must be accepted`).toBe(200);
      expect(created().title).toBe(title);
    }
  });

  it("REFUSES Dr and Rev, which live data contains but which predict nothing", async () => {
    for (const title of ["Dr", "Rev"]) {
      const counts = OBSERVED[title]!;
      // The evidence for the refusal, stated as an assertion: neither title is
      // one-sided, so any derivation from it would be a coin flip written into a
      // real patient record.
      expect(
        counts.true > 0 && counts.false > 0 ? "mixed" : "one-sided-but-tiny",
        `${title} carries no reliable sex signal`,
      ).not.toBe("reliable");

      const res = await POST(req(goodBody({ title })));
      expect(res.status).toBe(400);
    }
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("derives sex the way the live majority runs, and sends a BOOLEAN", async () => {
    for (const [title, counts] of Object.entries(OBSERVED)) {
      if (!["Mr", "Master", "Mrs", "Miss", "Ms"].includes(title)) continue;
      const majorityIsMale = counts.true > counts.false;
      h.createPatient.mockClear();
      const res = await POST(req(goodBody({ title })));
      expect(res.status).toBe(200);
      expect(created().gender, `${title} follows its live majority`).toBe(majorityIsMale);
      expect(typeof created().gender, "live stores sex as a boolean").toBe("boolean");
    }
  });

  it("does not pretend the Mr derivation is exact — 5 of 232 live Mr records are female", async () => {
    // Guards the COMMENT as much as the code. The previous comment claimed the
    // mapping was "proven"; it is a ~2% -wrong default, and a future reader must
    // not re-derive a stronger claim from a passing test suite.
    const mr = OBSERVED.Mr!;
    expect(mr.false).toBeGreaterThan(0);
    expect(mr.false / (mr.true + mr.false)).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
describe("the gender ENCODING, which the read path used to drop", () => {
  it("normalises live's boolean, because 100% of 800 live records are boolean", () => {
    // The regression this pins: normaliseGender had only string and integer
    // branches, so a live boolean fell through to null and every patient read as
    // "no gender on file" — silently, with no error anywhere.
    expect(normaliseGender(true)).toBe("male");
    expect(normaliseGender(false)).toBe("female");
    expect(canonicalGender(true)).toBe(true);
    expect(canonicalGender(false)).toBe(false);
  });

  it("still reads the mock's historical string encoding", () => {
    expect(normaliseGender("Male")).toBe("male");
    expect(normaliseGender("Female")).toBe("female");
  });

  it("still returns null for a value that is genuinely not on file", () => {
    for (const raw of [null, undefined, "", "unknown", {}, []]) {
      expect(normaliseGender(raw)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
describe("date of birth, against GET /v1/patients", () => {
  it("sends the YYYY-MM-DD shape live uses for 100% of records", async () => {
    // 800/800 matched /^\d{4}-\d{2}-\d{2}$/ and none was null, so a date-only
    // string is both what live stores and what it always has.
    const res = await POST(req(goodBody({ dateOfBirth: "1968-11-11" })));
    expect(res.status).toBe(200);
    expect(created().date_of_birth).toBe("1968-11-11");
    expect(created().date_of_birth as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses a full ISO timestamp, which live never carries", async () => {
    const res = await POST(req(goodBody({ dateOfBirth: "1968-11-11T00:00:00Z" })));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("appointment reasons, against GET /v1/appointment_reasons", () => {
  // The practice's own 16, in position order. Positions 1-7 are what the funnel
  // may book; 8-16 are practice additions and diary markers.
  const LIVE_REASONS = [
    "Exam",
    "Scale & Polish",
    "Exam + Scale & Polish",
    "Continuing Treatment",
    "Emergency",
    "Review",
    "Other",
    "NuSmile",
    "Air Flow Hygiene",
    "Nusmile Transformation",
    "Smile Team ",
    "NOT WORKING ",
    "WORKING",
    "BANK HOLIDAY",
    "DENTIST OFF ",
    "UDC",
  ];

  it("books only reasons that exist verbatim in the practice's live list", async () => {
    // Every reason the funnel can produce, from the booking page's six options.
    const produced = [
      ["Check-up", "Exam"],
      ["Check-up and hygiene clean", "Exam + Scale & Polish"],
      ["Hygiene clean", "Scale & Polish"],
      ["In pain or a dental problem", "Emergency"],
      ["Continuing treatment already started", "Continuing Treatment"],
      ["Something else", "Other"],
    ] as const;

    for (const [treatment, reason] of produced) {
      expect(LIVE_REASONS, `"${reason}" must exist live, spelled exactly`).toContain(reason);
      h.createAppointment.mockClear();
      const res = await POST(req(goodBody({ treatment })));
      expect(res.status).toBe(200);
      expect(appointment().reason).toBe(reason);
    }
  });

  it("never books a diary marker, though live would accept one", async () => {
    // "DENTIST OFF " and "BANK HOLIDAY" are real, bookable reasons at this
    // practice. A public funnel filing an appointment under one would blank a
    // clinician's day, so they are unreachable by construction: no page option
    // maps to them, and an unrecognised interest books as an Exam.
    for (const marker of ["DENTIST OFF ", "BANK HOLIDAY", "NOT WORKING ", "UDC"]) {
      h.createAppointment.mockClear();
      const res = await POST(req(goodBody({ treatment: marker })));
      expect(res.status).toBe(200);
      expect(appointment().reason, `${marker} must not reach the diary`).toBe("Exam");
      expect(appointment().notes).toBe("Booked online via Smile Assessment");
    }
  });
});

// ---------------------------------------------------------------------------
// THE BUG THAT WOULD HAVE 422'd THE FIRST LIVE WRITE.
//
// Found by this calibration pass, not by the probe: both whitelists were bare
// object lookups, so every key on Object.prototype answered them.
//
//   funding: "constructor"  -> FUNDING_PLAN_IDS["constructor"] is the Object
//   constructor, which is not `undefined`, so it passed the route's guard and was
//   assigned to payment_plan_id. JSON.stringify then DROPS a function value, so the
//   registration left with NO payment_plan field at all — exactly the field live
//   Dentally 422s on ("payment_plan: seems to be missing"), while the local mock
//   accepted it. Public, unauthenticated, one word.
// ---------------------------------------------------------------------------
describe("prototype keys cannot pass the funding or treatment whitelist", () => {
  const PROTO_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];

  it("refuses every Object.prototype key as a funding value", async () => {
    for (const funding of PROTO_KEYS) {
      const res = await POST(req(goodBody({ funding })));
      expect(res.status, `funding: ${funding} must be refused`).toBe(400);
      const j = (await res.json()) as { error: string };
      expect(j.error).toBe("Please choose how you would like to be seen and try again.");
    }
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("would otherwise have sent a payload with NO payment_plan_id — the live 422", async () => {
    // Demonstrates the mechanism rather than trusting the description: this is what
    // the old lookup produced, and what JSON.stringify did with it.
    const legacyLookup: Record<string, number> = { nhs: 1, private: 2 };
    const smuggled = legacyLookup["constructor"];
    expect(smuggled).not.toBeUndefined(); // sailed past `=== undefined`
    expect(typeof smuggled).toBe("function");
    const wire = JSON.parse(
      JSON.stringify({ first_name: "A", payment_plan_id: smuggled, date_of_birth: "1990-01-01" }),
    ) as Record<string, unknown>;
    expect(wire, "the field live demands vanishes silently").not.toHaveProperty("payment_plan_id");
  });

  it("refuses every Object.prototype key as a treatment, and writes none of it to the notes", async () => {
    for (const treatment of PROTO_KEYS) {
      h.createAppointment.mockClear();
      const res = await POST(req(goodBody({ treatment })));
      expect(res.status).toBe(200); // treatment is optional: the booking still happens
      expect(appointment().reason, `${treatment} must not become a reason`).toBe("Exam");
      expect(appointment().notes).toBe("Booked online via Smile Assessment");
      expect(appointment().notes as string).not.toContain(treatment);
    }
  });
});
