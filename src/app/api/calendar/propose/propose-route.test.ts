// ===========================================================================
// The reschedule PROPOSAL route.
//
// The pure matcher is already tested beside itself (src/lib/calendar/propose.ts).
// What is tested here is what the ROUTE decides, and every one of those decisions
// is about not printing a confident empty:
//
//   - a period we could not read produces a 503 that says so, NEVER an empty list
//     under the words "nobody who can do this has free time",
//   - a period we could read only in part is FLAGGED, so a short list is not read
//     as a short diary,
//   - an appointment at another site is a 404 that reveals nothing,
//   - and the suitability filter still holds end to end: a hygienist is never
//     offered for an extraction, however free they are.
// ===========================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  appointments: [] as Record<string, unknown>[],
  appointmentsFailed: false,
  practitioners: {
    practitioners: [
      { id: "prac-4", name: "Priya Raman" },
      { id: "prac-1", name: "Dana Hale" },
      { id: "prac-3", name: "Jin Kim" },
    ],
    failed: false,
  },
  availabilityByCall: [] as Array<{ rows: unknown[]; failed: boolean }>,
  entriesByCall: [] as Array<{ entries: unknown[]; failed: boolean }>,
  caps: null as null | { caps: unknown[]; seeded: boolean },
}));

vi.mock("@/lib/calendar/access", () => ({
  requireDiaryAdmin: async () => ({ auth: null, siteId: "site-cc", clientId: "vitality" }),
}));

vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) =>
    id === "site-cc"
      ? { id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", openingHours: null }
      : undefined,
  // ONE site, so no practitioner can be shared with another practice and the
  // cross-site presence guard is a no-op here. Its own behaviour is tested in
  // src/lib/calendar/site-presence.test.ts.
  getSites: () => [{ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", openingHours: null }],
}));

vi.mock("@/lib/dentally/read", () => ({
  listAppointmentsSafe: async () => ({
    appointments: h.appointments,
    failed: h.appointmentsFailed,
    failedSiteIds: h.appointmentsFailed ? ["site-cc"] : [],
  }),
  listSitePractitionersSafe: async () => h.practitioners,
  listDiaryAvailabilitySafe: async () => h.availabilityByCall.shift() ?? { rows: [], failed: true },
}));

vi.mock("@/lib/calendar/repository", () => ({
  listEntries: async () => h.entriesByCall.shift() ?? { entries: [], failed: true },
  selectTreatmentCapability: async () => [],
}));

// A full factory rather than importOriginal: suitability-source carries
// `import "server-only"`, which does not resolve under vitest.
vi.mock("@/lib/calendar/suitability-source", () => ({
  loadCapabilities: async () => h.caps,
  SEEDED_CAPABILITIES_NOTICE:
    "Using seeded example capabilities. Ask the practice to confirm who can do what.",
}));

import { SUITABILITY_SEED } from "@/lib/calendar/suitability-seed";
import { POST } from "./route";

const DAY = "2026-07-31";
const AT = (dayIso: string, hh: number, mm = 0): string =>
  new Date(`${dayIso}T${String(hh - 1).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`).toISOString();

function appointment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "appt-1",
    patientId: "pat-9",
    patientName: "Nadia Lamprell",
    siteId: "site-cc",
    start: AT(DAY, 9, 30),
    finish: AT(DAY, 10, 0),
    durationMin: 30,
    state: "confirmed",
    reason: "Extraction",
    note: null,
    practitioner: "Dana Hale",
    practitionerId: "prac-1",
    ...over,
  };
}

/** One readable chunk: both clinicians working all day, no breaks. */
function readableChunk(dayKeys: string[]): { rows: unknown[]; failed: boolean } {
  const rows: unknown[] = [];
  for (const d of dayKeys) {
    for (const id of ["prac-1", "prac-3", "prac-4"]) {
      rows.push({ practitioner_id: id, start_time: AT(d, 9, 0), finish_time: AT(d, 17, 0) });
    }
  }
  return { rows, failed: false };
}

function chunkDays(from: string, count: number): string[] {
  const out: string[] = [];
  let ms = Date.parse(`${from}T00:00:00Z`) + 86_400_000;
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(ms).toISOString().slice(0, 10));
    ms += 86_400_000;
  }
  return out;
}

async function call(body: Record<string, unknown> = {}) {
  const res = await POST(
    new Request("http://localhost/api/calendar/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: "site-cc",
        appointmentId: "appt-1",
        day: DAY,
        windowDays: 14,
        ...body,
      }),
    }),
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

