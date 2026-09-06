import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriageTarget } from "@/lib/triage/types";
import { POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";

// ===========================================================================
// RULING W3/4 ON THE PRE-VISIT SWEEP (the seventh sweep).
//
// W1-B/5 is the fail-direction law: a sweep that may run for 300 seconds re-reads
// its kill switch inside the batch loop every ten rows, and stops within that
// bound. This route did not. It read `pre-visit-triage` ONCE, at the top, and
// then walked up to `maxExaminedPerRun` appointment rows — one Dentally patient
// read each — before queueing up to `maxQueuedPerRun` patient-facing links. The
// verdict pass 2 acted on could be minutes old, which is the widest stale-verdict
// window of any sweep in the tree.
//
// What that cost: an owner who switched the module off from System controls at
// 09:00:30, while the 09:00 tick was in flight, still got up to sixty
// previsit_outbox rows written behind them. The drain would not deliver them
// while the switch stayed off — it re-reads the switch and skips this source —
// but the rows persist, and the drain's own comment says what happens next: they
// "drain the moment it is switched back on".
//
// THESE TESTS DRIVE THE REAL ROUTE. Only the boundary is faked: the switch is a
// mutable toggle the "owner" flips from inside a Dentally read, a stopTarget or
// an enqueueSend — exactly as flipping it in System controls mid-run would.
//
// The grep in src/lib/agent-wiring/rulings.test.ts ("every long-running sweep
// uses the shared gate") names this route as the seventh. A grep proves the gate
// is IMPORTED; this file proves it STOPS things, which is the half that matters.
// ===========================================================================

/** 24h before a fixed appointment, comfortably inside the send window. */
const NOW = new Date("2026-09-10T12:00:00.000Z");
const APPOINTMENT_AT = "2026-09-11T12:00:00.000Z";
const DUE_AT = "2026-09-10T12:00:00.000Z";

function target(i: number, over: Partial<TriageTarget> = {}): TriageTarget {
  return {
    id: `site-cc:appt-${i}`,
    siteId: "site-cc",
    dentallyPatientId: `p-${i}`,
    appointmentId: `appt-${i}`,
    patientName: "Alex Berry",
    fork: "full",
    appointmentAt: APPOINTMENT_AT,
    dueAt: DUE_AT,
    status: "pending",
    stopReason: null,
    consentSms: true,
    linkToken: "AbCdEfGhIjKlMnOpQrStUv",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...over,
  };
}

const h = vi.hoisted(() => {
  const sites = [{ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", dentallyId: "d-cc" }];
  const state = {
    /** The owner's switch. Every read of it — top of run AND every re-read — sees this. */
    systemOn: true,
    appointments: [] as unknown[],
    pending: [] as unknown[],
    /** What pass 3 finds: `queued`/`sent` rows an appointment may have overtaken. */
    live: [] as unknown[],
    /** Flip the switch off when the Nth call of the named kind happens. 0 = never. */
    flipOffAtPatientRead: 0,
    flipOffAtQueue: 0,
    flipOffAtStop: 0,
    patientReads: 0,
    upserted: [] as Array<Record<string, unknown>>,
    queued: [] as Array<Record<string, unknown>>,
    stopped: [] as Array<{ id: string; reason: string }>,
    /** Existing `previsit_target` keys — see the same field in sweep.test.ts. */
    targetIds: new Set<string>(),
  };
  return {
    state,
    sites,
    isSystemEnabled: vi.fn(async () => state.systemOn),
    isSystemEnabledForSend: vi.fn(async () => state.systemOn),
    acquireCronLock: vi.fn(async () => true),
    releaseCronLock: vi.fn(async () => {}),
    cronUnauthorized: vi.fn(() => null),
    dentallyReadKey: vi.fn(() => "key"),
    listAppointments: vi.fn(async () => ({ appointments: state.appointments })),
    getPatient: vi.fn(async () => {
      state.patientReads += 1;
      if (state.patientReads === state.flipOffAtPatientRead) state.systemOn = false;
      return { patient: { first_name: "Alex", last_name: "Berry", use_sms: true, payment_plan_id: 2 } };
    }),
    // STATUS-AWARE: pass 2 asks for `pending`, pass 3 for `queued`/`sent`. One
    // answer to both would let a pass-2 fixture drive pass 3 and vice versa.
    // `limit` is honoured, and clipped at the server's own max-rows ceiling, for
    // the reason spelled out in sweep.test.ts: a fake looser than live is how a
    // bound that no longer binds goes unnoticed (charter §0/11).
    listTargets: vi.fn(async (args: { statuses: string[]; limit?: number }) => {
      const rows = args.statuses.includes("pending") ? state.pending : state.live;
      return rows.slice(0, Math.min(args.limit ?? 500, POSTGREST_MAX_ROWS));
    }),
    upsertTargetIfNew: vi.fn(async (input: Record<string, unknown>) => {
      state.upserted.push(input);
      const id = `${String(input.siteId)}:${String(input.appointmentId)}`;
      if (state.targetIds.has(id)) return null;
      state.targetIds.add(id);
      return { ...target(0), ...input, id };
    }),
    getTarget: vi.fn(async (id: string) => (state.targetIds.has(id) ? target(0, { id }) : null)),
    enqueueSend: vi.fn(async (input: Record<string, unknown>) => {
      state.queued.push(input);
      if (state.queued.length === state.flipOffAtQueue) state.systemOn = false;
      return { touchId: "t", outboxId: "o" };
    }),
    stopTarget: vi.fn(async (id: string, reason: string) => {
      state.stopped.push({ id, reason });
      if (state.stopped.length === state.flipOffAtStop) state.systemOn = false;
    }),
    loadExcludedTargetKeys: vi.fn(async () => new Set<string>()),
    isSuppressed: vi.fn(async () => false),
  };
});

// ONE fake serves both the top-of-run check and every re-read inside the loops:
// the gate reads the switch through this same module.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledForSend: h.isSystemEnabledForSend,
}));
vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: h.acquireCronLock, releaseCronLock: h.releaseCronLock }));
vi.mock("@/lib/cron", () => ({ cronUnauthorized: h.cronUnauthorized }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: h.dentallyReadKey }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    listAppointments = h.listAppointments;
    getPatient = h.getPatient;
  },
}));
vi.mock("@/lib/dentally/budget", () => ({
  dentallyScopeRefused: () => false,
  runWithDentallyPriority: async (_p: string, fn: () => Promise<Response>) => fn(),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: h.sites,
  getSite: (id: string) => h.sites.find((s) => s.id === id),
  dentallySiteId: (id: string) => h.sites.find((s) => s.id === id)?.dentallyId ?? id,
}));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: h.isSuppressed }));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: h.loadExcludedTargetKeys,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
  isExclusionsUnavailable: () => false,
}));
vi.mock("@/lib/triage/repository", () => ({
  listTargets: h.listTargets,
  upsertTargetIfNew: h.upsertTargetIfNew,
  enqueueSend: h.enqueueSend,
  stopTarget: h.stopTarget,
  getTarget: h.getTarget,
  triageTargetId: (siteId: string, appointmentId: string) => `${siteId}:${appointmentId}`,
}));

