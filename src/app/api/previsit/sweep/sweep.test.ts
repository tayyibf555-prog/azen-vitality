import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriageTarget } from "@/lib/triage/types";

// ===========================================================================
// THE PRE-VISIT SWEEP: what it queues, and — mostly — what it refuses to.
//
// Every I/O seam is mocked; the REAL route, the REAL fork resolution, the REAL
// schedule and the REAL message composition run. So a change to any of those
// three shows up here as a behaviour change rather than as a mock drifting.
//
// THE HEADLINE: nothing reaches the outbox while the system is off, and the
// system is off by default. After that, every stop reason has its own test,
// because each one is a different patient who must not be texted.
// ===========================================================================

/** 24h before a fixed appointment, comfortably inside the send window. */
const NOW = new Date("2026-09-10T12:00:00.000Z");
const APPOINTMENT_AT = "2026-09-11T12:00:00.000Z";
const DUE_AT = "2026-09-10T12:00:00.000Z";

function target(over: Partial<TriageTarget> = {}): TriageTarget {
  return {
    id: "site-cc:appt-1",
    siteId: "site-cc",
    dentallyPatientId: "p-1",
    appointmentId: "appt-1",
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

/**
 * A stand-in for ExclusionsUnavailableError.
 *
 * Declared here rather than imported because the module it lives in is mocked
 * below, so the real class is not reachable from this file. The route recognises
 * it through `isExclusionsUnavailable`, which is mocked alongside it to answer for
 * exactly this shape — so the test proves the route's BRANCH, and the real
 * predicate keeps its own tests in the patient-status suite.
 */
class FakeExclusionsUnavailableError extends Error {
  constructor() {
    super("the patient targeting-exclusion list could not be read");
    this.name = "ExclusionsUnavailableError";
  }
}

const h = vi.hoisted(() => {
  // Inside the hoisted block: vi.mock factories run before module-level consts
  // are initialised, so a top-level SITES referenced from one is a TDZ error.
  const sites = [
    { id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", dentallyId: "d-cc" },
  ];
  const state = {
    systemOn: true,
    lockAvailable: true,
    /** Raw appointments the mocked Dentally list returns, page 1. */
    appointments: [] as unknown[],
    /** The patient object getPatient returns, or null to make the read throw. */
    patient: null as unknown,
    pending: [] as unknown[],
    /** What pass 3 finds: targets already `queued` or `sent`. */
    live: [] as unknown[],
    excluded: new Set<string>(),
    suppressed: false,
    suppressionThrows: false,
    /** The exclusion list refuses because messaging is LIVE and it cannot be read. */
    exclusionsUnavailable: false,
    upserted: [] as Array<Record<string, unknown>>,
    queued: [] as Array<Record<string, unknown>>,
    stopped: [] as Array<{ id: string; reason: string }>,
  };
  return {
    state,
    sites,
    isSystemEnabled: vi.fn(async () => state.systemOn),
    // The mid-run gate (ruling W3/4) reads the switch through the SEND variant of
    // the same module, so the fake has to answer for both or the route's import
    // of live-switch.ts fails. One state, both reads: a test that flipped only one
    // of them would prove nothing about a run the owner stopped.
    isSystemEnabledForSend: vi.fn(async () => state.systemOn),
    acquireCronLock: vi.fn(async () => state.lockAvailable),
    releaseCronLock: vi.fn(async () => {}),
    cronUnauthorized: vi.fn(() => null),
    dentallyReadKey: vi.fn(() => "key"),
    listAppointments: vi.fn(async () => ({ appointments: state.appointments })),
    getPatient: vi.fn(async () => {
      if (!state.patient) throw new Error("patient read failed");
      return { patient: state.patient };
    }),
    // STATUS-AWARE, because the route now asks TWICE for different things: pass 2
    // wants `pending`, pass 3 wants the `queued`/`sent` rows an appointment may
    // have overtaken. A mock that answered the same list to both would hand pass 3
    // rows it can never see in production and prove nothing about either.
    listTargets: vi.fn(async (args: { statuses: string[] }) =>
      args.statuses.includes("pending") ? state.pending : state.live,
    ),
    upsertTargetIfNew: vi.fn(async (input: Record<string, unknown>) => {
      state.upserted.push(input);
      return { ...target(), ...input };
    }),
    enqueueSend: vi.fn(async (input: Record<string, unknown>) => {
      state.queued.push(input);
      return { touchId: "t", outboxId: "o" };
    }),
    stopTarget: vi.fn(async (id: string, reason: string) => {
      state.stopped.push({ id, reason });
    }),
    loadExcludedTargetKeys: vi.fn(async () => {
      if (state.exclusionsUnavailable) throw new FakeExclusionsUnavailableError();
      return state.excluded;
    }),
    isSuppressed: vi.fn(async () => {
      if (state.suppressionThrows) throw new Error("suppression read failed");
      return state.suppressed;
    }),
  };
});

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledForSend: h.isSystemEnabledForSend,
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: h.acquireCronLock,
  releaseCronLock: h.releaseCronLock,
}));
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
  isExclusionsUnavailable: (err: unknown) => err instanceof FakeExclusionsUnavailableError,
}));
vi.mock("@/lib/triage/repository", () => ({
  listTargets: h.listTargets,
  upsertTargetIfNew: h.upsertTargetIfNew,
  enqueueSend: h.enqueueSend,
  stopTarget: h.stopTarget,
}));