// THE CLOCK IS FROZEN, and this file cannot work without it.
//
// The route searches from the day AFTER max(today, DAY), while the mocked diary
// above is pinned to the fortnight after DAY (2026-08-01 to 2026-08-14). Every day
// that passes slides the searched window one day off the mocked one, and on
// 2026-08-07 they stop overlapping altogether: every availability row is outside
// the window, so the route returns an empty proposal list.
//
// That is the exact failure this file exists to catch — a confident empty — so it
// would have been reported as a suitability regression rather than a stale
// fixture. Freezing to DAY itself keeps `from` on DAY and the two windows aligned.
//
// Only Date is faked. Faking every timer would hang the async route under test.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-31T08:00:00.000+01:00"));
  vi.clearAllMocks();
  h.appointments = [appointment()];
  h.appointmentsFailed = false;
  h.practitioners = {
    practitioners: [
      { id: "prac-4", name: "Priya Raman" },
      { id: "prac-1", name: "Dana Hale" },
      { id: "prac-3", name: "Jin Kim" },
    ],
    failed: false,
  };
  h.availabilityByCall = [];
  h.entriesByCall = [];
  h.caps = { caps: [...SUITABILITY_SEED], seeded: true };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a period that could not be read", () => {
  it("is a 503 that says so, and NEVER an empty list of proposals", async () => {
    // Both chunks fail, which is exactly the local state until migration 0063 is
    // applied. An empty list here would print "0 clinicians can do Extraction",
    // which is a confident empty built entirely out of a failed read.
    h.availabilityByCall = [
      { rows: [], failed: true },
      { rows: [], failed: true },
    ];
    h.entriesByCall = [
      { entries: [], failed: true },
      { entries: [], failed: true },
    ];
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(json.ok).toBe(false);
    expect(String(json.error)).toContain("could not be read for that period");
    expect(json).not.toHaveProperty("proposals");
  });

  it("is a 503 when only the BREAKS could not be read, because a slot over lunch is the error this prevents", async () => {
    const days = chunkDays(DAY, 14);
    h.availabilityByCall = [readableChunk(days.slice(0, 7)), readableChunk(days.slice(7))];
    h.entriesByCall = [
      { entries: [], failed: true },
      { entries: [], failed: true },
    ];
    const { res } = await call();
    expect(res.status).toBe(503);
  });
});

describe("a period that could be read only in part", () => {
  it("is flagged, so a short list is never read as a short diary", async () => {
    const days = chunkDays(DAY, 14);
    h.availabilityByCall = [readableChunk(days.slice(0, 7)), { rows: [], failed: true }];
    h.entriesByCall = [
      { entries: [], failed: false },
      { entries: [], failed: true },
    ];
    const { res, json } = await call();
    expect(res.status).toBe(200);
    expect(json.partial).toBe(true);
    expect(json.daysNotRead).toBe(7);
  });

  it("is NOT flagged when the whole period read cleanly", async () => {
    const days = chunkDays(DAY, 14);
    h.availabilityByCall = [readableChunk(days.slice(0, 7)), readableChunk(days.slice(7))];
    h.entriesByCall = [
      { entries: [], failed: false },
      { entries: [], failed: false },
    ];
    const { json } = await call();
    expect(json.partial).toBe(false);
    expect(json.daysNotRead).toBe(0);
  });
});

