import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintSubmitToken } from "@/lib/smile-assessment/embed-token";
import { dentallySiteId, getSites } from "@/lib/mock/clients";
import {
  FLOW_SCHEMA_VERSION,
  type FlowGraph,
  type FlowBlock,
} from "@/lib/smile-assessment/flow";
import { validateFlow } from "@/lib/smile-assessment/flow-validate";
import { walkFlow } from "@/lib/smile-assessment/flow-runtime";
import { bookingBlockView } from "@/lib/smile-assessment/flow-block-view";
import { bookingEmbed } from "@/lib/smile-assessment/booking-embed";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT, questionById } from "@/lib/smile-assessment/quiz";
import { DentallyClient } from "@/lib/dentally/client";

// ===========================================================================
// IN-FUNNEL BOOKING, END TO END, AGAINST THE STRENGTHENED LOCAL MOCK.
//
// THE RULE (docs/superpowers/plans/2026-08-17-go-live-activation.md): no write of
// any kind reaches live Dentally, here or anywhere. Every write below is served by
// the mock route handlers in src/app/api/mock-dentally, called IN PROCESS through a
// fetch shim. No network request leaves this machine — the shim throws on any host
// it does not recognise, which is what makes that a property of the test rather
// than a promise in a comment.
//
// WHAT THIS COVERS THAT THE UNIT TESTS DO NOT. create-route.test.ts stubs the
// Dentally client, so it proves the route ASSEMBLES the right object. It cannot
// prove that object survives the wire: the payment_plan bug this calibration found
// only becomes a 422 at JSON.stringify, one layer below where that test looks. So
// this file drives the REAL DentallyClient, with real serialisation, into the mock
// patient-create gate that is now calibrated to live's own 422 rules. If the route
// can produce a payload live would refuse, this is the test that says so.
//
// THE WALK, as a patient actually performs it:
//   1. an owner authors a flow with a booking block   (real model + real validator)
//   2. the patient answers the quiz to an outcome     (real deterministic runtime)
//   3. the result screen decides it may offer booking (the real four-input gate)
//   4. POST /api/booking/hold   -> holds the slot, writes NOTHING to Dentally
//   5. POST /api/booking/create -> registers the patient + writes the appointment
//   6. the hold is flipped to 'confirmed'
// and then the same funnel in PREVIEW mode, which must reach none of it.
// ===========================================================================

const CLIENT_SLUG = "vitality";
const SITE_ID = "site-cc";
const SITE_UUID = dentallySiteId(SITE_ID);
const KEY = "s3cret";

/* ---------------------------------------------------------------------------
 * The fetch shim: every Dentally call is served by this repo's own mock handlers.
 * ------------------------------------------------------------------------- */

const MOCK_BASE = "http://localhost:3002/api/mock-dentally";
/** Every request the shim served, so the test can assert what actually happened. */
const wire: Array<{ method: string; path: string; body: unknown; status: number }> = [];

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();

  // THE GUARD THAT MAKES "mock-only" TRUE. Anything not aimed at the local mock is
  // a bug in the test setup, and it fails loudly instead of reaching the internet.
  if (url.origin !== "http://localhost:3002" || !url.pathname.startsWith("/api/mock-dentally")) {
    throw new Error(`REFUSED: this test may only talk to the local mock, not ${url.origin}${url.pathname}`);
  }

  const path = url.pathname.replace("/api/mock-dentally", "");
  const request = new Request(url.href, {
    method,
    headers: init?.headers as HeadersInit,
    body: init?.body as BodyInit | null,
  });

  let res: Response;
  if (path === "/v1/patients" && method === "GET") {
    res = await (await import("@/app/api/mock-dentally/v1/patients/route")).GET(request);
  } else if (path === "/v1/patients" && method === "POST") {
    res = await (await import("@/app/api/mock-dentally/v1/patients/route")).POST(request);
  } else if (path === "/v1/practitioners" && method === "GET") {
    res = await (await import("@/app/api/mock-dentally/v1/practitioners/route")).GET(request);
  } else if (path === "/v1/appointments/availability" && method === "GET") {
    res = await (await import("@/app/api/mock-dentally/v1/appointments/availability/route")).GET(request);
  } else if (path === "/v1/appointments" && method === "POST") {
    res = await (await import("@/app/api/mock-dentally/v1/appointments/route")).POST(request);
  } else {
    throw new Error(`the mock has no handler for ${method} ${path}`);
  }

  let parsedBody: unknown = null;
  if (typeof init?.body === "string") {
    try {
      parsedBody = JSON.parse(init.body);
    } catch {
      parsedBody = init.body;
    }
  }
  wire.push({ method, path, body: parsedBody, status: res.status });
  // The handler's body is consumed by the caller, so hand back a fresh copy.
  return new Response(await res.clone().text(), { status: res.status, headers: res.headers });
}

