// PUBLIC POST /api/booking/create: unauthenticated and it WRITES a real Dentally
// appointment, so the fail-closed guard chain is what these tests defend:
//   - owner kill switch off -> friendly 503, nothing touches Dentally,
//   - Dentally write gate off -> same friendly 503,
//   - bad/stale page token -> 403,
//   - a slot not in LIVE availability -> 409 (revalidation before every write),
//   - happy path reuses an exact-mobile-match patient (no duplicate creation),
//   - happy path registers a new patient with the site's Dentally UUID,
//   - a mobile match on ANOTHER practice's site is never reused (shared key),
//   - a Dentally 422 surfaces as a friendly 502, never the Dentally error body.
//
// Every I/O seam is mocked; the REAL route handler and the REAL whitelisted
// payload builder (buildManualBookingPayload) and page-token verifier run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DentallyError } from "@/lib/dentally/client";
import { mintSubmitToken } from "@/lib/smile-assessment/embed-token";

const h = vi.hoisted(() => ({
  isSystemEnabled: vi.fn(async (..._a: unknown[]) => true),
  isDentallyWriteEnabled: vi.fn(() => true),
  getAvailability: vi.fn(async (..._a: unknown[]) => ({ availability: [] as unknown[] })),
  // Availability is per practitioner on live Dentally: the revalidation flow lists
  // the site's practitioners first. One active practitioner (101) matches LIVE_ROW.
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
    ...actual, // keep the REAL buildManualBookingPayload
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

// A fixed slot safely in the future and inside the 60-day booking horizon.
const START = new Date(Date.now() + 3 * 86_400_000);
START.setUTCHours(10, 0, 0, 0);
const START_ISO = START.toISOString();
const FINISH_ISO = new Date(START.getTime() + 30 * 60_000).toISOString();
const LIVE_ROW = { start_time: START_ISO, finish_time: FINISH_ISO, practitioner_id: 101 };

const KEY = "s3cret";

// The REAL Dentally site UUIDs: site-cc is one of the client's own sites, the
// other is a nearby practice the shared write key can also see but that is
// deliberately NOT mapped to any of our sites (see SITES in lib/mock/clients.ts).
const OWN_SITE_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";
const FOREIGN_SITE_UUID = "00000000-1111-2222-3333-444444444444";

let ipCounter = 0;
function req(body: unknown): Request {
  ipCounter += 1;
  return new Request("http://localhost/api/booking/create", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Unique IP per call so the in-process per-IP cap never interferes.
      "x-forwarded-for": `203.0.113.${ipCounter}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Distinct phone per test: the route keeps an in-process per-phone attempt cap
// (module-level Map that persists across tests in this file).
let phoneCounter = 0;
function goodBody(overrides: Record<string, unknown> = {}) {
  phoneCounter += 1;
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
    phone: `07700 9002${String(phoneCounter).padStart(2, "0")}`,
    email: "alex@example.com",
    pageToken: mintSubmitToken("vitality", new Date(), KEY),
    ...overrides,
  };
}

/** The E.164 form of a goodBody() phone, the way the route normalises it. */
function e164Of(body: { phone: unknown }): string {
  return "+44" + String(body.phone).replace(/\s/g, "").slice(1);
}

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

describe("create — fail-closed gates", () => {
  it("returns a friendly 503 when the online-booking kill switch is off (Dentally untouched)", async () => {
    h.isSystemEnabled.mockImplementation(async (..._a: unknown[]) => _a[1] !== "online-booking");
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe(
      "Online booking is unavailable right now. Please call the practice and we will find you a time.",
    );
    expect(h.getAvailability).not.toHaveBeenCalled();
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("returns the same friendly 503 when the Dentally write gate is off", async () => {
    h.isDentallyWriteEnabled.mockImplementation(() => false);
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(503);
    // ASSERT THE SENTENCE, not just the status. The booking calendar renders the
    // server's `error` verbatim (see booking-calendar.tsx: "the server's error
    // strings are written for patients; show them as-is"), so this string IS what
    // a patient reads when writes are switched off for a demo. A status-only
    // assertion would pass just as happily if it said "Internal error".
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe(
      "Online booking is unavailable right now. Please call the practice and we will find you a time.",
    );
    // Refused BEFORE Dentally is touched at all: no read, no write.
    expect(h.getAvailability).not.toHaveBeenCalled();
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("rejects a forged page token with 403 (and a token for another client)", async () => {
    const forged = await POST(req(goodBody({ pageToken: "f".repeat(64) })));
    expect(forged.status).toBe(403);
    const cross = await POST(
      req(goodBody({ pageToken: mintSubmitToken("some-other-practice", new Date(), KEY) })),
    );
    expect(cross.status).toBe(403);
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("404s a site that does not belong to the client (cross-tenant guard)", async () => {
    const res = await POST(req(goodBody({ siteId: "site-of-another-tenant" })));
    expect(res.status).toBe(404);
    expect(h.getAvailability).not.toHaveBeenCalled();
  });
});

describe("create — live slot revalidation", () => {
  it("409s when the requested slot is no longer in live availability", async () => {
    h.getAvailability.mockResolvedValue({
      availability: [
        { ...LIVE_ROW, start_time: new Date(START.getTime() + 60 * 60_000).toISOString() },
      ],
    });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(409);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("That time has just been taken. Please pick another slot.");
    expect(h.createAppointment).not.toHaveBeenCalled();
    expect(h.createPatient).not.toHaveBeenCalled();
  });

  it("409s when the pinned practitioner is not offering that slot any more", async () => {
    const res = await POST(req(goodBody({ practitionerId: "999" })));
    expect(res.status).toBe(409);
    expect(h.createAppointment).not.toHaveBeenCalled();
  });
});

describe("create — happy paths", () => {
  it("books via an EXACT mobile match without creating a duplicate patient", async () => {
    const body = goodBody();
    const e164 = "+44" + String(body.phone).replace(/\s/g, "").slice(1);
    h.findPatientsByPhone.mockResolvedValue({
      patients: [
        { id: 1, mobile_phone: "+447700000000", site_id: OWN_SITE_UUID }, // different handset: not a match
        { id: 42, mobile_phone: e164, site_id: OWN_SITE_UUID, first_name: "Alex", last_name: "Patient" },
      ],
    });
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      booked: { start: string; finish: string; practitionerId: string | null };
      patientCreated: boolean;
    };
    expect(j.ok).toBe(true);
    expect(j.patientCreated).toBe(false);
    // The LIVE slot's own values are booked, incl. the practitioner the client never sent.
    expect(j.booked).toEqual({ start: START_ISO, finish: FINISH_ISO, practitionerId: "101" });
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.findPatientsByPhone).toHaveBeenCalledWith(e164);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({
      patient_id: "42",
      start_time: START_ISO,
      finish_time: FINISH_ISO,
      practitioner_id: "101",
      reason: "Exam",
      notes: "Booked online via Smile Assessment",
      booked_via_api: true,
    });
  });

  it("registers a new patient (with the site's Dentally UUID) when no mobile match exists", async () => {
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { patientCreated: boolean };
    expect(j.patientCreated).toBe(true);
    const created = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.first_name).toBe("Alex");
    expect(created.last_name).toBe("Patient");
    expect(created.email_address).toBe("alex@example.com");
    // site-cc maps to the REAL Dentally site UUID, never the internal id.
    expect(created.site_id).toBe(OWN_SITE_UUID);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.patient_id).toBe("pat-new");
  });
});

// The bug this block defends. Registering a first-time patient against LIVE Dentally
// failed with 422: date_of_birth, title and payment_plan "seems to be missing", and
// gender "must be male or female". So no new patient could book online at all, and it
// went unnoticed because registration had only ever been exercised against the local
// mock. On real Dentally gender is a BOOLEAN (true = male, false = female), and we
// DERIVE it from the title on the server rather than putting a binary sex question in
// front of a patient on a marketing funnel.
describe("create, the fields live Dentally requires to register a patient", () => {
  it("registers with date_of_birth, title, payment_plan_id and a BOOLEAN gender, the four fields Dentally rejected as missing", async () => {
    const body = goodBody();
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(h.createPatient).toHaveBeenCalledTimes(1);
    const created = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
    expect(created).toEqual({
      first_name: "Alex",
      last_name: "Patient",
      title: "Mr",
      date_of_birth: "1990-03-14",
      payment_plan_id: 1,
      gender: true,
      email_address: "alex@example.com",
      mobile_phone: e164Of(body),
      site_id: OWN_SITE_UUID,
      use_sms: true,
      use_email: true,
    });
    // A STRING is what the old code sent, and what live Dentally rejected.
    expect(typeof created.gender).toBe("boolean");
  });

  it("derives the boolean sex from the chosen title (Mr and Master true, Mrs, Miss and Ms false)", async () => {
    for (const [title, expected] of [
      ["Mr", true],
      ["Master", true],
      ["Mrs", false],
      ["Miss", false],
      ["Ms", false],
    ] as const) {
      h.createPatient.mockClear();
      const res = await POST(req(goodBody({ title })));
      expect(res.status).toBe(200);
      const created = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
      expect(created.title).toBe(title);
      expect(created.gender).toBe(expected);
    }
  });

  it("never takes the sex from the client, even when one is posted", async () => {
    const res = await POST(req(goodBody({ title: "Mrs", gender: "Male" })));
    expect(res.status).toBe(200);
    const created = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.gender).toBe(false); // derived from Mrs, not the posted "Male"
  });

  it("maps NHS to payment plan 1 and Private to payment plan 2", async () => {
    const nhs = await POST(req(goodBody({ funding: "NHS" })));
    expect(nhs.status).toBe(200);
    expect((h.createPatient.mock.calls[0]![0] as Record<string, unknown>).payment_plan_id).toBe(1);

    h.createPatient.mockClear();
    const priv = await POST(req(goodBody({ funding: "Private" })));
    expect(priv.status).toBe(200);
    expect((h.createPatient.mock.calls[0]![0] as Record<string, unknown>).payment_plan_id).toBe(2);
  });

  it("REFUSES a title the practice does not use, so nothing arbitrary reaches a patient record", async () => {
    for (const title of ["Dr", "Lord Admiral <script>", "", undefined]) {
      const res = await POST(req(goodBody({ title })));
      expect(res.status).toBe(400);
      const j = (await res.json()) as { ok: boolean; error: string };
      expect(j.ok).toBe(false);
      expect(j.error).toBe("Please choose a title and try again.");
    }
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.createAppointment).not.toHaveBeenCalled();
    expect(h.getAvailability).not.toHaveBeenCalled();
  });

  it("accepts the page's own titles whatever the casing, and stores the practice's spelling", async () => {
    const res = await POST(req(goodBody({ title: "  mISS " })));
    expect(res.status).toBe(200);
    const created = h.createPatient.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.title).toBe("Miss");
    expect(created.gender).toBe(false);
  });

  it("REFUSES a funding value that is not one the booking page offers", async () => {
    for (const funding of ["Insurance", "47752", "", undefined]) {
      const res = await POST(req(goodBody({ funding })));
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: string };
      expect(j.error).toBe("Please choose how you would like to be seen and try again.");
    }
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("REFUSES a date of birth in the future", async () => {
    const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    const res = await POST(req(goodBody({ dateOfBirth: nextYear })));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("Please check your date of birth and try again.");
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("REFUSES a missing, malformed, impossible or implausibly old date of birth", async () => {
    for (const dateOfBirth of [
      undefined,
      "",
      "14/03/1990",
      "1990-02-31", // a day that does not exist
      "1990-13-01", // a month that does not exist
      "1200-01-01", // older than any living patient
      "1990-03-14T00:00:00Z",
    ]) {
      const res = await POST(req(goodBody({ dateOfBirth })));
      expect(res.status).toBe(400);
    }
    expect(h.createPatient).not.toHaveBeenCalled();
    expect(h.createAppointment).not.toHaveBeenCalled();
  });
});

describe("create, a long availability window is booked as ONE 30 minute slot", () => {
  it("writes start + 30 minutes, never the window's own end", async () => {
    // Dentally answers with WINDOWS: this one runs six hours from the requested
    // start. Writing its finish_time verbatim would block a clinician's whole
    // afternoon, so the write must use the chunked slot.
    h.getAvailability.mockResolvedValue({
      availability: [
        {
          start_time: START_ISO,
          finish_time: new Date(START.getTime() + 6 * 60 * 60_000).toISOString(),
          practitioner_id: 101,
        },
      ],
    });
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.start_time).toBe(START_ISO);
    expect(payload.finish_time).toBe(FINISH_ISO);
    expect(Date.parse(payload.finish_time as string) - Date.parse(payload.start_time as string)).toBe(
      30 * 60_000,
    );
  });

  it("offers the later chunks of that window too (a 13:00 pick out of a 10:00 window books 13:00 to 13:30)", async () => {
    const later = new Date(START.getTime() + 3 * 60 * 60_000);
    h.getAvailability.mockResolvedValue({
      availability: [
        {
          start_time: START_ISO,
          finish_time: new Date(START.getTime() + 6 * 60 * 60_000).toISOString(),
          practitioner_id: 101,
        },
      ],
    });
    const res = await POST(
      req(
        goodBody({
          slotStart: later.toISOString(),
          finish: new Date(later.getTime() + 30 * 60_000).toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.start_time).toBe(later.toISOString());
    expect(payload.finish_time).toBe(new Date(later.getTime() + 30 * 60_000).toISOString());
  });
});

describe("create, patient matching is scoped to the client's own sites", () => {
  it("never books against a mobile match belonging to ANOTHER practice on the shared key", async () => {
    const body = goodBody();
    const e164 = "+44" + String(body.phone).replace(/\s/g, "").slice(1);
    h.findPatientsByPhone.mockResolvedValue({
      patients: [
        { id: 99, mobile_phone: e164, site_id: FOREIGN_SITE_UUID, first_name: "Alex", last_name: "Patient" },
        { id: 98, mobile_phone: e164 }, // no site at all: ownership unprovable
      ],
    });
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    // A new record on OUR site is registered instead of filing the appointment
    // against a stranger's chart.
    const j = (await res.json()) as { patientCreated: boolean };
    expect(j.patientCreated).toBe(true);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.patient_id).toBe("pat-new");
  });

  it("prefers the name match when a household shares one mobile", async () => {
    const body = goodBody({ firstName: "Sam", lastName: "Patient" });
    const e164 = "+44" + String(body.phone).replace(/\s/g, "").slice(1);
    h.findPatientsByPhone.mockResolvedValue({
      patients: [
        { id: 10, mobile_phone: e164, site_id: OWN_SITE_UUID, first_name: "Alex", last_name: "Patient" },
        { id: 11, mobile_phone: e164, site_id: OWN_SITE_UUID, first_name: " sam ", last_name: "PATIENT" },
      ],
    });
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(h.createPatient).not.toHaveBeenCalled();
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.patient_id).toBe("11");
  });

  it("falls back to the first own-site match when no name matches", async () => {
    const body = goodBody({ firstName: "Jo", lastName: "Newname" });
    const e164 = "+44" + String(body.phone).replace(/\s/g, "").slice(1);
    h.findPatientsByPhone.mockResolvedValue({
      patients: [
        { id: 20, mobile_phone: e164, site_id: FOREIGN_SITE_UUID, first_name: "Jo", last_name: "Newname" },
        { id: 21, mobile_phone: e164, site_id: OWN_SITE_UUID, first_name: "Alex", last_name: "Patient" },
      ],
    });
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.patient_id).toBe("21");
  });
});

describe("create, the appointment says what the patient booked for", () => {
  it("maps a stated treatment interest to an allowed Dentally reason and keeps it in the notes", async () => {
    const res = await POST(req(goodBody({ treatment: "Check-up and hygiene clean" })));
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.reason).toBe("Exam + Scale & Polish");
    expect(payload.notes).toBe(
      "Booked online via Smile Assessment. Patient interest: Check-up and hygiene clean",
    );
  });

  it("books a pain enquiry as an Emergency", async () => {
    const res = await POST(req(goodBody({ treatment: "In pain or a dental problem" })));
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.reason).toBe("Emergency");
  });

  // This endpoint is PUBLIC and unauthenticated, and its output lands in the notes of
  // a real clinical record. The booking page offers a fixed select of six options, so
  // any other value was not chosen by a patient using the page. Sanitising such a value
  // and writing it through would still let a stranger put arbitrary text into the
  // practice's records, so an unrecognised value is dropped entirely instead.
  it("REFUSES an interest that is not one of the booking page's own options, so no stranger's free text reaches a clinical note", async () => {
    const res = await POST(
      req(goodBody({ treatment: `Straightening\n\nmy teeth ${"x".repeat(200)}` })),
    );
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.reason).toBe("Exam"); // no information about the interest, so the default
    const notes = payload.notes as string;
    expect(notes).not.toContain("Straightening");
    expect(notes).not.toContain("xxx");
    expect(notes).not.toContain("\n");
  });

  it("still books the page's own catch-all option as Other rather than an Exam", async () => {
    const res = await POST(req(goodBody({ treatment: "Something else" })));
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.reason).toBe("Other");
    expect(payload.notes as string).toContain("Something else");
  });

  it("still books an exam when no interest was stated", async () => {
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(200);
    const payload = h.createAppointment.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.reason).toBe("Exam");
    expect(payload.notes).toBe("Booked online via Smile Assessment");
  });
});

describe("create — Dentally failure handling", () => {
  it("maps a Dentally 422 to a friendly 502 and never leaks the Dentally body", async () => {
    h.createAppointment.mockRejectedValue(
      new DentallyError(422, '{"error":"Validation failed: practitioner is not available"}'),
    );
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(502);
    const j = (await res.json()) as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBe(
      "We could not complete the booking. Please call the practice and we will find you a time.",
    );
    expect(j.error).not.toContain("422");
    expect(j.error).not.toContain("Validation");
  });

  it("maps an availability read failure during revalidation to a friendly 502", async () => {
    h.getAvailability.mockRejectedValue(new DentallyError(500, "boom"));
    const res = await POST(req(goodBody()));
    expect(res.status).toBe(502);
    expect(h.createAppointment).not.toHaveBeenCalled();
  });
});

describe("create — input validation and caps", () => {
  it("requires names and a plausible mobile number", async () => {
    expect((await POST(req(goodBody({ firstName: "  " })))).status).toBe(400);
    expect((await POST(req(goodBody({ lastName: undefined })))).status).toBe(400);
    expect((await POST(req(goodBody({ phone: "not-a-phone" })))).status).toBe(400);
    expect((await POST(req(goodBody({ email: "not-an-email" })))).status).toBe(400);
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("caps repeated booking attempts from one phone (4th within the hour is 429)", async () => {
    const phone = "07700 900999";
    for (let i = 0; i < 3; i += 1) {
      const res = await POST(req(goodBody({ phone })));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(req(goodBody({ phone })));
    expect(blocked.status).toBe(429);
  });
});