describe("suitability, end to end through the route", () => {
  function readableFortnight() {
    const days = chunkDays(DAY, 14);
    h.availabilityByCall = [readableChunk(days.slice(0, 7)), readableChunk(days.slice(7))];
    h.entriesByCall = [
      { entries: [], failed: false },
      { entries: [], failed: false },
    ];
  }

  it("NEVER offers a hygienist for an extraction, however free they are", async () => {
    readableFortnight();
    const { json } = await call();
    expect(json.familySlug).toBe("surgical");
    const proposals = json.proposals as Array<{ practitionerId: string; level: string }>;
    expect(proposals.length).toBeGreaterThan(0);
    // prac-4 is the seeded hygienist: hygiene only, 'cannot' on everything else,
    // and free all fortnight. prac-1 is a general dentist the seed marks 'cannot'
    // on surgical. Neither is offered, however much free time they have.
    expect(proposals.some((p) => p.practitionerId === "prac-4")).toBe(false);
    expect(proposals.some((p) => p.practitionerId === "prac-1")).toBe(false);
    // prac-3 is 'supervised' on surgical, which is a real level and not a
    // rounding of 'can': they ARE offered, and the level travels with the slot so
    // the panel can say so.
    expect(proposals.every((p) => p.practitionerId === "prac-3")).toBe(true);
    expect(proposals.every((p) => p.level === "supervised")).toBe(true);
  });

  it("DOES offer the hygienist for hygiene, so the exclusion above is not a dead list", async () => {
    h.appointments = [appointment({ reason: "Hygiene", practitionerId: null })];
    h.practitioners = { practitioners: [{ id: "prac-4", name: "Priya Raman" }], failed: false };
    readableFortnight();
    const { json } = await call();
    expect(json.familySlug).toBe("hygiene");
    const proposals = json.proposals as Array<{ practitionerId: string; level: string }>;
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((p) => p.practitionerId === "prac-4")).toBe(true);
    expect(proposals.every((p) => p.level === "can")).toBe(true);
  });

  it("excludes a clinician we have NO record for, rather than guessing they can", async () => {
    // prac-3 carries no hygiene row at all in the seed, which resolves to
    // "unknown". Unknown is not suitable, and it is counted so the reader can see
    // that the gap is in the practice's own data rather than in the diary.
    h.appointments = [appointment({ reason: "Hygiene", practitionerId: null })];
    h.practitioners = { practitioners: [{ id: "prac-3", name: "Jin Kim" }], failed: false };
    readableFortnight();
    const { json } = await call();
    expect(json.proposals).toEqual([]);
    expect(json.breakdown).toMatchObject({ capable: 0, cannot: 0, unknown: 1 });
  });

  it("puts the clinician the patient already had first, for continuity of care", async () => {
    h.appointments = [appointment({ reason: "Hygiene", practitionerId: "prac-1" })];
    h.practitioners = {
      practitioners: [
        { id: "prac-4", name: "Priya Raman" },
        { id: "prac-1", name: "Dana Hale" },
      ],
      failed: false,
    };
    readableFortnight();
    const { json } = await call();
    const proposals = json.proposals as Array<{ practitionerId: string }>;
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0].practitionerId).toBe("prac-1");
    // Both can do hygiene, so the breakdown still reports two capable clinicians
    // even though the capped list happens to be all one of them.
    expect(json.breakdown).toMatchObject({ capable: 2, capableWithNoFreeTime: 0 });
  });

  it("proposes NOTHING, and says why, when nobody is both available and suited", async () => {
    // Only the hygienist and the general dentist are working, and the seed says
    // neither does surgical. An empty list plus a breakdown is the honest answer;
    // widening the criteria to fill the list is the failure this prevents.
    h.practitioners = {
      practitioners: [
        { id: "prac-4", name: "Priya Raman" },
        { id: "prac-1", name: "Dana Hale" },
      ],
      failed: false,
    };
    readableFortnight();
    const { json } = await call();
    expect(json.proposals).toEqual([]);
    expect(json.breakdown).toMatchObject({ capable: 0, cannot: 2 });
  });

  it("says the seed is in force, so an example capability is never taken for the practice's answer", async () => {
    const days = chunkDays(DAY, 14);
    h.availabilityByCall = [readableChunk(days.slice(0, 7)), readableChunk(days.slice(7))];
    h.entriesByCall = [
      { entries: [], failed: false },
      { entries: [], failed: false },
    ];
    const { json } = await call();
    expect(json.seeded).toBe(true);
    expect(json.seededNotice).toBe(
      "Using seeded example capabilities. Ask the practice to confirm who can do what.",
    );
  });

  it("ALWAYS carries the reason breakdown, even when the list is not empty", async () => {
    const days = chunkDays(DAY, 14);
    h.availabilityByCall = [readableChunk(days.slice(0, 7)), readableChunk(days.slice(7))];
    h.entriesByCall = [
      { entries: [], failed: false },
      { entries: [], failed: false },
    ];
    const { json } = await call();
    expect(json.breakdown).toMatchObject({
      capable: expect.any(Number),
      capableWithNoFreeTime: expect.any(Number),
      cannot: expect.any(Number),
      unknown: expect.any(Number),
    });
  });
});

describe("scoping", () => {
  it("404s an appointment that belongs to another site", async () => {
    h.appointments = [appointment({ siteId: "site-rv" })];
    const { res, json } = await call();
    expect(res.status).toBe(404);
    expect(json.error).toBe("not found");
  });

  it("503s rather than proposing when the appointment itself could not be read", async () => {
    h.appointmentsFailed = true;
    const { res } = await call();
    expect(res.status).toBe(503);
  });

  it("503s rather than proposing when the clinician list could not be read", async () => {
    h.practitioners = { practitioners: [], failed: true };
    const { res } = await call();
    expect(res.status).toBe(503);
  });

  it("400s on a day that is not a date", async () => {
    const { res } = await call({ day: "tomorrow" });
    expect(res.status).toBe(400);
  });
});
