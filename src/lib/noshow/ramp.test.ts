// The no-show ramp rules, tested directly. These are the only brakes on the
// module: no-show confirmations are transactional, so the drain's per-recipient
// daily frequency cap does not apply to them, and the module has no daily
// contact limit of its own. If a rule here is wrong, real patients get texted.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { SCHEDULER } from "@/lib/agent-wiring/scheduler";
import { srcPath } from "@/lib/test-support/walk-src";
import {
  NOSHOW_DEFAULT_MAX_SENDS_PER_RUN,
  noshowSendCap,
  disposeCadence,
  orderBySoonestAppointment,
  applySendCap,
} from "./ramp";

const NOW = new Date("2026-08-18T09:00:00.000Z");

function dispositionInput(over: Partial<Parameters<typeof disposeCadence>[0]> = {}) {
  return {
    excluded: false,
    targetStatus: "scheduled",
    appointmentStartAt: new Date(NOW.getTime() + 26 * 3_600_000).toISOString(),
    hasNextStep: true,
    channelConsented: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// noshowSendCap
// ---------------------------------------------------------------------------

describe("noshowSendCap", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is 25 when nothing is configured", () => {
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", undefined as unknown as string);
    expect(noshowSendCap()).toBe(NOSHOW_DEFAULT_MAX_SENDS_PER_RUN);
    expect(NOSHOW_DEFAULT_MAX_SENDS_PER_RUN).toBe(25);
  });

  it("takes a configured widening of the ramp", () => {
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", "60");
    expect(noshowSendCap()).toBe(60);
  });

  it("treats 0 as a real pause, not as a misconfiguration", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", "0");
    expect(noshowSendCap()).toBe(0);
    // 0 is the owner deliberately holding the module; it must not be shouted
    // about and must NOT fall back to the default, which would send 25.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["lots", "non-numeric"],
    ["-5", "negative"],
    ["NaN", "NaN"],
  ])("reverts to the default LOUDLY for %s (%s), never to unlimited", (raw) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", raw);
    expect(noshowSendCap()).toBe(NOSHOW_DEFAULT_MAX_SENDS_PER_RUN);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("NOSHOW_MAX_SENDS_PER_RUN");
    spy.mockRestore();
  });

  it("floors a fractional cap rather than slicing on a fraction", () => {
    vi.stubEnv("NOSHOW_MAX_SENDS_PER_RUN", "12.9");
    expect(noshowSendCap()).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// disposeCadence
// ---------------------------------------------------------------------------

describe("disposeCadence", () => {
  it("sends a consented, still-confirmable, still-scheduled appointment", () => {
    expect(disposeCadence(dispositionInput(), NOW)).toBe("send");
  });

  it("suppresses an admin-excluded patient WITHOUT closing the cadence", () => {
    // Exclusion is a reversible override: closing the cadence would be permanent,
    // so it must win over every expiry rule and leave the row untouched.
    expect(disposeCadence(dispositionInput({ excluded: true }), NOW)).toBe("suppress");
    expect(disposeCadence(dispositionInput({ excluded: true, targetStatus: "cancelled" }), NOW)).toBe("suppress");
    expect(disposeCadence(dispositionInput({ excluded: true, hasNextStep: false }), NOW)).toBe("suppress");
    expect(disposeCadence(dispositionInput({ excluded: true, channelConsented: false }), NOW)).toBe("suppress");
  });

  it.each(["confirmed", "cancelled", "attended", "no_show"])(
    "expires a cadence whose patient has already settled it (%s)",
    (status) => {
      expect(disposeCadence(dispositionInput({ targetStatus: status }), NOW)).toBe("expire");
    },
  );

  it("expires once the appointment has started, and at the exact start instant", () => {
    const started = new Date(NOW.getTime() - 1).toISOString();
    expect(disposeCadence(dispositionInput({ appointmentStartAt: started }), NOW)).toBe("expire");
    // Boundary: reminding someone about an appointment starting this very second
    // is pointless, so `<=` not `<`.
    expect(disposeCadence(dispositionInput({ appointmentStartAt: NOW.toISOString() }), NOW)).toBe("expire");
    // One millisecond of runway is still runway.
    const barely = new Date(NOW.getTime() + 1).toISOString();
    expect(disposeCadence(dispositionInput({ appointmentStartAt: barely }), NOW)).toBe("send");
  });

  it("expires an unreadable appointment time instead of messaging blind", () => {
    for (const bad of ["", "not-a-date", "2026-13-40T00:00:00Z"]) {
      expect(disposeCadence(dispositionInput({ appointmentStartAt: bad }), NOW)).toBe("expire");
    }
  });

  it("expires a cadence that has run out of steps", () => {
    expect(disposeCadence(dispositionInput({ hasNextStep: false }), NOW)).toBe("expire");
  });

  it("expires rather than sends when the step's channel is not consented", () => {
    expect(disposeCadence(dispositionInput({ channelConsented: false }), NOW)).toBe("expire");
  });
});

// ---------------------------------------------------------------------------
// orderBySoonestAppointment
// ---------------------------------------------------------------------------

function candidate(id: string, hoursFromNow: number) {
  return {
    cadence: { id },
    target: { appointmentStartAt: new Date(NOW.getTime() + hoursFromNow * 3_600_000).toISOString() },
  };
}

describe("orderBySoonestAppointment", () => {
  it("puts the most imminent appointment first", () => {
    const ordered = orderBySoonestAppointment([candidate("c-late", 40), candidate("c-soon", 2), candidate("c-mid", 20)]);
    expect(ordered.map((c) => c.cadence.id)).toEqual(["c-soon", "c-mid", "c-late"]);
  });

  it("breaks ties on cadence id so the order is total", () => {
    // listDueCadences has no ORDER BY. Without a tie-break, two runs over the same
    // backlog could slice it differently and a cadence could be deferred by chance
    // for ever.
    const same = [candidate("c-c", 5), candidate("c-a", 5), candidate("c-b", 5)];
    expect(orderBySoonestAppointment(same).map((c) => c.cadence.id)).toEqual(["c-a", "c-b", "c-c"]);
    expect(orderBySoonestAppointment([...same].reverse()).map((c) => c.cadence.id)).toEqual(["c-a", "c-b", "c-c"]);
  });

  it("sorts an unreadable appointment time LAST, never first", () => {
    const junk = { cadence: { id: "c-junk" }, target: { appointmentStartAt: "nonsense" } };
    const ordered = orderBySoonestAppointment([junk, candidate("c-real", 3)]);
    expect(ordered.map((c) => c.cadence.id)).toEqual(["c-real", "c-junk"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [candidate("c-late", 40), candidate("c-soon", 2)];
    orderBySoonestAppointment(input);
    expect(input.map((c) => c.cadence.id)).toEqual(["c-late", "c-soon"]);
  });
});

// ---------------------------------------------------------------------------
// applySendCap
// ---------------------------------------------------------------------------

describe("applySendCap", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i);

  it("sends the cap and defers the rest, losing nobody", () => {
    const { send, deferred } = applySendCap(hundred, 25);
    expect(send).toHaveLength(25);
    expect(deferred).toHaveLength(75);
    expect([...send, ...deferred]).toEqual(hundred);
  });

  it("takes the FRONT of the order, which is the most imminent", () => {
    expect(applySendCap(hundred, 3).send).toEqual([0, 1, 2]);
  });

  it("sends everything when the backlog is under the cap", () => {
    const { send, deferred } = applySendCap([1, 2, 3], 25);
    expect(send).toEqual([1, 2, 3]);
    expect(deferred).toEqual([]);
  });

  it.each([
    [0, "paused"],
    [-1, "negative"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "infinite"],
  ])("sends nothing for a cap of %s (%s) — the cap fails closed", (cap) => {
    const { send, deferred } = applySendCap(hundred, cap);
    expect(send).toEqual([]);
    expect(deferred).toHaveLength(100);
  });

  it("floors a fractional cap", () => {
    expect(applySendCap(hundred, 2.9).send).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// THE COMMENT ON THE CAP IS A CALIBRATION CONTRACT, SO IT IS TESTED LIKE ONE
// ---------------------------------------------------------------------------

describe("the ramp's stated daily ceiling is derived from the scheduler's real cadence", () => {
  /*
   * WHY A COMMENT GETS A TEST HERE, of all places. NOSHOW_DEFAULT_MAX_SENDS_PER_RUN
   * is a number whose only justification is arithmetic against how often the sweep
   * runs, and the comment above it carried that arithmetic against the WRONG
   * cadence for a whole wave: it said "hourly, so this is ~600 confirmations a
   * day" while `app-sweep-noshow` has been registered at a ten-minute step, which
   * makes the true ceiling 3,600. Nothing went red, because nothing checked — and
   * the next lane to ask "is 25 too tight?" would have reasoned from a figure six
   * times too small.
   *
   * Both halves are RECOMPUTED here, from SCHEDULER (cron.job's truth, ruling
   * W3/31) and from the constant itself, so this test cannot drift with the
   * comment: change the job's minute in the scheduler and the sentence in ramp.ts
   * is wrong on the next run.
   */
  const SOURCE = readFileSync(srcPath("lib/noshow/ramp.ts"), "utf8");

  /** Runs a day for a `STEP * * * *`-shaped cron, which is every sweep's shape. */
  function runsPerDay(schedule: string): number {
    const [minute] = schedule.split(" ");
    const step = /^\*\/(\d+)$/.exec(minute);
    if (step) return (60 / Number(step[1])) * 24;
    if (minute === "*") return 60 * 24;
    return 24; // a fixed minute past every hour
  }

  it("names the ten-minute cadence the scheduler actually holds, not an hourly one", () => {
    const job = SCHEDULER["app-sweep-noshow"];
    expect(job, "the no-show sweep is not in the scheduler at all").toBeTruthy();
    expect(job.schedule).toBe("*/10 * * * *");
    expect(SOURCE, "the cap's comment no longer names the cadence it is calibrated against").toMatch(
      /TEN-MINUTE/,
    );
    // The old claim survives ONLY as a quotation of what it used to say, which
    // is why this counts occurrences rather than forbidding the words: the
    // correction is worth more to the next reader than the erasure.
    const hourly = SOURCE.split("sweep runs hourly").length - 1;
    expect(hourly, "the file states an hourly cadence somewhere other than the record of the error").toBe(1);
    expect(SOURCE).toMatch(/used to say "the sweep runs hourly/);
  });

  it("states the daily ceiling the cap and that cadence actually produce", () => {
    const ceiling = NOSHOW_DEFAULT_MAX_SENDS_PER_RUN * runsPerDay(SCHEDULER["app-sweep-noshow"].schedule);
    expect(ceiling).toBe(3_600);
    // Written with a thousands separator, the way the comment reads it out.
    const stated = ceiling.toLocaleString("en-GB");
    expect(
      SOURCE.includes(stated),
      `the cap's comment does not state its real daily ceiling of ${stated}`,
    ).toBe(true);
  });
});