import { POST } from "./route";

function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/previsit/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.state.systemOn = true;
  h.state.lockAvailable = true;
  h.state.appointments = [];
  h.state.patient = { first_name: "Alex", last_name: "Berry", use_sms: true, payment_plan_id: 2 };
  h.state.pending = [];
  h.state.live = [];
  h.state.excluded = new Set();
  h.state.suppressed = false;
  h.state.suppressionThrows = false;
  h.state.exclusionsUnavailable = false;
  h.state.upserted = [];
  h.state.queued = [];
  h.state.stopped = [];
  process.env.PUBLIC_BASE_URL = "https://azen-vitality.vercel.app";
  // The bound two of the pass-3 tests shrink. Cleared here rather than in those
  // tests: an env var left set is the quietest way to make a later test in this
  // file — or in another file sharing the worker — prove something else.
  delete process.env.PREVISIT_MAX_EXAMINED;
});

describe("NOTHING SENDS WHILE THE SYSTEM IS OFF", () => {
  it("an off system queues nothing and reads nothing", async () => {
    h.state.systemOn = false;
    h.state.pending = [target()];
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "system off" });
    expect(h.state.queued).toEqual([]);
    // ...and it does not even reach Dentally, so an off system costs nothing.
    expect(h.listAppointments).not.toHaveBeenCalled();
    expect(h.dentallyReadKey).not.toHaveBeenCalled();
  });

  it("a second concurrent run queues nothing", async () => {
    h.state.lockAvailable = false;
    h.state.pending = [target()];
    const res = await run();
    expect(await res.json()).toMatchObject({ skipped: "another run in progress" });
    expect(h.state.queued).toEqual([]);
  });
});

