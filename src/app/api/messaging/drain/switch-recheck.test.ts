import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ===========================================================================
// RULING W1-B/5 ON THE DRAIN — the organ that actually puts messages on the wire.
//
// WHAT WAS WRONG. `getDisabledSlugsForSend("vitality")` was read ONCE, at the top
// of the run, and every one of the eleven sources was then gated on that single
// verdict. The drain declares `maxDuration = 300` and takes a 310-second lease,
// and each source lists up to a hundred rows with a Dentally patient read plus a
// provider call each. So an owner who hit a kill switch twenty seconds into a tick
// changed nothing for the rest of it: the module in flight kept sending, and — the
// larger hole — every module whose turn had not yet come was still measured against
// a set captured minutes earlier, so a system switched off HUNDREDS of rows before
// it was reached drained in full anyway.
//
// The asymmetry was backwards. Every DRAFTING sweep is bound to ten rows by W1-B/5,
// and src/lib/systems/live-switch.ts justifies that bound by observing that with the
// old behaviour "nothing was delivered (the drain re-reads the switch and refuses
// the source)". The drain was written as the sweeps' backstop and had no backstop
// of its own, while being the only one of the two whose rows reach a handset.
//
// WHY NOTHING CAUGHT IT. rulings.test.ts enumerates the long-running loops that use
// the shared gate BY PATH and lists eight sweeps; the drain is not a sweep and was
// not on the list. Its own tests seed the toggle before the run and never move it,
// so no test ever observed the drain acting on a verdict that had since changed.
//
// THE FIX, IN TWO HALVES, AND BOTH ARE PINNED BELOW:
//   1. the disabled set is re-read for EVERY source, so a module switched off
//      before its turn is skipped outright; and
//   2. drainSource carries a shared `liveSwitch` gate consulted BEFORE any work on
//      a row, so the module in flight stops within SWITCH_RECHECK_EVERY_ROWS and
//      strands nothing at 'sending'.
//
// This file drives the REAL POST handler. Only the boundary is faked: the outboxes
// are in memory and the switch is a mutable set the "owner" flips from inside the
// thirteenth recipient resolution, exactly as pressing the toggle in System
// controls mid-tick would.
// ===========================================================================

interface FakeRow {
  id: string; touchId: string; siteId: string; channel: string; toRef: string; body: string;
  status: string; touchStatus: string; createdAt: string;
}

const fakes = vi.hoisted(() => {
  const makeModule = () => {
    const rows: FakeRow[] = [];
    return {
      rows,
      list: vi.fn(async (siteIds: string[]) =>
        rows
          .filter((r) => r.status === "queued" && siteIds.includes(r.siteId))
          .map(({ id, touchId, siteId, channel, toRef, body, createdAt }) => ({
            id, touchId, siteId, channel, toRef, body, createdAt,
          })),
      ),
      claim: vi.fn(async (id: string) => {
        const r = rows.find((x) => x.id === id);
        if (!r || r.status !== "queued") return false;
        r.status = "sending";
        return true;
      }),
      recordSent: vi.fn(async (id: string, _touchId: string, _fields: unknown) => {
        const r = rows.find((x) => x.id === id)!;
        r.status = "sent";
      }),
      markFailed: vi.fn(async (id: string) => { rows.find((x) => x.id === id)!.status = "failed"; }),
      markBlocked: vi.fn(async (id: string) => { rows.find((x) => x.id === id)!.status = "blocked"; }),
    };
  };
  return {
    makeModule,
    modules: {
      diary: makeModule(),
      reactivation: makeModule(),
      recall: makeModule(),
      noshow: makeModule(),
      coordinator: makeModule(),
      closer: makeModule(),
      postop: makeModule(),
      previsit: makeModule(),
      collection: makeModule(),
      reviews: makeModule(),
      outreach: makeModule(),
    },
    // The owner's switch, as System controls holds it: a set of DISABLED slugs.
    disabledSlugs: new Set<string>(),
    // Every read of that switch this run, of either shape. Counting them is how
    // "the verdict is re-read" is proved rather than assumed.
    switchReads: 0,
    // Rows the drain actually worked on, and the hook that flips the switch.
    resolved: 0,
    flipOffAtRow: 0,
    flipSlugs: [] as string[],
  };
});