/** A REAL DentallyClient, writable, pointed at the local mock and nothing else. */
function mockBackedClient(): DentallyClient {
  return new DentallyClient({
    apiKey: "local-mock-only",
    baseUrl: MOCK_BASE,
    readOnly: false,
    fetchImpl: mockFetch as typeof fetch,
  });
}

/* ---------------------------------------------------------------------------
 * Seams. Only two: the owner kill switch and the hold table (Supabase).
 * Everything else in the path is the real thing.
 * ------------------------------------------------------------------------- */

const holds = new Map<string, { siteId: string; status: string }>();

const h = vi.hoisted(() => ({
  isSystemEnabled: vi.fn(async (..._a: unknown[]) => true),
  isSystemEnabledStrict: vi.fn(async (..._a: unknown[]) => true),
}));

// TWO DISTINCT STUBS, on purpose. The create route must read the switch through
// isSystemEnabledStrict (fail CLOSED) because it is the only public endpoint that
// writes a real patient record; hold may use the fail-open reader because it writes
// only to our own table. Separate stubs are what let a test tell those apart —
// aliasing them to one function would make the distinction untestable.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledStrict: h.isSystemEnabledStrict,
}));

vi.mock("@/lib/dentally/write", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual, // the REAL buildManualBookingPayload + BOOKING_REASONS
    isDentallyWriteEnabled: () => true,
    // The gated client, resolved to the mock. DENTALLY_WRITE_BASE_URL is never set
    // to anything live in this file; the shim above enforces that independently.
    dentallyAgentClient: () => mockBackedClient(),
  };
});

vi.mock("@/lib/booking/holds", () => ({
  createHold: vi.fn(async (input: { siteId: string }) => {
    const id = `hold-${holds.size + 1}`;
    holds.set(id, { siteId: input.siteId, status: "held" });
    return { id, slotStart: "", slotFinish: "" };
  }),
  markHoldConfirmed: vi.fn(async (id: string, siteId: string) => {
    const row = holds.get(id);
    if (!row || row.siteId !== siteId) throw new Error("no such hold on that site");
    row.status = "confirmed";
  }),
}));

import { POST as HOLD } from "./hold/route";
import { POST as CREATE } from "./create/route";

/* ---------------------------------------------------------------------------
 * 1. The owner authors a funnel with a booking block on its result screens.
 * ------------------------------------------------------------------------- */

const BOOKING_BLOCK: FlowBlock = {
  kind: "booking",
  headline: "Book your appointment now",
  blurb: "Pick a time that suits you and we will hold it for you.",
};

function authoredFlow(): FlowGraph {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: "welcome",
    nodes: [
      { id: "welcome", kind: "welcome" },
      { id: "q-t", kind: "question", questionId: Q_TREATMENT },
      { id: "q-tl", kind: "question", questionId: Q_TIMELINE },
      { id: "q-b", kind: "question", questionId: Q_BUDGET },
      { id: "q-l", kind: "question", questionId: Q_LOCATION },
      { id: "contact", kind: "contact" },
      { id: "out-high", kind: "outcome", band: "high", blocks: [{ ...BOOKING_BLOCK }] },
      { id: "out-medium", kind: "outcome", band: "medium", blocks: [{ ...BOOKING_BLOCK }] },
      { id: "out-low", kind: "outcome", band: "low", blocks: [{ ...BOOKING_BLOCK }] },
    ],
    edges: [
      { from: "welcome", to: "q-t", answer: null },
      { from: "q-t", to: "q-tl", answer: null },
      { from: "q-tl", to: "q-b", answer: null },
      { from: "q-b", to: "q-l", answer: null },
      { from: "q-l", to: "contact", answer: null },
      { from: "contact", to: "out-high", answer: "high" },
      { from: "contact", to: "out-medium", answer: "medium" },
      { from: "contact", to: "out-low", answer: "low" },
    ],
  };
}

