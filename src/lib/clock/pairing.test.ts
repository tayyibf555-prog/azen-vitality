import { describe, it, expect } from "vitest";
import {
  MAX_SESSION_MINUTES,
  buildTodayView,
  compareToRota,
  detectAnomalies,
  durationLabel,
  minutesWorked,
  nextValidKind,
  pairEvents,
  validateClock,
} from "./pairing";
import type { ClockEvent, ClockKind, RosteredShift } from "./types";

// Every instant here is explicit and every `now` is passed in, so these tests
// mean the same thing on any day, in any zone, in BST or GMT. Nothing in the
// module under test reads the wall clock.

function ev(kind: ClockKind, occurredAt: string, over: Partial<ClockEvent> = {}): ClockEvent {
  return {
    clientId: "vitality",
    siteId: "site-cc",
    staffId: "staff-1",
    kind,
    occurredAt,
    source: "manual",
    ...over,
  };
}

function shift(over: Partial<RosteredShift> = {}): RosteredShift {
  return {
    id: "shift-1",
    staffId: "staff-1",
    siteId: "site-cc",
    shiftDate: "2026-08-03",
    startTime: "09:00",
    endTime: "17:00",
    status: "scheduled",
    ...over,
  };
}

const EVENING = new Date("2026-08-03T18:00:00Z");

describe("pairEvents", () => {
  it("pairs a clean in/out into one session with the minutes worked", () => {
    const sessions = pairEvents(
      [ev("in", "2026-08-03T08:00:00Z"), ev("out", "2026-08-03T16:30:00Z")],
      EVENING,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].inAt).toBe("2026-08-03T08:00:00Z");
    expect(sessions[0].outAt).toBe("2026-08-03T16:30:00Z");
    expect(sessions[0].minutes).toBe(510);
    expect(sessions[0].open).toBe(false);
    expect(sessions[0].anomaly).toBeNull();
  });

  it("keeps a superseded clock-in as a never-clocked-out session rather than dropping it", () => {
    const first = ev("in", "2026-08-03T08:00:00Z", { id: "e1" });
    const second = ev("in", "2026-08-03T13:00:00Z", { id: "e2" });

    // The second clock-in is refused at the door...
    const refusal = validateClock([first], "in", new Date("2026-08-03T13:00:00Z"), EVENING);
    expect(refusal).toEqual({ ok: false, reason: "Already clocked in. Clock out first." });

    // ...and if one ever lands anyway, the earlier session survives, marked.
    const sessions = pairEvents([first, second], EVENING);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].inAt).toBe("2026-08-03T08:00:00Z");
    expect(sessions[0].anomaly).toBe("never-clocked-out");
    expect(sessions[0].outAt).toBeNull();
    expect(sessions[0].minutes).toBeNull();
    expect(sessions[0].open).toBe(false);
    expect(sessions[1].open).toBe(true);
  });

  it("leaves an open session with outAt null and minutes null, never 0", () => {
    const sessions = pairEvents([ev("in", "2026-08-03T08:00:00Z")], EVENING);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].open).toBe(true);
    expect(sessions[0].outAt).toBeNull();
    expect(sessions[0].minutes).toBeNull();
    // Stated separately because 0 is the failure this pins: it is a claim that
    // they worked no time, and absent is not zero.
    expect(sessions[0].minutes).not.toBe(0);
  });

  it("sorts events supplied out of order before pairing them", () => {
    const sessions = pairEvents(
      [ev("out", "2026-08-03T16:30:00Z"), ev("in", "2026-08-03T08:00:00Z")],
      EVENING,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].inAt).toBe("2026-08-03T08:00:00Z");
    expect(sessions[0].outAt).toBe("2026-08-03T16:30:00Z");
    expect(sessions[0].minutes).toBe(510);
  });

  it("computes minutes correctly across midnight", () => {
    // 23:00 to 02:30 London (BST), so the London calendar day changes mid-session.
    const sessions = pairEvents(
      [ev("in", "2026-08-03T22:00:00Z"), ev("out", "2026-08-04T01:30:00Z")],
      new Date("2026-08-04T06:00:00Z"),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].minutes).toBe(210);
    expect(sessions[0].anomaly).toBeNull();
  });

  it("flags a session longer than the maximum without truncating it", () => {
    // 18 hours: over the limit, and the recorded length must survive intact.
    const sessions = pairEvents(
      [ev("in", "2026-08-03T06:00:00Z"), ev("out", "2026-08-04T00:00:00Z")],
      new Date("2026-08-04T06:00:00Z"),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0].minutes).toBe(1080);
    expect(sessions[0].minutes).toBeGreaterThan(MAX_SESSION_MINUTES);
    expect(sessions[0].anomaly).toBe("over-max-length");
  });

  it("yields no sessions for an empty event list", () => {
    expect(pairEvents([], EVENING)).toEqual([]);
    expect(nextValidKind([])).toBe("in");
  });

  it("takes `now` as a parameter: the same open session is fine early and flagged late", () => {
    const events = [ev("in", "2026-08-03T08:00:00Z")];

    const soon = pairEvents(events, new Date("2026-08-03T16:00:00Z"));
    expect(soon[0].anomaly).toBeNull();

    const muchLater = pairEvents(events, new Date("2026-08-04T08:00:00Z"));
    expect(muchLater[0].anomaly).toBe("over-max-length");
    expect(muchLater[0].minutes).toBeNull();
  });

  it("never crosses one person's clock-out into another person's session", () => {
    const sessions = pairEvents(
      [
        ev("in", "2026-08-03T08:00:00Z", { staffId: "staff-1" }),
        ev("in", "2026-08-03T08:30:00Z", { staffId: "staff-2" }),
        ev("out", "2026-08-03T12:00:00Z", { staffId: "staff-2" }),
      ],
      EVENING,
    );

    expect(sessions).toHaveLength(2);
    const one = sessions.find((s) => s.staffId === "staff-1");
    const two = sessions.find((s) => s.staffId === "staff-2");
    expect(one?.open).toBe(true);
    expect(one?.minutes).toBeNull();
    expect(one?.anomaly).toBeNull();
    expect(two?.open).toBe(false);
    expect(two?.minutes).toBe(210);
  });
});

