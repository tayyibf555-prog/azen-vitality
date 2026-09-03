// THE FIRST TICK AFTER THE OWNER FLIPS NO-SHOW DEFENCE ON.
//
// This is the fixture that made the change necessary, at the size the live
// database actually holds: 911 active cadences already past next_due_at, of
// which 804 are stale (the appointment started, the patient settled it, the
// cadence ran out of steps, or consent went away) and 107 are genuinely due.
//
// Before this test's change, that first tick drafted and sent 107 real SMS in
// one run — no daily cap could stop it, because no-show confirmations are
// TRANSACTIONAL and the shared drain exempts them from the per-recipient
// frequency cap. It was also 107 sequential Anthropic drafts inside a 300s
// function, so much of it would have timed out half-sent.
//
// What is pinned here:
//   1. Only the cap is sent (25), never the whole backlog.
//   2. All 804 stale cadences are settled ANYWAY, in the same tick — settling
//      happens BEFORE the send ordering, so the cap can never strand them.
//   3. The 25 chosen are the 25 whose appointments are soonest.
//   4. The 82 deferred cadences are not written to AT ALL, so they stay active
//      with next_due_at in the past and the next tick claims them. No cadence-
//      level claim exists in this module (the atomic claim lives in the outbox
//      drain, queued -> sending); "leave it exactly as it was" IS the semantics.
//   5. Cap 0 pauses sending without pausing settling.
//   6. The kill switch still beats everything.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const NOW = new Date("2026-08-18T09:00:00.000Z");
const HOUR = 3_600_000;

// Must match src/lib/noshow/ramp.ts. Hard-coded on purpose: importing the
// constant would make a mutant that changes it agree with the test.
const CAP = 25;

const STALE = 804;
const GENUINE = 107;

interface FakeTarget {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  appointmentId: string;
  patientName: string;
  appointmentStartAt: string;
  appointmentState: string;
  durationMin: number;
  practitioner: string | null;
  riskScore: number;
  riskBand: "low" | "medium" | "high";
  status: string;
  priorAttempts: number;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  updatedFromDentallyAt: string;
}