describe("the fork is resolved from the payment plan, server-side", () => {
  const appointment = {
    id: "appt-1",
    patient_id: "p-1",
    start_time: APPOINTMENT_AT,
    state: "booked",
  };

  it.each([
    [2, "full", "a private plan"],
    [1, "brief", "the NHS plan"],
    [47752, "brief", "the UDC plan"],
    [99999, "brief", "an unknown plan"],
    [null, "brief", "no plan on file"],
  ])("plan %s -> %s (%s)", async (planId, fork, why) => {
    h.state.appointments = [appointment];
    h.state.patient = {
      first_name: "Alex",
      last_name: "Berry",
      use_sms: true,
      payment_plan_id: planId,
    };
    await run();
    expect(h.state.upserted[0]?.fork, `${why} must resolve to the ${fork} bank`).toBe(fork);
  });

  it("reads the plan through the SHARED reader, so a nested payment_plan works too", async () => {
    h.state.appointments = [appointment];
    h.state.patient = {
      first_name: "Alex",
      last_name: "Berry",
      use_sms: true,
      payment_plan: { id: 2 },
    };
    await run();
    expect(h.state.upserted[0]?.fork).toBe("full");
  });

  it("reads each DISTINCT patient once, not once per appointment", async () => {
    h.state.appointments = [
      appointment,
      { ...appointment, id: "appt-2" },
      { ...appointment, id: "appt-3", patient_id: "p-2" },
    ];
    await run();
    expect(h.getPatient).toHaveBeenCalledTimes(2);
  });

  it("does NOT flag at all when the patient cannot be read", async () => {
    // A patient we could not read is a patient whose plan we do not know, and the
    // whole point of the fork is that it is proved rather than guessed.
    h.state.appointments = [appointment];
    h.state.patient = null;
    const res = await run();
    expect(h.state.upserted).toEqual([]);
    expect(await res.json()).toMatchObject({ skippedNoFacts: 1 });
  });

  it("drops a cancelled or did-not-attend appointment before reading the patient", async () => {
    for (const state of ["cancelled", "did_not_attend"]) {
      vi.clearAllMocks();
      h.state.upserted = [];
      h.state.appointments = [{ ...appointment, state }];
      await run();
      expect(h.state.upserted, `a ${state} appointment was flagged`).toEqual([]);
      expect(h.getPatient).not.toHaveBeenCalled();
    }
  });
});

describe("what reaches the outbox", () => {
  it("queues one scanned, one-credit message with the patient's link", async () => {
    h.state.pending = [target()];
    const res = await run();
    expect(h.state.queued.length).toBe(1);
    const queued = h.state.queued[0];
    expect(queued.channel).toBe("sms");
    expect(queued.toRef).toBe("patient:p-1");
    expect(String(queued.body)).toContain("https://azen-vitality.vercel.app/pv/AbCdEfGhIjKlMnOpQrStUv");
    expect(String(queued.body)).toContain("N15 Vitality Dental");
    expect(String(queued.body).length).toBeLessThanOrEqual(160);
    expect(await res.json()).toMatchObject({ queued: 1 });
  });

  it("queues at the DUE instant, which is already quiet-hours clamped", async () => {
    // The shared drain has no time-of-day gate, so quiet hours live on the row.
    h.state.pending = [target()];
    await run();
    expect(h.state.queued[0].notBeforeAt).toBe(DUE_AT);
  });
});

describe("an unreadable exclusion list stops the whole tick (ruling W1-B/2)", () => {
  // EXCLUSIONS UNKNOWN MEANS NOBODY MAY BE DRAFTED. `loadExcludedTargetKeys`
  // refuses rather than returning an empty set when it cannot read the override
  // table and messaging is live, because an empty set reads as "nobody is
  // excluded" — which would text every patient a human had marked inactive.
  it("returns skipped and queues NOTHING when the exclusion list refuses", async () => {
    h.state.pending = [target(), target({ id: "site-cc:appt-2", appointmentId: "appt-2" })];
    h.state.exclusionsUnavailable = true;
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "exclusions unavailable" });
    expect(h.state.queued).toEqual([]);
    // ...and nothing is STOPPED either: a skipped tick is a delay, and these
    // targets must still be sendable on the next one. Retiring them would turn a
    // database blip into a patient who never got their form.
    expect(h.state.stopped).toEqual([]);
  });

  it("still queues normally once the exclusion list can be read again", async () => {
    // The other half: the refusal is a skip, not a latch.
    h.state.pending = [target()];
    h.state.exclusionsUnavailable = false;
    await run();
    expect(h.state.queued.length).toBe(1);
  });

  it("does NOT swallow an unrelated error from the exclusion read", async () => {
    // The catch is narrowed by isExclusionsUnavailable. A different failure must
    // still surface rather than being reported as a tidy skip.
    h.state.pending = [target()];
    h.loadExcludedTargetKeys.mockRejectedValueOnce(new Error("something else entirely"));
    await expect(run()).rejects.toThrow("something else entirely");
    expect(h.state.queued).toEqual([]);
  });
});

