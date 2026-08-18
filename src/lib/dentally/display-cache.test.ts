import { describe, it, expect, vi } from "vitest";
import {
  createDisplayCache,
  inMemoryDisplayCacheStore,
  jsonRoundTrip,
  type DisplayCacheStore,
} from "./display-cache";
import type {
  AppointmentRecord,
  AppointmentsRead,
  OutstandingRead,
  PatientDetail,
  PatientRecord,
  PractitionersRead,
} from "./read";

// A controllable clock so TTL expiry is deterministic, not wall-clock dependent.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const TTL = 60_000;

describe("display-cache: tenancy (a read for one client can never return another's blob)", () => {
  it("keeps two clients' identical cache_key on two separate rows, both layers", async () => {
    const store = inMemoryDisplayCacheStore();
    const cache = createDisplayCache({ store });

    await cache.setCached("clientA", "outstanding:site-x", { total: 111 }, TTL);
    await cache.setCached("clientB", "outstanding:site-x", { total: 222 }, TTL);

    // Same key, different tenant -> two distinct L2 rows, never one overwriting the other.
    expect(store.rows.size).toBe(2);
    expect(await cache.getCached("clientA", "outstanding:site-x")).toEqual({ total: 111 });
    expect(await cache.getCached("clientB", "outstanding:site-x")).toEqual({ total: 222 });

    // MUTATION SENTINEL: if l1KeyOf (or the store row key) dropped clientId, the
    // second setCached would overwrite the first and clientA would read 222 here.
    expect(await cache.getCached("clientA", "outstanding:site-x")).not.toEqual({ total: 222 });
  });

  it("never serves clientB's row to clientA even on a COLD instance (L2 only)", async () => {
    const store = inMemoryDisplayCacheStore();
    await createDisplayCache({ store }).setCached("clientB", "patients:site-x:all", ["b-patient"], TTL);

    // A different instance (fresh L1) that only clientA ever queries.
    const cold = createDisplayCache({ store });
    expect(await cold.getCached("clientA", "patients:site-x:all")).toBeUndefined();
    expect(await cold.getCached("clientB", "patients:site-x:all")).toEqual(["b-patient"]);
  });

  it("the store's get is filtered by BOTH client_id and cache_key", async () => {
    // A store spy that records the exact (clientId, cacheKey) it was asked for, so a
    // mutation that stops passing clientId to the store is visible.
    const seen: Array<{ clientId: string; cacheKey: string }> = [];
    const store: DisplayCacheStore = {
      async get(clientId, cacheKey) {
        seen.push({ clientId, cacheKey });
        return null;
      },
      async set() {},
      async deleteByPrefix() {},
    };
    const cache = createDisplayCache({ store });
    await cache.getCached("clientA", "appts:site-x::");
    expect(seen).toEqual([{ clientId: "clientA", cacheKey: "appts:site-x::" }]);
  });
});