describe("nextValidKind", () => {
  it("asks for a clock-out while a session is open, and a clock-in once it closes", () => {
    expect(nextValidKind([ev("in", "2026-08-03T08:00:00Z")])).toBe("out");
    expect(
      nextValidKind([ev("in", "2026-08-03T08:00:00Z"), ev("out", "2026-08-03T16:00:00Z")]),
    ).toBe("in");
  });
});

describe("validateClock", () => {
  it("refuses a clock-out when there is no open clock-in", () => {
    const result = validateClock([], "out", new Date("2026-08-03T16:00:00Z"), EVENING);
    expect(result).toEqual({
      ok: false,
      reason: "Not clocked in, so there is nothing to clock out of.",
    });
  });

  it("refuses a timestamp in the future", () => {
    const now = new Date("2026-08-03T09:00:00Z");
    const result = validateClock([], "in", new Date("2026-08-03T09:01:00Z"), now);
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: "A clock event cannot be in the future." });
  });

  it("accepts the tap the state machine is asking for", () => {
    expect(validateClock([], "in", new Date("2026-08-03T09:00:00Z"), EVENING)).toEqual({ ok: true });
    expect(
      validateClock(
        [ev("in", "2026-08-03T08:00:00Z")],
        "out",
        new Date("2026-08-03T16:00:00Z"),
        EVENING,
      ),
    ).toEqual({ ok: true });
  });
});

describe("compareToRota", () => {
  it("flags a clock-in with no rostered shift, and a shift with no clock-in", () => {
    const sessions = pairEvents(
      [
        ev("in", "2026-08-03T08:00:00Z", { staffId: "staff-1" }),
        ev("out", "2026-08-03T16:00:00Z", { staffId: "staff-1" }),
      ],
      EVENING,
    );
    const shifts = [shift({ id: "shift-2", staffId: "staff-2" })];

    const result = compareToRota(sessions, shifts);

    expect(result.unrostered).toHaveLength(1);
    expect(result.unrostered[0].staffId).toBe("staff-1");
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0].staffId).toBe("staff-2");
  });

  it("treats a matching shift as rostered and not missed", () => {
    const sessions = pairEvents([ev("in", "2026-08-03T08:00:00Z")], EVENING);
    const result = compareToRota(sessions, [shift()]);

    expect(result.unrostered).toEqual([]);
    expect(result.missed).toEqual([]);
  });

  it("ignores cancelled shifts on both sides", () => {
    const sessions = pairEvents([ev("in", "2026-08-03T08:00:00Z")], EVENING);
    const result = compareToRota(sessions, [shift({ status: "cancelled" })]);

    // A cancelled shift rosters nobody, so the session is unexplained...
    expect(result.unrostered).toHaveLength(1);
    // ...and the cancelled shift itself is not a miss.
    expect(result.missed).toEqual([]);
  });
});