describe("who is NOT texted, and why", () => {
  async function expectStopped(t: Partial<TriageTarget>, reason: string, setup?: () => void) {
    h.state.pending = [target(t)];
    setup?.();
    await run();
    expect(h.state.queued, `${reason}: something was queued`).toEqual([]);
    expect(h.state.stopped[0]?.reason).toBe(reason);
  }

  it("a patient with no SMS consent", async () => {
    await expectStopped({ consentSms: false }, "no_consent");
  });

  it("a patient who has opted out", async () => {
    await expectStopped({}, "opted_out", () => {
      h.state.suppressed = true;
    });
  });

  it("a patient excluded from all targeting", async () => {
    await expectStopped({}, "excluded", () => {
      h.state.excluded = new Set(["site-cc:p-1"]);
    });
  });

  it("an appointment that has already started", async () => {
    await expectStopped({ appointmentAt: "2026-09-10T11:00:00.000Z" }, "stale");
  });

  it("a target that sat unsent through an outage", async () => {
    await expectStopped(
      { appointmentAt: "2026-09-12T12:00:00.000Z", dueAt: "2026-09-09T00:00:00.000Z" },
      "stale",
    );
  });

  it("a target with no link, because PUBLIC_BASE_URL is unset, is stopped as no_link", async () => {
    // Its own reason, because it means the DEPLOYMENT is misconfigured rather than
    // that anything is wrong with this patient, and whoever reads the worklist
    // should be told which.
    delete process.env.PUBLIC_BASE_URL;
    h.state.pending = [target({ linkToken: "" })];
    await run();
    expect(h.state.queued).toEqual([]);
    expect(h.state.stopped[0]?.reason).toBe("no_link");
  });

  it("a suppression read that THREW leaves the target pending rather than sending", async () => {
    // A read that throws must never be taken as "not opted out". The next tick
    // retries; the staleness guard retires it if the outage outlasts the window.
    h.state.pending = [target()];
    h.state.suppressionThrows = true;
    const res = await run();
    expect(h.state.queued).toEqual([]);
    expect(h.state.stopped).toEqual([]);
    expect(await res.json()).toMatchObject({ waiting: 1 });
  });

  it("a target that is not yet due WAITS rather than being stopped", async () => {
    h.state.pending = [target({ dueAt: "2026-09-10T18:00:00.000Z" })];
    const res = await run();
    expect(h.state.queued).toEqual([]);
    expect(h.state.stopped).toEqual([]);
    expect(await res.json()).toMatchObject({ waiting: 1 });
  });

  it("a patient whose name is unusable is stopped rather than texted 'Hi ,'", async () => {
    h.state.pending = [target({ patientName: "" })];
    await run();
    expect(h.state.queued).toEqual([]);
    expect(h.state.stopped.length).toBe(1);
  });
});

