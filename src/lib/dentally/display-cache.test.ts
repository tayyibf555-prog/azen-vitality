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

// A capturing background scheduler: SWR refreshes are queued here instead of running
// detached, so a test can assert HOW MANY fired and run them deterministically AFTER
// the read has already returned (modelling "the response has been sent").
function captureScheduler() {
  const tasks: Array<() => Promise<void>> = [];
  return {
    schedule: (t: () => Promise<void>) => {
      tasks.push(t);
    },
    count: () => tasks.length,
    async runAll() {
      const pending = tasks.splice(0);
      for (const t of pending) await t();
    },
  };
}

const TTL = 60_000;

// The inMemory store keys its rows by JSON.stringify([clientId, cacheKey]); tests that
// look at raw rows use this to name one.
const rowKey = (clientId: string, cacheKey: string) => JSON.stringify([clientId, cacheKey]);

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

describe("display-cache: stale-while-revalidate (an expired row is served, then re-warmed)", () => {
  it("serves the stale value immediately and fires exactly one background refresh", async () => {
    const c = clock();
    const store = inMemoryDisplayCacheStore();
    const sched = captureScheduler();
    let value = "v1";
    const compute = vi.fn(async () => value);
    const cache = createDisplayCache({ store, now: c.now, scheduleBackground: sched.schedule });

    expect(await cache.cachedRead("vitality", "k", compute, TTL)).toBe("v1"); // true cold compute
    expect(compute).toHaveBeenCalledTimes(1);

    c.advance(TTL - 1);
    expect(await cache.cachedRead("vitality", "k", compute, TTL)).toBe("v1"); // still fresh
    expect(compute).toHaveBeenCalledTimes(1);
    expect(sched.count()).toBe(0); // a fresh hit never schedules a refresh

    c.advance(2); // now past expiry
    value = "v2"; // the underlying data has moved on
    const served = await cache.cachedRead("vitality", "k", compute, TTL);
    // The STALE value is returned immediately — NOT recomputed synchronously.
    expect(served).toBe("v1");
    expect(compute).toHaveBeenCalledTimes(1); // no synchronous recompute on the read path
    expect(sched.count()).toBe(1); // exactly one background refresh queued

    await sched.runAll(); // the response has returned; now the refresh runs
    expect(compute).toHaveBeenCalledTimes(2); // the refresh recomputed
    expect(await cache.cachedRead("vitality", "k", compute, TTL)).toBe("v2"); // fresh again
  });

  it("N concurrent stale reads schedule ONE refresh, not one per read (no refresh storm)", async () => {
    const c = clock();
    const store = inMemoryDisplayCacheStore();
    const sched = captureScheduler();
    const compute = vi.fn(async () => "v");
    const cache = createDisplayCache({ store, now: c.now, scheduleBackground: sched.schedule });

    await cache.cachedRead("vitality", "k", compute, TTL);
    c.advance(TTL + 1);
    await cache.cachedRead("vitality", "k", compute, TTL);
    await cache.cachedRead("vitality", "k", compute, TTL);
    await cache.cachedRead("vitality", "k", compute, TTL);
    expect(sched.count()).toBe(1); // deduped while a refresh for this key is in flight
  });

  it("a failed background refresh does NOT promote and does NOT clobber the stale row", async () => {
    const c = clock();
    const store = inMemoryDisplayCacheStore();
    const sched = captureScheduler();
    let mode: "ok" | "throw" = "ok";
    const compute = vi.fn(async () => {
      if (mode === "throw") throw new Error("dentally 503");
      return "good";
    });
    const cache = createDisplayCache({ store, now: c.now, scheduleBackground: sched.schedule });

    await cache.cachedRead("vitality", "k", compute, TTL); // stores "good"
    const before = store.rows.get(rowKey("vitality", "k"))!;
    const beforeValue = before.value;
    const beforeExpiry = before.expiresAt;

    c.advance(TTL + 1);
    mode = "throw";
    expect(await cache.cachedRead("vitality", "k", compute, TTL)).toBe("good"); // stale served
    await sched.runAll(); // the refresh throws

    // The stored row is untouched: same value, same expiry — a throwing refresh is the
    // "only a clean read is promoted" rule, so it never overwrites good stale data.
    const after = store.rows.get(rowKey("vitality", "k"))!;
    expect(after.value).toBe(beforeValue);
    expect(after.expiresAt).toBe(beforeExpiry);
    // And the next read still serves the same stale value (and retries behind it).
    expect(await cache.cachedRead("vitality", "k", compute, TTL)).toBe("good");
  });

  it("the background refresh writes back under the SAME tenant, never another practice's", async () => {
    const c = clock();
    const store = inMemoryDisplayCacheStore();
    const sched = captureScheduler();
    const cache = createDisplayCache({ store, now: c.now, scheduleBackground: sched.schedule });

    let a = "a1";
    const computeA = vi.fn(async () => a);
    await cache.cachedRead("clientA", "shared:key", computeA, TTL); // clientA row
    await cache.setCached("clientB", "shared:key", "b-stable", TTL); // clientB's own row, same key

    c.advance(TTL + 1);
    a = "a2";
    expect(await cache.cachedRead("clientA", "shared:key", computeA, TTL)).toBe("a1"); // stale + schedule
    await sched.runAll();

    // clientA refreshed to a2; clientB's row was never touched by clientA's refresh.
    expect(store.rows.get(rowKey("clientA", "shared:key"))!.value).toBe("a2");
    expect(store.rows.get(rowKey("clientB", "shared:key"))!.value).toBe("b-stable");
  });

  it("a write-invalidation DURING a background refresh must not resurrect the busted row (order pinned)", async () => {
    const c = clock();
    const store = inMemoryDisplayCacheStore();
    const sched = captureScheduler();
    const compute = vi.fn(async () => "value");
    const cache = createDisplayCache({ store, now: c.now, scheduleBackground: sched.schedule });

    await cache.cachedRead("vitality", "outstanding:site-cc", compute, TTL);
    c.advance(TTL + 1);
    expect(await cache.cachedRead("vitality", "outstanding:site-cc", compute, TTL)).toBe("value"); // stale + schedule
    expect(sched.count()).toBe(1);

    // A CONFIRMED write busts the key before the queued refresh runs.
    await cache.invalidate("vitality", {
      prefixes: ["outstanding:"],
      l1Predicate: (k) => k.startsWith("outstanding:"),
    });
    expect(store.rows.has(rowKey("vitality", "outstanding:site-cc"))).toBe(false); // gone

    await sched.runAll(); // the refresh (which read BEFORE the bust) now completes

    // It must NOT write its pre-bust value back: the row stays gone, not resurrected.
    expect(store.rows.has(rowKey("vitality", "outstanding:site-cc"))).toBe(false);
    expect(await cache.getCached("vitality", "outstanding:site-cc")).toBeUndefined();

    // MUTATION: drop the generation veto in scheduleRefresh -> the refresh's setCached
    // runs after the delete and the row comes back (has() === true) -> red.
  });

  it("FRESH PATH: getCached is fresh-only and NEVER stale-while-revalidates", async () => {
    const c = clock();
    const store = inMemoryDisplayCacheStore();
    const sched = captureScheduler();
    const cache = createDisplayCache({ store, now: c.now, scheduleBackground: sched.schedule });

    // apptssafe:* is a two-phase Safe read (the diary/availability family). It must
    // recompute on expiry, never be answered from a stale blob.
    await cache.setCached("vitality", "apptssafe:site-cc::", { appointments: [], failed: false, failedSiteIds: [] }, TTL);
    expect(await cache.getCached("vitality", "apptssafe:site-cc::")).toBeTruthy(); // fresh hit

    c.advance(TTL + 1);
    expect(await cache.getCached("vitality", "apptssafe:site-cc::")).toBeUndefined(); // expired reads as MISS
    expect(sched.count()).toBe(0); // and NEVER schedules a background refresh

    // MUTATION: point getCached at the SWR lookup (serve stale + refresh) -> a
    // write-guard/diary Safe read could be answered from a stale day and this goes red
    // (returns the value here, and sched.count() becomes 1).
  });
});

describe("display-cache: the null-tenant fresh guard", () => {
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