describe("detectAnomalies", () => {
  it("does not call a shift missed before it has started, and does once it has", () => {
    const rostered = [shift({ startTime: "14:00", endTime: "18:00" })];

    const morning = detectAnomalies([], rostered, new Date("2026-08-03T08:00:00Z"));
    expect(morning.map((n) => n.kind)).not.toContain("missing-clock-in");

    const afternoon = detectAnomalies([], rostered, new Date("2026-08-03T16:00:00Z"));
    const missing = afternoon.find((n) => n.kind === "missing-clock-in");
    expect(missing?.staffId).toBe("staff-1");
    expect(missing?.label).toBe("Rostered 14:00 to 18:00 but has not clocked in.");
  });

  it("raises an early start only when it is well before the rostered time", () => {
    // 09:00 London on 3 Aug 2026 is 08:00Z (BST).
    const onTime = pairEvents([ev("in", "2026-08-03T07:45:00Z")], EVENING);
    expect(detectAnomalies(onTime, [shift()], EVENING).map((n) => n.kind)).not.toContain(
      "early-start",
    );

    const veryEarly = pairEvents([ev("in", "2026-08-03T06:30:00Z")], EVENING);
    const note = detectAnomalies(veryEarly, [shift()], EVENING).find(
      (n) => n.kind === "early-start",
    );
    expect(note?.label).toBe("Clocked in at 07:30, 1h 30m before the 09:00 shift.");
  });

  it("words a never-clocked-out session for the manager", () => {
    const sessions = pairEvents(
      [ev("in", "2026-08-03T07:00:00Z", { id: "a" }), ev("in", "2026-08-03T13:00:00Z", { id: "b" })],
      EVENING,
    );
    const note = detectAnomalies(sessions, [shift()], EVENING).find(
      (n) => n.kind === "never-clocked-out",
    );

    expect(note?.label).toBe("Clocked in at 08:00 but never clocked out.");
  });
});

describe("minutesWorked", () => {
  it("counts closed sessions only, so an open one adds nothing", () => {
    const sessions = pairEvents(
      [
        ev("in", "2026-08-03T08:00:00Z"),
        ev("out", "2026-08-03T12:00:00Z"),
        ev("in", "2026-08-03T13:00:00Z"),
      ],
      EVENING,
    );

    expect(sessions).toHaveLength(2);
    expect(minutesWorked(sessions)).toBe(240);
  });
});

describe("durationLabel", () => {
  it("reads as hours and minutes", () => {
    expect(durationLabel(0)).toBe("0m");
    expect(durationLabel(45)).toBe("45m");
    expect(durationLabel(60)).toBe("1h");
    expect(durationLabel(510)).toBe("8h 30m");
  });
});

describe("buildTodayView", () => {
  const staff = [
    { id: "staff-1", name: "Amelia Clarke", role: "dentist", siteId: "site-cc" },
    { id: "staff-2", name: "Oliver Grant", role: "nurse", siteId: "site-cc" },
    { id: "staff-3", name: "Isla Morgan", role: "nurse", siteId: "site-cc" },
    { id: "staff-4", name: "Ethan Brooks", role: "reception", siteId: "site-cc" },
  ];

  it("puts every staff member in exactly one state and counts them", () => {
    const view = buildTodayView({
      staff,
      events: [
        // In now.
        ev("in", "2026-08-03T08:00:00Z", { staffId: "staff-1" }),
        // Worked and left.
        ev("in", "2026-08-03T08:00:00Z", { staffId: "staff-2" }),
        ev("out", "2026-08-03T12:00:00Z", { staffId: "staff-2" }),
      ],
      // Rostered but not clocked in: expected. staff-4 has neither: off.
      shifts: [shift({ id: "s3", staffId: "staff-3", startTime: "14:00", endTime: "18:00" })],
      now: new Date("2026-08-03T12:30:00Z"),
    });

    expect(view.dayKey).toBe("2026-08-03");
    expect(view.rows.map((r) => r.state)).toEqual(["in", "out", "expected", "off"]);
    expect(view.inNow).toBe(1);
    expect(view.clockedOut).toBe(1);
    expect(view.expected).toBe(1);
    // The action offered to each person is decided here, not in the component:
    // only the person who is IN is offered a clock-out.
    expect(view.rows.map((r) => r.nextKind)).toEqual(["out", "in", "in", "in"]);
  });

  it("reports null minutes while somebody is still in, and elapsed time instead", () => {
    const view = buildTodayView({
      staff: [staff[0]],
      events: [ev("in", "2026-08-03T08:00:00Z", { staffId: "staff-1" })],
      shifts: [shift()],
      now: new Date("2026-08-03T10:15:00Z"),
    });

    const row = view.rows[0];
    expect(row.state).toBe("in");
    expect(row.minutes).toBeNull();
    expect(row.minutes).not.toBe(0);
    expect(row.openMinutes).toBe(135);
    expect(row.since).toBe("2026-08-03T08:00:00Z");
  });

  it("only counts a day's own shifts and hands each row its own exceptions", () => {
    const view = buildTodayView({
      staff: [staff[0], staff[1]],
      events: [ev("in", "2026-08-03T08:00:00Z", { staffId: "staff-1" })],
      shifts: [
        // Yesterday's shift must not make anyone "expected" today.
        shift({ id: "old", staffId: "staff-2", shiftDate: "2026-08-02" }),
      ],
      now: new Date("2026-08-03T12:00:00Z"),
    });

    expect(view.rows[1].state).toBe("off");
    expect(view.rows[1].shifts).toEqual([]);
    // staff-1 clocked in with nothing on the rota today.
    expect(view.rows[0].notes.map((n) => n.kind)).toEqual(["no-rostered-shift"]);
    expect(view.notes).toHaveLength(1);
  });
});