// ===========================================================================
// PASS 3: THE RETIREMENT PASS (ruling W3/5).
//
// `sent` had no terminal transition anywhere in the module — pass 2 lists only
// `pending`, stopTarget was reached from that loop and from recordNonDelivery,
// and 0097 adds no trigger — so a delivered link stayed `sent` for ever and the
// module's counters climbed with it. The three DOORS (drain, /pv page, submit
// route) stop the harm; this pass is what makes the row agree with them.
// ===========================================================================
describe("PASS 3: a link its appointment has overtaken is retired", () => {
  /** An hour after NOW, and an hour before it. */
  const AHEAD = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  const BEHIND = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

  it("stops a SENT target whose appointment has already started, as `expired`", async () => {
    h.state.live = [target({ id: "t-sent", status: "sent", appointmentAt: BEHIND })];
    const res = await run();
    expect(h.state.stopped).toEqual([{ id: "t-sent", reason: "expired" }]);
    expect(await res.json()).toMatchObject({ expired: 1, expiredMore: false });
  });

  it("stops a QUEUED one too, so a drain that never ran cannot leave a live row", async () => {
    h.state.live = [target({ id: "t-queued", status: "queued", appointmentAt: BEHIND })];
    await run();
    expect(h.state.stopped).toEqual([{ id: "t-queued", reason: "expired" }]);
  });

  it("LEAVES a target whose appointment is still ahead of us exactly as it is", async () => {
    // The control. Without it every assertion here would pass against a pass that
    // retired the whole list.
    h.state.live = [target({ id: "t-live", status: "sent", appointmentAt: AHEAD })];
    const res = await run();
    expect(h.state.stopped).toEqual([]);
    expect(await res.json()).toMatchObject({ expired: 0 });
  });

  it("the boundary is EXCLUSIVE: at the appointment instant itself the target is retired", async () => {
    // `now < start`, byte-for-byte the drain's comparison, the page's and the
    // submit route's, so all four agree about which side of the appointment we
    // are on.
    h.state.live = [target({ id: "t-now", status: "sent", appointmentAt: NOW.toISOString() })];
    await run();
    expect(h.state.stopped).toEqual([{ id: "t-now", reason: "expired" }]);

    h.state.stopped = [];
    h.state.live = [
      target({ id: "t-ms", status: "sent", appointmentAt: new Date(NOW.getTime() + 1).toISOString() }),
    ];
    await run();
    expect(h.state.stopped, "one millisecond ahead is still ahead").toEqual([]);
  });

  it("FAILS CLOSED on an appointment instant that cannot be read", async () => {
    for (const bad of ["", "not a date", "2026-13-45T99:99:00Z"]) {
      h.state.stopped = [];
      h.state.live = [target({ id: "t-bad", status: "sent", appointmentAt: bad })];
      await run();
      expect(h.state.stopped, `"${bad}" was left live`).toEqual([{ id: "t-bad", reason: "expired" }]);
    }
  });

  it("SENDS NOTHING and reads no Dentally endpoint while retiring", async () => {
    h.state.live = [
      target({ id: "t-1", status: "sent", appointmentAt: BEHIND }),
      target({ id: "t-2", status: "queued", appointmentAt: BEHIND }),
    ];
    await run();
    expect(h.state.stopped.length).toBe(2);
    expect(h.state.queued, "the retirement pass queued a message").toEqual([]);
    expect(h.getPatient).not.toHaveBeenCalled();
  });

  it("says AT LEAST rather than a bare figure when the bound bit", async () => {
    // A capped read never wears a complete number's clothes (charter §0/5, ruling
    // W3/11): the route asks for one row MORE than it will retire, and reports
    // `expiredMore` when the page came back over-full with every row retired.
    process.env.PREVISIT_MAX_EXAMINED = "3";
    h.state.live = Array.from({ length: 4 }, (_, i) =>
      target({ id: `t-${i}`, status: "sent", appointmentAt: BEHIND }),
    );
    const res = await run();
    expect(h.state.stopped.length).toBe(3);
    expect(await res.json()).toMatchObject({ expired: 3, expiredMore: true });
  });

  it("does NOT say `at least` when the list simply ended", async () => {
    process.env.PREVISIT_MAX_EXAMINED = "3";
    h.state.live = [
      target({ id: "t-0", status: "sent", appointmentAt: BEHIND }),
      target({ id: "t-1", status: "sent", appointmentAt: AHEAD }),
    ];
    const res = await run();
    expect(await res.json()).toMatchObject({ expired: 1, expiredMore: false });
  });

  it("does not run at all while the system is off", async () => {
    h.state.systemOn = false;
    h.state.live = [target({ id: "t-sent", status: "sent", appointmentAt: BEHIND })];
    await run();
    expect(h.state.stopped).toEqual([]);
  });
});