function repoMock(name: keyof typeof fakes.modules) {
  return {
    listQueuedOutbox: (siteIds: string[]) => fakes.modules[name].list(siteIds),
    claimOutbox: (id: string) => fakes.modules[name].claim(id),
    recordOutboxSent: (id: string, touchId: string, fields: unknown) =>
      fakes.modules[name].recordSent(id, touchId, fields),
    markOutboxFailed: (id: string) => fakes.modules[name].markFailed(id),
    markOutboxBlocked: (id: string) => fakes.modules[name].markBlocked(id),
  };
}

vi.mock("@/lib/calendar/repository", () => repoMock("diary"));
vi.mock("@/lib/reactivation/repository", () => repoMock("reactivation"));
vi.mock("@/lib/recall/repository", () => repoMock("recall"));
vi.mock("@/lib/noshow/repository", () => repoMock("noshow"));
vi.mock("@/lib/coordinator/repository", () => repoMock("coordinator"));
vi.mock("@/lib/closer/repository", () => repoMock("closer"));
vi.mock("@/lib/postop/repository", () => repoMock("postop"));
vi.mock("@/lib/triage/repository", () => repoMock("previsit"));
vi.mock("@/lib/collection/repository", () => repoMock("collection"));
vi.mock("@/lib/reviews/repository", () => repoMock("reviews"));
vi.mock("@/lib/outreach/repository", () => repoMock("outreach"));

vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient { constructor(_opts: unknown) {} },
  DentallyError: class DentallyError extends Error {
    constructor(public status: number, message: string) { super(`Dentally ${status}: ${message}`); }
  },
}));
// The per-row hook. resolveRecipient is called once per row the drain WORKS on,
// after the gate has admitted it, so counting it counts admitted rows — and it is
// the natural place for the "owner" to press the switch mid-batch.
vi.mock("@/lib/messaging/resolve", () => ({
  resolveRecipient: async () => {
    fakes.resolved += 1;
    if (fakes.resolved === fakes.flipOffAtRow) for (const s of fakes.flipSlugs) fakes.disabledSlugs.add(s);
    return "+447700900001";
  },
}));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: async () => false }));
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async () => false,
  recordContacted: async () => {},
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async () => true,
  releaseCronLock: async () => {},
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));
// ONE fake for BOTH shapes of the question, because the drain now asks both: the
// per-source set read, and the per-row single-slug read the shared gate issues.
// They agree by construction here, exactly as they do in the real repository.
vi.mock("@/lib/systems/repository", () => ({
  getDisabledSlugs: async () => new Set(fakes.disabledSlugs),
  getDisabledSlugsForSend: async () => {
    fakes.switchReads += 1;
    return new Set(fakes.disabledSlugs);
  },
  isSystemEnabledForSend: async (_clientId: string, slug: string) => {
    fakes.switchReads += 1;
    return !fakes.disabledSlugs.has(slug);
  },
}));

import { POST } from "./route";
import { SWITCH_RECHECK_EVERY_ROWS } from "@/lib/systems/live-switch";

const ALL = [
  "diary", "reactivation", "recall", "noshow", "coordinator", "closer",
  "postop", "previsit", "collection", "reviews", "outreach",
] as const;

function seed(module: (typeof ALL)[number], count: number): void {
  for (let i = 0; i < count; i += 1) {
    const n = fakes.modules[module].rows.length + 1;
    fakes.modules[module].rows.push({
      id: `${module}-ob-${n}`, touchId: `${module}-t-${n}`, siteId: "site-1",
      channel: "sms", toRef: `patient:${module}-${n}`, body: "Hello from the practice",
      status: "queued", touchStatus: "queued", createdAt: new Date().toISOString(),
    });
  }
}