import { POST } from "./route";
import { SWITCH_RECHECK_EVERY_ROWS } from "@/lib/systems/live-switch";

async function sweep(): Promise<Record<string, unknown>> {
  const res = await POST(new Request("http://localhost/api/previsit/sweep", { method: "POST" }));
  return (await res.json()) as Record<string, unknown>;
}

/** `n` pending targets, all of them sendable right now. */
function seedPending(n: number, over: Partial<TriageTarget> = {}): void {
  h.state.pending = Array.from({ length: n }, (_, i) => target(i, over));
}

/** An instant an hour BEHIND the pinned clock: every pass-3 fixture is overdue. */
const BEHIND = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

/** `n` already-sent targets, all of them overdue and therefore retirable. */
function seedLive(n: number, over: Partial<TriageTarget> = {}): void {
  h.state.live = Array.from({ length: n }, (_, i) => target(i, { status: "sent", ...over }));
}

/** `n` upcoming appointments for `n` DISTINCT patients, all inside the window. */
function seedAppointments(n: number): void {
  h.state.appointments = Array.from({ length: n }, (_, i) => ({
    id: `appt-${i}`,
    patient_id: `p-${i}`,
    start_time: APPOINTMENT_AT,
    state: "booked",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.state.systemOn = true;
  h.state.appointments = [];
  h.state.pending = [];
  h.state.live = [];
  h.state.flipOffAtPatientRead = 0;
  h.state.flipOffAtQueue = 0;
  h.state.flipOffAtStop = 0;
  h.state.patientReads = 0;
  h.state.upserted = [];
  h.state.queued = [];
  h.state.stopped = [];
  h.state.targetIds = new Set();
  process.env.PUBLIC_BASE_URL = "https://azen-vitality.vercel.app";
});

describe("ruling W3/4: the pre-visit sweep re-reads its switch mid-run", () => {
  it("stops QUEUEING links within ten rows of a mid-run switch-off", async () => {
    seedPending(60);
    h.state.flipOffAtQueue = 13; // the owner flips it off once the 13th link is queued

    const body = await sweep();

    // Not instantly — the ruling asks for a read every ten rows, not one per row.
    expect(h.state.queued.length, "the sweep stopped before the flip; the gate reads too eagerly").toBeGreaterThan(12);
    expect(
      h.state.queued.length,
      "the sweep kept queueing patient links past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(13 + SWITCH_RECHECK_EVERY_ROWS);
    expect(body.switchedOffMidRun, "the run did not report that the owner stopped it").toBe(true);
    expect(body.queued).toBe(h.state.queued.length);
  });

  it("stops RETIRING targets too, so a halted run stops nothing it did not intend to", async () => {
    // Every target here would be stopped as `no_consent`. The gate is consulted
    // BEFORE decideSend/stopTarget, so a run the owner halted leaves the targets it
    // never reached exactly as they were — at `pending`, for the next tick — rather
    // than marking them stopped on the strength of a verdict that is now stale.
    seedPending(60, { consentSms: false });
    h.state.flipOffAtStop = 13;

    const body = await sweep();

    expect(h.state.stopped.length).toBeGreaterThan(12);
    expect(
      h.state.stopped.length,
      "the sweep kept mutating target rows past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(13 + SWITCH_RECHECK_EVERY_ROWS);
    expect(h.state.queued).toEqual([]);
    expect(body.switchedOffMidRun).toBe(true);
  });

  it("stops FLAGGING in pass 1 too, where the Dentally reads are", async () => {
    // Pass 1 is where the minutes accrue: one getPatient per distinct patient,
    // sequentially. A gate on pass 2 alone would leave the owner paying for
    // hundreds of reads after switching the module off.
    seedAppointments(60);
    h.state.flipOffAtPatientRead = 13;

    const body = await sweep();

    expect(h.state.upserted.length).toBeGreaterThan(12);
    expect(
      h.state.upserted.length,
      "pass 1 kept reading patients and flagging appointments past the ten-row bound",
    ).toBeLessThanOrEqual(13 + SWITCH_RECHECK_EVERY_ROWS);
    expect(body.switchedOffMidRun).toBe(true);
  });

  it("does not start pass 2 OR pass 3 at all once pass 1 has read the switch off", async () => {
    seedAppointments(60);
    seedPending(60);
    // Sixty rows pass 3 WOULD retire, so "nothing was listed" is a real refusal
    // rather than an empty table.
    seedLive(60, { appointmentAt: BEHIND });
    h.state.flipOffAtPatientRead = 13;

    const body = await sweep();

    // Not even the target list is read: the owner switched it off, so this tick
    // spends nothing more, queues nothing and retires nothing. `listTargets` is
    // the entry to BOTH later passes, so one assertion covers both — pass 3's
    // retirement read is skipped for the same reason pass 2's is.
    expect(h.listTargets).not.toHaveBeenCalled();
    expect(h.state.queued).toEqual([]);
    expect(h.state.stopped).toEqual([]);
    expect(body).toMatchObject({ queued: 0, switchedOffMidRun: true });
  });

  it("re-reads through the SEND fail-direction, which for this slug fails CLOSED", async () => {
    // isSystemEnabledForSend, not isSystemEnabled: an unreadable toggle table must
    // stop a run that texts patients. pre-visit-triage is defaultEnabled:false, so
    // it fails closed whatever MESSAGING_DRY_RUN says.
    seedPending(60);
    await sweep();
    expect(
      h.isSystemEnabledForSend,
      "the mid-run re-read does not go through isSystemEnabledForSend",
    ).toHaveBeenCalledWith("vitality", "pre-visit-triage");
  });

  it("CONTROL: with the switch left on, every pending target is queued", async () => {
    // Without this, the assertions above would pass against a sweep that stopped
    // for any reason at all, including one that queued nothing.
    seedPending(60);

    const body = await sweep();

    expect(h.state.queued.length).toBe(60);
    expect(body).toMatchObject({ ok: true, queued: 60, switchedOffMidRun: false });
  });

  it("CONTROL: a switch that was already off never reaches either loop", async () => {
    seedAppointments(60);
    seedPending(60);
    h.state.systemOn = false;

    const body = await sweep();

    expect(body).toEqual({ ok: true, skipped: "system off" });
    expect(h.acquireCronLock).not.toHaveBeenCalled();
    expect(h.state.queued).toEqual([]);
    expect(h.state.upserted).toEqual([]);
  });
});

describe("ruling W3/4 reaches the retirement pass too", () => {
  it("stops RETIRING overtaken links within ten rows of a mid-run switch-off", async () => {
    // Pass 3 mutates rows, so W1-B/5 applies to it exactly as it does to pass 2:
    // `stillOn()` is consulted FIRST in the loop, before `stopTarget`, so a run
    // the owner halted leaves the rows it never reached exactly as they were.
    seedLive(60, { appointmentAt: BEHIND });
    h.state.flipOffAtStop = 13;

    const body = await sweep();

    expect(h.state.stopped.length, "the pass stopped before the flip; the gate reads too eagerly").toBeGreaterThan(12);
    expect(
      h.state.stopped.length,
      "the retirement pass kept mutating target rows past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(13 + SWITCH_RECHECK_EVERY_ROWS);
    expect(body.switchedOffMidRun).toBe(true);
    expect(body.expired).toBe(h.state.stopped.length);
  });
});
