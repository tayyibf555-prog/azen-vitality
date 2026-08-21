import { describe, it, expect } from "vitest";

// ===========================================================================
// DEDUPE: the property is "the same condition does not ping daily".
//
// That property has four moving parts and this file pins each of them,
// separately, because three of the four are silent when they work:
//
//   REFRESH   a persistent condition is updated in place, never re-raised. This
//             is what turns a fortnight-long takings dip into one row rather
//             than fourteen.
//   HOLD      a condition that resolved a moment ago is NOT re-raised, so a
//             queue that crosses the line each evening and clears each morning
//             does not ping every morning.
//   RE-RAISE  the same condition returning weeks later IS news again.
//   UNPROVEN  a pass that could not check a condition leaves it exactly as it
//             was — it does not resolve an alert it never looked for.
//
// The last one is the honesty rule applied to CLEARING an alert, which is the
// half that is easy to forget: without it, one failed database read silently
// takes a live problem off the owner's screen, and the cooldown then holds it
// off for a day after the read recovers.
// ===========================================================================

import { decideRaise, keysToResolve, planPass, type StoredAlert } from "./dedupe";
import { RERAISE_COOLDOWN_HOURS, type Alert } from "./types";

const NOW = new Date("2026-08-21T10:00:00.000Z");
const HOUR = 3_600_000;

function alert(over: Partial<Alert> = {}): Alert {
  return {
    kind: "takings_trend",
    severity: "medium",
    dedupeKey: "takings_trend:last7",
    sentence: "Takings are down.",
    href: "payments",
    at: NOW.toISOString(),
    ...over,
  };
}

function stored(over: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: "row-1",
    kind: "takings_trend",
    severity: "medium",
    dedupeKey: "takings_trend:last7",
    sentence: "Takings are down.",
    href: "payments",
    at: NOW.toISOString(),
    firstRaisedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    resolvedAt: null,
    ...over,
  };
}

const agoIso = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

describe("decideRaise", () => {
  it("inserts when the condition has never been seen", () => {
    expect(decideRaise(null, NOW)).toBe("insert");
  });

  it("REFRESHES an open row: the daily pass does not ping again", () => {
    expect(decideRaise(stored({ resolvedAt: null }), NOW)).toBe("refresh");
    // However long it has been open.
    expect(decideRaise(stored({ resolvedAt: null, firstRaisedAt: agoIso(1000) }), NOW)).toBe("refresh");
  });

  it(`HOLDS a condition that resolved less than ${RERAISE_COOLDOWN_HOURS} hours ago`, () => {
    expect(decideRaise(stored({ resolvedAt: agoIso(1) }), NOW)).toBe("hold");
    expect(decideRaise(stored({ resolvedAt: agoIso(RERAISE_COOLDOWN_HOURS - 1) }), NOW)).toBe("hold");
  });

  it(`RE-RAISES at exactly ${RERAISE_COOLDOWN_HOURS} hours, and beyond`, () => {
    expect(decideRaise(stored({ resolvedAt: agoIso(RERAISE_COOLDOWN_HOURS) }), NOW)).toBe("reraise");
    expect(decideRaise(stored({ resolvedAt: agoIso(500) }), NOW)).toBe("reraise");
  });

  it("holds rather than re-raises when the resolved stamp is unreadable", () => {
    // The conservative direction: the failure mode of the other branch is an
    // alert the owner has already dealt with reappearing on their screen.
    expect(decideRaise(stored({ resolvedAt: "not a date" }), NOW)).toBe("hold");
  });
});