interface FakeCadence {
  id: string;
  targetId: string;
  siteId: string;
  currentStep: number;
  status: string;
  nextDueAt: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

const store = vi.hoisted(() => ({
  cadences: [] as unknown[],
  targets: new Map<string, unknown>(),
  excluded: new Set<string>(),
  systemEnabled: true,
  updates: [] as Array<{ id: string; fields: Record<string, unknown> }>,
  touches: [] as Array<{ targetId: string; step: number }>,
  outbox: [] as Array<{ toRef: string }>,
  drafted: [] as string[],
}));

vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => store.systemEnabled),
  // Ruling W1-B/1: the sweep now reads isSystemEnabledForSend (fail-closed once
  // messaging is live), and liveSwitch re-reads it every ten rows. Same verdict as
  // isSystemEnabled above, so these cases keep meaning exactly what they meant.
  isSystemEnabledForSend: vi.fn(async () => store.systemEnabled),
}));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: vi.fn(async () => store.excluded),
  // Ruling W1-B/2: loadExcludedTargetKeys REFUSES when the override table is
  // unreadable and messaging is live. This fake never refuses, so the guard reads
  // false; the refusal itself is proved in src/lib/agent-wiring/scenarios.test.ts.
  isExclusionsUnavailable: () => false,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}::${patientId}`,
}));
vi.mock("@/lib/noshow/draft", () => ({
  draftNoshow: vi.fn(async (t: FakeTarget) => {
    store.drafted.push(t.id);
    return { body: `Hi ${t.patientName}` };
  }),
}));
vi.mock("@/lib/noshow/fill", () => ({
  offerSlotToNextCandidate: vi.fn(async () => null),
}));
vi.mock("@/lib/noshow/repository", () => ({
  listDueCadences: vi.fn(async () => store.cadences),
  getTarget: vi.fn(async (id: string) => store.targets.get(id) ?? null),
  incrementPriorAttempts: vi.fn(async () => {}),
  updateCadence: vi.fn(async (id: string, fields: Record<string, unknown>) => {
    store.updates.push({ id, fields });
  }),
  insertTouch: vi.fn(async (t: { targetId: string; step: number }) => {
    store.touches.push({ targetId: t.targetId, step: t.step });
    return { id: `touch-${store.touches.length}` };
  }),
  approveTouch: vi.fn(async () => {}),
  enqueueOutbox: vi.fn(async (row: { toRef: string }) => {
    store.outbox.push({ toRef: row.toRef });
  }),
  listExpiredOffers: vi.fn(async () => []),
  expireOffer: vi.fn(async () => false),
  setWaitlistStatus: vi.fn(async () => {}),
}));

import { POST } from "./route";
import { listDueCadences, updateCadence } from "@/lib/noshow/repository";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function target(id: string, over: Partial<FakeTarget> = {}): FakeTarget {
  return {
    id,
    siteId: "site-1",
    dentallyPatientId: id.replace("t-", "p-"),
    appointmentId: id.replace("t-", "a-"),
    patientName: "Test Patient",
    appointmentStartAt: new Date(NOW.getTime() + 26 * HOUR).toISOString(),
    appointmentState: "active",
    durationMin: 30,
    practitioner: "Dr Vitality",
    riskScore: 40,
    riskBand: "medium",
    status: "scheduled",
    priorAttempts: 0,
    consent: { sms: true, email: true, marketing: false },
    updatedFromDentallyAt: NOW.toISOString(),
    ...over,
  };
}

function cadence(id: string, targetId: string, currentStep = 0): FakeCadence {
  return {
    id,
    targetId,
    siteId: "site-1",
    currentStep,
    status: "active",
    // Every cadence in this fixture is already past due; listDueCadences is what
    // selects on that, and it is mocked, so the value is documentation.
    nextDueAt: new Date(NOW.getTime() - HOUR).toISOString(),
    startedAt: new Date(NOW.getTime() - 5 * 24 * HOUR).toISOString(),
    endedAt: null,
    updatedAt: NOW.toISOString(),
  };
}

/** Register a target + its cadence, appointment `hoursAway` from now. */
function enrol(idx: number, over: Partial<FakeTarget> = {}, currentStep = 0) {
  const t = target(`t-${String(idx).padStart(4, "0")}`, over);
  store.targets.set(t.id, t);
  const c = cadence(`c-${String(idx).padStart(4, "0")}`, t.id, currentStep);
  store.cadences.push(c);
  return { target: t, cadence: c };
}

/**
 * The live backlog: 804 stale cadences in the four flavours the sweep settles,
 * and 107 genuinely-due ones whose appointments are 1..107 hours away, so the
 * expected send set (the soonest 25) is unambiguous.
 */
function buildFirstTickBacklog(): { genuineIds: string[] } {
  const genuineIds: string[] = [];
  let i = 0;
  const PER_FLAVOUR = STALE / 4; // 201
  const settled = ["confirmed", "cancelled", "attended", "no_show"];

  // Stale flavour 1: the patient already settled it.
  for (let n = 0; n < PER_FLAVOUR; n += 1) enrol(i++, { status: settled[n % settled.length] });
  // Stale flavour 2: the appointment has already started.
  for (let n = 0; n < PER_FLAVOUR; n += 1) {
    enrol(i++, { appointmentStartAt: new Date(NOW.getTime() - (n + 1) * HOUR).toISOString() });
  }
  // Stale flavour 3: the cadence has run out of steps (step 3 is the last).
  for (let n = 0; n < PER_FLAVOUR; n += 1) enrol(i++, {}, 3);
  // Stale flavour 4: SMS consent has gone away.
  for (let n = 0; n < PER_FLAVOUR; n += 1) {
    enrol(i++, { consent: { sms: false, email: true, marketing: false } });
  }
  // The fixture must be the size it claims to be, or every count below is a lie.
  if (i !== STALE) throw new Error(`stale fixture built ${i} rows, expected ${STALE}`);

  // Genuinely due: appointment 1..107 hours out. Interleaved into the list in
  // REVERSE urgency so a sweep that simply took the first N would take the
  // wrong ones.
  for (let n = GENUINE; n >= 1; n -= 1) {
    const { target: t } = enrol(i++, {
      appointmentStartAt: new Date(NOW.getTime() + n * HOUR).toISOString(),
    });
    genuineIds.push(t.id);
  }
  // Most imminent first.
  genuineIds.reverse();
  return { genuineIds };
}

interface SweepBody {
  ok: boolean;
  swept: number;
  sendCap: number;
  sendable: number;
  sent: number;
  deferred: number;
  ended: number;
  suppressed: number;
  failedCadences: number;
  skipped?: string;
}

async function sweep(): Promise<SweepBody> {
  const res = await POST(new Request("http://localhost/api/noshow/sweep", { method: "POST" }));
  return (await res.json()) as SweepBody;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.cadences = [];
  store.targets = new Map();
  store.excluded = new Set();
  store.systemEnabled = true;
  store.updates = [];
  store.touches = [];
  store.outbox = [];
  store.drafted = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("no-show sweep: the first tick after switch-on", () => {
  it("sends only the cap out of 107 genuinely-due confirmations, not all 107", async () => {
    buildFirstTickBacklog();
    const out = await sweep();

    expect(out.swept).toBe(STALE + GENUINE); // 911
    expect(out.sendable).toBe(GENUINE); // 107
    expect(out.sendCap).toBe(CAP);
    expect(out.sent).toBe(CAP);
    expect(out.deferred).toBe(GENUINE - CAP); // 82

    // The cap is a cap on REAL SIDE EFFECTS, not just on a counter: exactly 25
    // drafts were spent, 25 touches written and 25 messages queued for the drain.
    expect(store.drafted).toHaveLength(CAP);
    expect(store.touches).toHaveLength(CAP);
    expect(store.outbox).toHaveLength(CAP);
  });

  it("settles all 804 stale cadences in that same tick, cap or no cap", async () => {
    buildFirstTickBacklog();
    const out = await sweep();

    // This is the rule the cap depends on. If settling happened lazily, inside
    // the send loop, a cap that stopped the loop would leave these 804 rows due
    // for ever and every future tick would re-read them.
    expect(out.ended).toBe(STALE);
    const exhausted = store.updates.filter((u) => u.fields.status === "exhausted");
    expect(exhausted).toHaveLength(STALE);
  });

  it("spends the cap on the 25 soonest appointments", async () => {
    const { genuineIds } = buildFirstTickBacklog();
    await sweep();

    // Deliberately built in reverse-urgency order in the due list, so taking the
    // first 25 as they arrive would give the 25 FURTHEST away.
    expect(store.drafted).toEqual(genuineIds.slice(0, CAP));
  });

  it("leaves every deferred cadence completely untouched for the next tick", async () => {
    const { genuineIds } = buildFirstTickBacklog();
    await sweep();

    const deferredTargets = new Set(genuineIds.slice(CAP));
    const deferredCadenceIds = store.cadences
      .filter((c) => deferredTargets.has((c as FakeCadence).targetId))
      .map((c) => (c as FakeCadence).id);
    expect(deferredCadenceIds).toHaveLength(GENUINE - CAP);

    // Not exhausted, not advanced, not written to in any way: the row still has
    // status active and next_due_at in the past, which is exactly what
    // listDueCadences selects, so the next tick picks it up.
    const written = new Set(store.updates.map((u) => u.id));
    for (const id of deferredCadenceIds) expect(written.has(id)).toBe(false);

    // And no message was drafted or queued on their behalf.
    for (const targetId of deferredTargets) {
      expect(store.drafted).not.toContain(targetId);
      expect(store.touches.map((t) => t.targetId)).not.toContain(targetId);
    }
  });

  it("writes exactly one row per settled cadence and one per sent cadence, and no more", async () => {
    buildFirstTickBacklog();
    await sweep();
    // 804 expiries + 25 advances. A double-write here would mean a cadence was
    // handled by both passes.
    expect(vi.mocked(updateCadence)).toHaveBeenCalledTimes(STALE + CAP);
    expect(new Set(store.updates.map((u) => u.id)).size).toBe(STALE + CAP);
  });

  it("drains the backlog over ticks: the next tick takes the next 25", async () => {
    const { genuineIds } = buildFirstTickBacklog();
    await sweep();

    // Simulate the state the first tick left behind: the stale ones are
    // exhausted (so listDueCadences no longer returns them) and the 25 sent have
    // advanced past this step.
    const handled = new Set(store.updates.map((u) => u.id));
    store.cadences = store.cadences.filter((c) => !handled.has((c as FakeCadence).id));
    store.updates = [];
    store.drafted = [];
    store.touches = [];
    store.outbox = [];

    const second = await sweep();
    expect(second.sendable).toBe(GENUINE - CAP); // 82
    expect(second.sent).toBe(CAP);
    expect(second.deferred).toBe(GENUINE - 2 * CAP); // 57
    // Next-soonest 25, no repeats of the first tick's 25.
    expect(store.drafted).toEqual(genuineIds.slice(CAP, 2 * CAP));
  });
});

describe("no-show sweep: the ramp's controls", () => {
  it("a cap of 0 pauses sending but still settles the backlog", async () => {
    buildFirstTickBacklog();
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", "0");
    const out = await sweep();

    expect(out.sendCap).toBe(0);
    expect(out.sent).toBe(0);
    expect(store.outbox).toHaveLength(0);
    expect(store.drafted).toHaveLength(0);
    // Still fully settled: pausing sends must not pause housekeeping, or the
    // backlog grows for as long as the pause lasts.
    expect(out.ended).toBe(STALE);
    expect(out.deferred).toBe(GENUINE);
  });

  it("a widened cap sends more, up to what is genuinely due", async () => {
    buildFirstTickBacklog();
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", "500");
    const out = await sweep();
    expect(out.sent).toBe(GENUINE);
    expect(out.deferred).toBe(0);
  });

  it("a garbled cap falls back to 25, never to unlimited", async () => {
    buildFirstTickBacklog();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", "twenty five");
    const out = await sweep();
    expect(out.sendCap).toBe(CAP);
    expect(out.sent).toBe(CAP);
    spy.mockRestore();
  });

  it("the owner's kill switch still beats everything: nothing is even read", async () => {
    buildFirstTickBacklog();
    store.systemEnabled = false;
    const out = await sweep();

    expect(out.skipped).toBe("system off");
    expect(vi.mocked(listDueCadences)).not.toHaveBeenCalled();
    expect(store.outbox).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  it("never spends the cap on an admin-excluded patient, and never closes their cadence", async () => {
    const { genuineIds } = buildFirstTickBacklog();
    // Exclude the three most imminent: they must be skipped, the cap must move on
    // to the next three, and their cadences must survive untouched so the module
    // resumes if the override is lifted.
    const excludedTargets = genuineIds.slice(0, 3);
    store.excluded = new Set(excludedTargets.map((id) => `site-1::${id.replace("t-", "p-")}`));
    const out = await sweep();

    expect(out.suppressed).toBe(3);
    expect(out.sendable).toBe(GENUINE - 3);
    expect(out.sent).toBe(CAP);
    expect(store.drafted).toEqual(genuineIds.slice(3, CAP + 3));

    const excludedCadenceIds = store.cadences
      .filter((c) => excludedTargets.includes((c as FakeCadence).targetId))
      .map((c) => (c as FakeCadence).id);
    const written = new Set(store.updates.map((u) => u.id));
    for (const id of excludedCadenceIds) expect(written.has(id)).toBe(false);
  });

  it("a failing draft costs its own cap slot and nobody else's run", async () => {
    buildFirstTickBacklog();
    const { draftNoshow } = await import("@/lib/noshow/draft");
    vi.mocked(draftNoshow).mockRejectedValueOnce(new Error("anthropic down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await sweep();
    // The cap counts ATTEMPTS: a partial failure may already have queued an
    // outbox row, so refilling its slot inside the same run is how a patient gets
    // texted twice. 25 attempted, 24 sent, 1 recorded as failed.
    expect(out.sent).toBe(CAP - 1);
    expect(out.failedCadences).toBe(1);
    expect(store.outbox).toHaveLength(CAP - 1);
    // Settling still completed in full.
    expect(out.ended).toBe(STALE);
    spy.mockRestore();
  });
});