function everyAnswer(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of [Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION]) {
    out[id] = questionById(id)!.options[0]!.value;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Request helpers.
 * ------------------------------------------------------------------------- */

let ip = 0;
let phoneN = 0;
function post(handler: (r: Request) => Promise<Response>, body: unknown): Promise<Response> {
  ip += 1;
  return handler(
    new Request("http://localhost/api/booking", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip % 250}` },
      body: JSON.stringify(body),
    }),
  );
}

function patient(overrides: Record<string, unknown> = {}) {
  phoneN += 1;
  return {
    clientSlug: CLIENT_SLUG,
    siteId: SITE_ID,
    firstName: "Nadia",
    lastName: "Okonkwo",
    phone: `07700 92${String(phoneN).padStart(4, "0")}`,
    email: "nadia@example.com",
    pageToken: mintSubmitToken(CLIENT_SLUG, new Date(), KEY),
    ...overrides,
  };
}

/** The soonest slot the MOCK is really offering, read the way the page reads it. */
async function firstRealSlot(): Promise<{ start: string; finish: string; practitionerId: string | null }> {
  const { fetchAvailabilityDays, earliestSlots } = await import("@/lib/booking/slots");
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 21 * 86_400_000).toISOString().slice(0, 10);
  const days = await fetchAvailabilityDays(mockBackedClient(), SITE_ID, from, to, now);
  const [slot] = earliestSlots(days, 1);
  if (!slot) throw new Error("the mock offered no availability at all");
  return slot;
}

beforeEach(() => {
  vi.clearAllMocks();
  holds.clear();
  wire.length = 0;
  h.isSystemEnabled.mockImplementation(async () => true);
  h.isSystemEnabledStrict.mockImplementation(async () => true);
  vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", KEY);
});
afterEach(() => vi.unstubAllEnvs());

/* =========================================================================== */

describe("1. the authored funnel", () => {
  it("passes the REAL validator with a booking block on every outcome", () => {
    const result = validateFlow(authoredFlow());
    expect(result.ok, JSON.stringify(result.failures ?? [])).toBe(true);
  });

  it("walks the quiz to an outcome that carries the booking invitation", () => {
    // Every question answered, so the deterministic runtime lands on the contact
    // step — the last thing before the outcome screen that carries the booking block.
    const walk = walkFlow(authoredFlow(), everyAnswer());
    expect(walk.status, walk.status === "stuck" ? walk.reason : "").toBe("contact");
    expect(walk.asked).toEqual([Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION]);

    const graph = authoredFlow();
    const outcome = graph.nodes.find((n) => n.id === "out-high")!;
    expect(bookingBlockView(outcome)).toEqual({
      kind: "booking",
      headline: BOOKING_BLOCK.headline,
      blurb: BOOKING_BLOCK.blurb,
    });
  });
});

describe("2. the result screen's gate", () => {
  const site = getSites("vitality").find((s) => s.id === SITE_ID)!;

  it("is READY for a real patient when the switch, block and site all line up", () => {
    expect(
      bookingEmbed({
        bookingUrl: `/book/${CLIENT_SLUG}?site=${SITE_ID}`,
        block: BOOKING_BLOCK,
        site: { id: site.id, name: site.name },
        previewMode: false,
      }),
    ).toEqual({
      status: "ready",
      siteId: SITE_ID,
      siteName: site.name,
      headline: BOOKING_BLOCK.headline,
      blurb: BOOKING_BLOCK.blurb,
    });
  });
});

describe("3. hold -> create -> confirmed, against the strengthened mock", () => {
  it("books a first-time patient end to end and writes a real appointment to the mock", async () => {
    const slot = await firstRealSlot();
    wire.length = 0;

    // --- step 1: HOLD. No Dentally traffic at all. ---
    const body = patient();
    const holdRes = await post(HOLD, {
      ...body,
      slotStart: slot.start,
      finish: slot.finish,
      practitionerId: slot.practitionerId,
      treatment: "Check-up and hygiene clean",
    });
    expect(holdRes.status).toBe(200);
    const held = (await holdRes.json()) as { ok: boolean; holdId: string };
    expect(held.ok).toBe(true);
    expect(holds.get(held.holdId)!.status).toBe("held");
    expect(wire, "holding a slot must not touch Dentally").toHaveLength(0);

    // --- step 2: CREATE. Registers the patient, then writes the appointment. ---
    const createRes = await post(CREATE, {
      ...body,
      slotStart: slot.start,
      finish: slot.finish,
      practitionerId: slot.practitionerId,
      treatment: "Check-up and hygiene clean",
      title: "Ms",
      dateOfBirth: "1991-07-02",
      funding: "NHS",
      holdId: held.holdId,
    });

    // Clone for the failure message: reading the body twice would mask a real
    // failure behind "Body is unusable".
    expect(createRes.status, await createRes.clone().text()).toBe(200);
    const booked = (await createRes.json()) as {
      ok: boolean;
      patientCreated: boolean;
      booked: { start: string; finish: string; practitionerId: string | null };
    };
    expect(booked.ok).toBe(true);
    expect(booked.patientCreated, "a brand new enquiry must be registrable").toBe(true);
    expect(booked.booked.start).toBe(slot.start);

    // --- step 3: the hold is closed out, so no win-back chases a booked patient ---
    expect(holds.get(held.holdId)!.status).toBe("confirmed");

    // --- what actually crossed the wire ---
    const registration = wire.find((w) => w.method === "POST" && w.path === "/v1/patients");
    expect(registration, "a first-time patient must be registered").toBeDefined();
    expect(
      registration!.status,
      "201 means the payload passed a gate calibrated to LIVE's 422 rules",
    ).toBe(201);

    // The four fields live 422'd on, present and correctly typed AFTER serialisation.
    const sent = (registration!.body as { patient: Record<string, unknown> }).patient;
    expect(sent.date_of_birth).toBe("1991-07-02");
    expect(sent.title).toBe("Ms");
    expect(sent.payment_plan_id).toBe(1);
    expect(sent.gender).toBe(false); // derived from Ms, server side
    expect(typeof sent.gender).toBe("boolean");
    expect(sent.site_id).toBe(SITE_UUID);

    const appointment = wire.find((w) => w.method === "POST" && w.path === "/v1/appointments");
    expect(appointment).toBeDefined();
    expect(appointment!.status).toBe(201);
    const appt = (appointment!.body as { appointment: Record<string, unknown> }).appointment;
    expect(appt.reason).toBe("Exam + Scale & Polish");
    expect(appt.booked_via_api).toBe(true);
    expect(appt.notes).toContain("Booked online via Smile Assessment");
    // Exactly one booking slot long, never the availability window's own end.
    expect(Date.parse(appt.finish_time as string) - Date.parse(appt.start_time as string)).toBe(
      30 * 60_000,
    );
  });

  it("reuses an existing patient rather than registering a duplicate", async () => {
    const slot = await firstRealSlot();
    // A patient already in the mock's book, matched on mobile.
    const { MOCK_PATIENTS } = await import("@/app/api/mock-dentally/_fixtures");
    const existing = MOCK_PATIENTS.find((p) => p.site_id === SITE_ID && p.mobile_phone)!;
    wire.length = 0;

    const res = await post(CREATE, {
      ...patient({ phone: existing.mobile_phone, firstName: existing.first_name, lastName: existing.last_name }),
      slotStart: slot.start,
      finish: slot.finish,
      practitionerId: slot.practitionerId,
      title: "Mr",
      dateOfBirth: "1985-01-20",
      funding: "Private",
    });

    expect(res.status).toBe(200);
    const j = (await res.json()) as { patientCreated: boolean };
    expect(j.patientCreated).toBe(false);
    expect(
      wire.find((w) => w.method === "POST" && w.path === "/v1/patients"),
      "an existing patient must never be registered again",
    ).toBeUndefined();
    expect(wire.find((w) => w.method === "POST" && w.path === "/v1/appointments")).toBeDefined();
  });

  it("surfaces a mock 422 as a friendly 502 and writes no appointment", async () => {
    // Proves the strengthened gate is load-bearing in the real path: force the
    // registration to fail the way live would, and watch the route refuse to go on.
    const slot = await firstRealSlot();
    const patients = await import("@/app/api/mock-dentally/v1/patients/route");
    const real = patients.POST;
    const spy = vi.spyOn(patients, "POST").mockImplementation(async () =>
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            message: "payment_plan: seems to be missing",
            errors: { payment_plan: ["seems to be missing"] },
          },
        },
        { status: 422 },
      ),
    );
    wire.length = 0;
    try {
      const res = await post(CREATE, {
        ...patient(),
        slotStart: slot.start,
        finish: slot.finish,
        practitionerId: slot.practitionerId,
        title: "Mr",
        dateOfBirth: "1990-01-01",
        funding: "NHS",
      });
      expect(res.status).toBe(502);
      const j = (await res.json()) as { error: string };
      // Friendly copy only: no Dentally body, no status code, nothing internal.
      expect(j.error).toBe(
        "We could not complete the booking. Please call the practice and we will find you a time.",
      );
      expect(j.error).not.toContain("422");
      expect(j.error).not.toContain("payment_plan");
      expect(
        wire.find((w) => w.method === "POST" && w.path === "/v1/appointments"),
        "a failed registration must not leave an orphan appointment",
      ).toBeUndefined();
    } finally {
      spy.mockRestore();
      expect(patients.POST).toBe(real);
    }
  });
});

describe("4. preview mode stays inert", () => {
  it("draws the offer but gives the caller nothing it could mount a calendar from", () => {
    const site = getSites("vitality").find((s) => s.id === SITE_ID)!;
    const embed = bookingEmbed({
      bookingUrl: `/book/${CLIENT_SLUG}?site=${SITE_ID}`,
      block: BOOKING_BLOCK,
      site: { id: site.id, name: site.name },
      previewMode: true,
    });

    expect(embed.status).toBe("preview");
    // The words are there (a preview that hides half the screen is not a preview)
    // and the SITE is not, which is what makes it unmountable rather than merely
    // discouraged: <BookingCalendar> cannot be built without one.
    expect(embed).not.toHaveProperty("siteId");
    expect(embed).toEqual({
      status: "preview",
      headline: BOOKING_BLOCK.headline,
      blurb: BOOKING_BLOCK.blurb,
    });
  });

  it("makes no Dentally request of any kind while previewing", async () => {
    wire.length = 0;
    const site = getSites("vitality").find((s) => s.id === SITE_ID)!;
    bookingEmbed({
      bookingUrl: `/book/${CLIENT_SLUG}?site=${SITE_ID}`,
      block: BOOKING_BLOCK,
      site: { id: site.id, name: site.name },
      previewMode: true,
    });
    expect(wire).toHaveLength(0);
  });

  it("is OFF, not preview, when the owner's online-booking switch is off", () => {
    // submit/route.ts omits bookingUrl entirely when the switch is off, and an
    // absent URL IS the switch. A preview must show what a patient would see.
    const site = getSites("vitality").find((s) => s.id === SITE_ID)!;
    for (const previewMode of [true, false]) {
      expect(
        bookingEmbed({ bookingUrl: null, block: BOOKING_BLOCK, site, previewMode }),
      ).toEqual({ status: "off" });
    }
  });
});

describe("5. the kill switch still stops the whole funnel", () => {
  it("refuses hold AND create with a friendly 503 when online booking is off", async () => {
    const off = async (..._a: unknown[]) => _a[1] !== "online-booking";
    h.isSystemEnabled.mockImplementation(off);
    h.isSystemEnabledStrict.mockImplementation(off);
    const slot = { start: new Date(Date.now() + 3 * 86_400_000).toISOString(), finish: "", practitionerId: "1" };
    wire.length = 0;

    const holdRes = await post(HOLD, {
      ...patient(),
      slotStart: slot.start,
      finish: new Date(Date.parse(slot.start) + 30 * 60_000).toISOString(),
    });
    expect(holdRes.status).toBe(503);

    const createRes = await post(CREATE, {
      ...patient(),
      slotStart: slot.start,
      finish: new Date(Date.parse(slot.start) + 30 * 60_000).toISOString(),
      title: "Mr",
      dateOfBirth: "1990-01-01",
      funding: "NHS",
    });
    expect(createRes.status).toBe(503);
    expect(wire, "nothing may reach Dentally while the switch is off").toHaveLength(0);
  });

  it("reads the switch through the FAIL-CLOSED helper, not the fail-open one", async () => {
    // The direction that matters for the first live write. This route used to read
    // the switch with fail-OPEN isSystemEnabled, so a transient Supabase error while
    // the owner had booking switched OFF would have let a stranger's appointment
    // into a real diary. isSystemEnabledStrict returns false when it cannot read the
    // row (its own catch does that; here the stub simply reports the same answer),
    // and this asserts the create route is the caller that asks it.
    h.isSystemEnabledStrict.mockResolvedValue(false);
    h.isSystemEnabled.mockResolvedValue(true); // the fail-open reader still says yes
    wire.length = 0;

    const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const res = await post(CREATE, {
      ...patient(),
      slotStart: start,
      finish: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
      title: "Mr",
      dateOfBirth: "1990-01-01",
      funding: "NHS",
    });

    expect(res.status).toBe(503);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe(
      "Online booking is unavailable right now. Please call the practice and we will find you a time.",
    );
    expect(wire, "an unreadable switch must stop the write, not wave it through").toHaveLength(0);
    // The proof it is the strict reader that decided: the fail-open one said yes.
    expect(h.isSystemEnabledStrict).toHaveBeenCalledWith(expect.anything(), "online-booking");
  });
});