describe("keysToResolve", () => {
  it("resolves an open condition the pass looked for and did not find", () => {
    expect(keysToResolve([stored()], [], [])).toEqual(["takings_trend:last7"]);
  });

  it("leaves an open condition the pass DID find", () => {
    expect(keysToResolve([stored()], [alert()], [])).toEqual([]);
  });

  it("never touches a row that is already resolved", () => {
    expect(keysToResolve([stored({ resolvedAt: agoIso(2) })], [], [])).toEqual([]);
  });

  it("LEAVES ALONE anything the pass could not prove either way", () => {
    const open = [
      stored({ dedupeKey: "takings_trend:last7" }),
      stored({ id: "row-2", dedupeKey: "lead_sla:l1", kind: "lead_sla" }),
    ];
    // The takings read failed this pass; the lead read succeeded and found nothing.
    expect(keysToResolve(open, [], ["takings_trend:"])).toEqual(["lead_sla:l1"]);
  });

  it("matches unproven entries as PREFIXES, so one failed table is scoped to itself", () => {
    const open = [
      stored({ id: "a", dedupeKey: "outbox_stuck:recall", kind: "outbox_stuck" }),
      stored({ id: "b", dedupeKey: "outbox_stuck:reviews", kind: "outbox_stuck" }),
    ];
    expect(keysToResolve(open, [], ["outbox_stuck:recall"])).toEqual(["outbox_stuck:reviews"]);
  });
});

describe("planPass", () => {
  it("routes each raised alert to exactly one bucket", () => {
    const raised = [
      alert({ dedupeKey: "takings_trend:last7" }), // open -> refresh
      alert({ dedupeKey: "lead_sla:l1", kind: "lead_sla" }), // unseen -> insert
      alert({ dedupeKey: "lead_sla:l2", kind: "lead_sla" }), // resolved long ago -> reraise
      alert({ dedupeKey: "lead_sla:l3", kind: "lead_sla" }), // resolved just now -> hold
    ];
    const store = [
      stored({ dedupeKey: "takings_trend:last7", resolvedAt: null }),
      stored({ id: "b", dedupeKey: "lead_sla:l2", kind: "lead_sla", resolvedAt: agoIso(200) }),
      stored({ id: "c", dedupeKey: "lead_sla:l3", kind: "lead_sla", resolvedAt: agoIso(1) }),
    ];

    const plan = planPass(raised, store, [], NOW);
    expect(plan.refresh.map((a) => a.dedupeKey)).toEqual(["takings_trend:last7"]);
    expect(plan.insert.map((a) => a.dedupeKey)).toEqual(["lead_sla:l1"]);
    expect(plan.reraise.map((a) => a.dedupeKey)).toEqual(["lead_sla:l2"]);
    expect(plan.hold.map((a) => a.dedupeKey)).toEqual(["lead_sla:l3"]);
    expect(plan.resolve).toEqual([]);
  });

  it("a repeated pass over an unchanged world raises NOTHING the second time", () => {
    // The property, end to end. First pass inserts; the store then holds the row;
    // the second pass over the identical world only refreshes it.
    const raised = [alert()];
    const first = planPass(raised, [], [], NOW);
    expect(first.insert).toHaveLength(1);

    const asStored = stored({ resolvedAt: null });
    const later = new Date(NOW.getTime() + 24 * HOUR);
    const second = planPass(raised, [asStored], [], later);
    expect(second.insert).toEqual([]);
    expect(second.reraise).toEqual([]);
    expect(second.refresh).toHaveLength(1);
    expect(second.resolve).toEqual([]);
  });

  it("a condition that clears is resolved, and does not come straight back", () => {
    const store = [stored({ resolvedAt: null })];
    const cleared = planPass([], store, [], NOW);
    expect(cleared.resolve).toEqual(["takings_trend:last7"]);

    // An hour later it is true again. Held, not re-raised.
    const backAgain = planPass(
      [alert()],
      [stored({ resolvedAt: NOW.toISOString() })],
      [],
      new Date(NOW.getTime() + HOUR),
    );
    expect(backAgain.hold).toHaveLength(1);
    expect(backAgain.insert).toEqual([]);
    expect(backAgain.reraise).toEqual([]);
  });

  it("a blind pass changes nothing at all", () => {
    // Every reading unavailable: the detectors produced nothing, and every open
    // condition is unproven. Nothing raised, nothing resolved, nobody misled.
    const store = [
      stored({ dedupeKey: "takings_trend:last7" }),
      stored({ id: "b", dedupeKey: "lead_sla:l1", kind: "lead_sla" }),
    ];
    const plan = planPass([], store, ["takings_trend:", "lead_sla:"], NOW);
    expect(plan).toEqual({ insert: [], refresh: [], reraise: [], hold: [], resolve: [] });
  });
});