describe("display-cache: type integrity (every cached shape survives the jsonb round-trip)", () => {
  const patient: PatientRecord = {
    id: "p1",
    name: "Alex Berry",
    title: "Mr",
    email: "a@b.co",
    phone: "+447700900000",
    siteId: "site-cc",
    active: true,
    archivedReason: null,
    recallDueAt: "2026-09-01",
    dentistRecallAt: "2026-09-01",
    hygienistRecallAt: null,
    lastVisitAt: "2026-03-01T09:00:00Z",
    dateOfBirth: "1990-01-01",
    gender: "male",
    smsConsent: true,
    emailConsent: false,
    medicalAlert: true,
    medicalAlertText: "Penicillin anaphylaxis",
    paymentPlanId: 42,
  };
  const appointment: AppointmentRecord = {
    id: "a1",
    patientId: "p1",
    patientName: "Alex Berry",
    siteId: "site-cc",
    start: "2026-08-18T09:00:00Z",
    finish: "2026-08-18T09:30:00Z",
    durationMin: 30,
    state: "booked",
    reason: "Exam",
    note: "nervous patient",
    practitioner: "Dr Jones",
    practitionerId: "prac-1",
  };
  const patientDetail: PatientDetail = {
    appointments: [appointment],
    plans: [{ name: "Whitening", planned: 300, outstanding: 150, acceptedAt: "2026-01-01" }],
    notes: [],
    lifetimeSpend: 1245,
    outstanding: 150,
    credit: 0,
    totalInvoiced: 1245,
    invoices: [{ id: "i1", reference: "INV-1", status: "unpaid", date: "2026-01-01", balance: 150, total: 300 }],
    reads: { appointments: "ok", plans: "ok", notes: "ok", invoices: "ok" },
  };
  const outstanding: OutstandingRead = {
    rows: [
      { patientId: "p1", patientName: "Alex Berry", siteId: "site-cc", planName: "Whitening", planned: 300, outstanding: 150, acceptedAt: "2026-01-01" },
    ],
    truncated: false,
  };
  const appointmentsRead: AppointmentsRead = { appointments: [appointment], failed: false, failedSiteIds: [] };
  const practitioners: PractitionersRead = { practitioners: [{ id: "prac-1", name: "Dr Jones" }], failed: false };
  const diaryAvail = { rows: [{ practitioner_id: "prac-1", start_time: "x", finish_time: "y" }], failed: false };

  const shapes: Array<[string, unknown]> = [
    ["PatientRecord[]", [patient]],
    ["AppointmentRecord[]", [appointment]],
    ["PatientDetail", patientDetail],
    ["OutstandingRead", outstanding],
    ["AppointmentsRead", appointmentsRead],
    ["PractitionersRead", practitioners],
    ["diaryavail {rows,failed}", diaryAvail],
    ["patient count (number)", 8123],
  ];

  for (const [name, value] of shapes) {
    it(`${name} is byte-identical value-in === value-out`, () => {
      expect(jsonRoundTrip(value)).toEqual(value);
    });
  }

  it("round-trips through the actual store on a cold read, unchanged", async () => {
    const store = inMemoryDisplayCacheStore(); // models jsonb faithfully
    await createDisplayCache({ store }).setCached("vitality", "patientdetail:site-cc:p1", patientDetail, TTL);
    const back = await createDisplayCache({ store }).getCached<PatientDetail>("vitality", "patientdetail:site-cc:p1");
    expect(back).toEqual(patientDetail);
  });

  it("GUARD: a shape carrying a real Date would NOT survive, so the round-trip test above is load-bearing", () => {
    const withDate = { when: new Date("2026-08-18T00:00:00Z") };
    // Date -> ISO string: the shape does not survive. If a future cached read grows a
    // Date field, its round-trip test fails here-style and forces explicit serialisation.
    expect(jsonRoundTrip(withDate)).not.toEqual(withDate);
    expect(typeof jsonRoundTrip(withDate).when).toBe("string");
  });
});

describe("display-cache: cross-instance call-count (a warm fleet computes each read ONCE per TTL)", () => {
  it("a second read within the TTL from a DIFFERENT instance makes ZERO compute calls", async () => {
    const store = inMemoryDisplayCacheStore();
    const compute = vi.fn(async () => ["expensive-dentally-result"]);

    const instance1 = createDisplayCache({ store });
    const instance2 = createDisplayCache({ store }); // fresh L1, SAME shared L2

    const a = await instance1.cachedRead("vitality", "outstanding:site-cc", compute, TTL);
    const b = await instance2.cachedRead("vitality", "outstanding:site-cc", compute, TTL);

    expect(a).toEqual(["expensive-dentally-result"]);
    expect(b).toEqual(a);
    expect(compute).toHaveBeenCalledTimes(1); // instance2 hit the shared L2, not Dentally
  });

  it("N cold instances share ONE cold compute per key: a tab walk cannot exhaust the rate budget", async () => {
    const store = inMemoryDisplayCacheStore();
    // The heaviest dashboard cold-render read-set (distinct cache keys a tab walk touches):
    const keys = [
      "patients:site-cc:300",
      "appts:site-cc::",
      "outstanding:site-cc",
      "apptssafe:site-cc::",
      "diaryavail:site-cc:prac-1:d1:d1",
      "practitioners:site-cc",
    ];
    const compute = vi.fn(async () => ({ ok: true }));

    // Simulate 20 cold serverless instances, each rendering the whole tab walk.
    for (let i = 0; i < 20; i += 1) {
      const inst = createDisplayCache({ store });
      for (const key of keys) {
        await inst.cachedRead("vitality", key, compute, TTL);
      }
    }

    // WITHOUT the shared cache this is 20 instances x 6 reads = 120 cold computes, each
    // a multi-call Dentally page walk. WITH it, the FIRST instance computes all 6 and
    // every later instance reads L2 -> exactly 6 cold computes total, regardless of how
    // many instances the tab walk lands on. 6 << 3600/hour, so it can never exhaust it.
    expect(compute).toHaveBeenCalledTimes(keys.length);
  });
});