async function drain(): Promise<Record<string, never> & {
  switchedOffMidRun?: boolean;
  perSource?: Record<string, { sent: number; skipped?: string; switchedOffMidRun?: boolean }>;
}> {
  const res = await POST(new Request("http://localhost/api/messaging/drain", {
    method: "POST",
    headers: { authorization: "Bearer drain-switch-test" },
  }));
  return (await res.json()) as never;
}

const statuses = (m: (typeof ALL)[number]): Record<string, number> =>
  fakes.modules[m].rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

beforeEach(() => {
  for (const m of ALL) {
    fakes.modules[m].rows.length = 0;
    fakes.modules[m].list.mockClear();
    fakes.modules[m].claim.mockClear();
  }
  fakes.disabledSlugs.clear();
  fakes.switchReads = 0;
  fakes.resolved = 0;
  fakes.flipOffAtRow = 0;
  fakes.flipSlugs = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network egress attempted in test"); }));
  vi.stubEnv("CRON_SECRET", "drain-switch-test");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the drain stops sending when the owner flips a switch mid-tick", () => {
  it("the module in flight stops within ten rows and strands nothing at 'sending'", async () => {
    seed("recall", 40);
    fakes.flipOffAtRow = 13;
    fakes.flipSlugs = ["recall"];

    const body = await drain();

    expect(fakes.resolved, "the drain stopped instantly, so it is re-reading on every row").toBeGreaterThan(12);
    expect(
      fakes.resolved,
      "the drain kept sending past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(12 + SWITCH_RECHECK_EVERY_ROWS);

    const s = statuses("recall");
    expect(s.sent).toBe(fakes.resolved);
    expect(s.queued, "rows past the stop must stay queued for the next tick").toBe(40 - (s.sent ?? 0));
    expect(s.sending, "a halted run stranded a row mid-send").toBeUndefined();
    expect(body.perSource?.recall.switchedOffMidRun).toBe(true);
    expect(body.switchedOffMidRun, "the run did not say it had been halted").toBe(true);
  });

  it("a module switched off BEFORE its turn never drains, however late in the run it sits", async () => {
    // This is the larger half of the hole. `outreach` drains LAST of eleven
    // sources; with the verdict captured once at the top, it was still measured
    // against a set read hundreds of rows earlier and sent in full. Nothing here
    // reaches it until long after the owner has pressed off.
    seed("recall", 40);
    seed("reactivation", 10);
    seed("outreach", 10);
    fakes.flipOffAtRow = 13;
    fakes.flipSlugs = ["recall", "reactivation", "outreach"];

    const body = await drain();

    expect(body.perSource?.reactivation).toMatchObject({ skipped: "system off", sent: 0 });
    expect(body.perSource?.outreach).toMatchObject({ skipped: "system off", sent: 0 });
    expect(fakes.modules.reactivation.list, "a switched-off module's outbox was still listed").not.toHaveBeenCalled();
    expect(fakes.modules.outreach.list).not.toHaveBeenCalled();
    expect(statuses("reactivation")).toEqual({ queued: 10 });
    expect(statuses("outreach")).toEqual({ queued: 10 });
  });

  it("reads the switch many times in a run, not once", async () => {
    // The cheap, direct statement of the rule: one verdict per tick is what was
    // wrong. Eleven sources plus the gate's re-reads is many.
    seed("recall", 40);

    await drain();

    expect(fakes.switchReads, "the drain read its kill switches once for the whole run").toBeGreaterThan(1);
  });

  it("an untouched switch drains the whole batch, so the gate is a limit and not a wall", async () => {
    seed("recall", 40);

    const body = await drain();

    expect(fakes.resolved).toBe(40);
    expect(statuses("recall")).toEqual({ sent: 40 });
    expect(body.switchedOffMidRun).toBe(false);
    expect(body.perSource?.recall.switchedOffMidRun).toBe(false);
  });
});