describe("display-cache: invalidation (a confirmed write is not hidden for the TTL, cross-instance)", () => {
  it("busts the matching keys in BOTH layers so another instance also stops serving the stale row", async () => {
    const store = inMemoryDisplayCacheStore();
    const writer = createDisplayCache({ store });
    const reader = createDisplayCache({ store }); // a different instance

    await writer.setCached("vitality", "apptssafe:site-cc::", { appointments: ["old"], failed: false, failedSiteIds: [] }, TTL);
    await writer.setCached("vitality", "appts:site-cc::", ["old"], TTL);
    await writer.setCached("vitality", "outstanding:site-cc", ["keep-me"], TTL);
    // The reader warms its L1 from L2 too.
    expect(await reader.getCached("vitality", "apptssafe:site-cc::")).toBeTruthy();

    await writer.invalidate("vitality", {
      prefixes: ["apptssafe:", "appts:", "diaryavail:"],
      l1Predicate: (key) => key.includes("site-cc"),
    });

    // Gone for the writer AND, because L2 was deleted, for the cold reader.
    expect(await writer.getCached("vitality", "apptssafe:site-cc::")).toBeUndefined();
    expect(await reader.getCached("vitality", "appts:site-cc::")).toBeUndefined();
    // Unrelated read family is untouched.
    expect(await reader.getCached("vitality", "outstanding:site-cc")).toEqual(["keep-me"]);
  });

  it("invalidation is scoped to the client: it never busts another practice's rows", async () => {
    const store = inMemoryDisplayCacheStore();
    const cache = createDisplayCache({ store });
    await cache.setCached("vitality", "appts:site-cc::", ["v"], TTL);
    await cache.setCached("other", "appts:site-zz::", ["o"], TTL);

    await cache.invalidate("vitality", { prefixes: ["appts:"], l1Predicate: () => true });

    expect(await cache.getCached("vitality", "appts:site-cc::")).toBeUndefined();
    expect(await cache.getCached("other", "appts:site-zz::")).toEqual(["o"]);
  });
});

describe("display-cache: TTL expiry and the null-tenant fresh guard", () => {
  it("recomputes once the entry has aged past its TTL, in both layers", async () => {
    const c = clock();
    const store = inMemoryDisplayCacheStore();
    const compute = vi.fn(async () => "v");
    const cache = createDisplayCache({ store, now: c.now });

    await cache.cachedRead("vitality", "k", compute, TTL);
    c.advance(TTL - 1);
    await cache.cachedRead("vitality", "k", compute, TTL); // still fresh
    expect(compute).toHaveBeenCalledTimes(1);

    c.advance(2); // now past expiry
    await cache.cachedRead("vitality", "k", compute, TTL);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("a null (unresolved) tenant is L1-only and never written to the shared L2", async () => {
    const store = inMemoryDisplayCacheStore();
    const compute = vi.fn(async () => "v");
    const instance1 = createDisplayCache({ store });
    const instance2 = createDisplayCache({ store });

    await instance1.cachedRead(null, "patients:unknown:all", compute, TTL);
    expect(store.setCalls).toBe(0); // never promoted to the shared L2

    // A different instance cannot pick it up (nothing in L2), so it recomputes.
    await instance2.cachedRead(null, "patients:unknown:all", compute, TTL);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
