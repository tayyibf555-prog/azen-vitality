import { describe, it, expect } from "vitest";
import {
  APPROVER_ROLES,
  MAX_ABSENCE_SPAN_DAYS,
  SELF_REQUEST_ROLES,
  absenceBlocksShift,
  addDayKey,
  canCancel,
  canDecide,
  canRequest,
  decorateAbsences,
  findOverlapping,
  groupAbsencesByStaff,
  inclusiveDays,
  isAbsenceKind,
  isDayKey,
  overlaps,
  partitionAbsences,
  summariseAbsences,
  validateRequest,
  weekdayOfDayKey,
  workingDaysInRange,
} from "./rules";
import type { Absence, AbsenceRequestInput } from "./types";
import type { Availability } from "@/lib/rota/types";

// The week of Mon 6 Jul 2026 .. Sun 12 Jul 2026 (the same anchor week the rota
// generator's tests use, so the two modules' fixtures line up).
//   Mon 06, Tue 07, Wed 08, Thu 09, Fri 10, Sat 11, Sun 12, Mon 13.
const MON = "2026-07-06";
const WED = "2026-07-08";
const THU = "2026-07-09";
const FRI = "2026-07-10";
const SAT = "2026-07-11";
const SUN = "2026-07-12";
const NEXT_MON = "2026-07-13";

/** 09:00 London on Wed 8 Jul 2026. Every clock-dependent rule is judged against this. */
const NOW = new Date("2026-07-08T08:00:00Z");

function abs(over: Partial<Absence> & Pick<Absence, "id">): Absence {
  return {
    clientId: "vitality",
    siteId: null,
    staffId: "staff-1",
    kind: "holiday",
    startDate: MON,
    endDate: FRI,
    status: "pending",
    note: null,
    requestedBy: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...over,
  };
}

function request(over: Partial<AbsenceRequestInput> = {}): AbsenceRequestInput {
  return { staffId: "staff-1", kind: "holiday", startDate: THU, endDate: FRI, ...over };
}

// ---------------------------------------------------------------------------
// 1. Inclusive date-range overlap.
// ---------------------------------------------------------------------------

describe("overlaps", () => {
  it("identical ranges overlap", () => {
    expect(overlaps({ startDate: MON, endDate: FRI }, { startDate: MON, endDate: FRI })).toBe(true);
  });

  it("adjacent ranges do NOT overlap (one ends the day before the other starts)", () => {
    // Mon..Wed then Thu..Fri: back to back, no shared day.
    expect(overlaps({ startDate: MON, endDate: WED }, { startDate: THU, endDate: FRI })).toBe(false);
    expect(overlaps({ startDate: THU, endDate: FRI }, { startDate: MON, endDate: WED })).toBe(false);
  });

  it("ranges that share exactly one boundary day DO overlap", () => {
    // Mon..Wed and Wed..Fri clash, on the Wednesday. This is the inclusive rule that
    // an exclusive-end implementation would get wrong.
    expect(overlaps({ startDate: MON, endDate: WED }, { startDate: WED, endDate: FRI })).toBe(true);
  });

  it("a single day overlaps itself", () => {
    expect(overlaps({ startDate: WED, endDate: WED }, { startDate: WED, endDate: WED })).toBe(true);
  });

  it("a range fully containing another overlaps, in both argument orders", () => {
    const outer = { startDate: MON, endDate: SUN };
    const inner = { startDate: WED, endDate: THU };
    expect(overlaps(outer, inner)).toBe(true);
    expect(overlaps(inner, outer)).toBe(true);
  });

  it("disjoint ranges do not overlap", () => {
    expect(overlaps({ startDate: MON, endDate: WED }, { startDate: SAT, endDate: SUN })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Which statuses block, and which never may.
// ---------------------------------------------------------------------------

describe("findOverlapping status filter", () => {
  const candidate = abs({ id: "new", startDate: WED, endDate: THU });

  it("a PENDING request over the same days blocks", () => {
    const existing = [abs({ id: "p1", status: "pending", startDate: MON, endDate: FRI })];
    expect(findOverlapping(existing, candidate).map((a) => a.id)).toEqual(["p1"]);
  });

  it("an APPROVED absence over the same days blocks", () => {
    const existing = [abs({ id: "a1", status: "approved", startDate: MON, endDate: FRI })];
    expect(findOverlapping(existing, candidate).map((a) => a.id)).toEqual(["a1"]);
  });

  it("a REFUSED request never blocks", () => {
    const existing = [abs({ id: "r1", status: "refused", startDate: MON, endDate: FRI })];
    expect(findOverlapping(existing, candidate)).toEqual([]);
  });

  it("a CANCELLED request never blocks", () => {
    const existing = [abs({ id: "c1", status: "cancelled", startDate: MON, endDate: FRI })];
    expect(findOverlapping(existing, candidate)).toEqual([]);
  });

  it("returns only the blocking rows when blocking and non-blocking rows are mixed", () => {
    const existing = [
      abs({ id: "r1", status: "refused", startDate: MON, endDate: FRI }),
      abs({ id: "p1", status: "pending", startDate: MON, endDate: FRI }),
      abs({ id: "c1", status: "cancelled", startDate: MON, endDate: FRI }),
      abs({ id: "a1", status: "approved", startDate: THU, endDate: SAT }),
    ];
    expect(findOverlapping(existing, candidate).map((a) => a.id)).toEqual(["p1", "a1"]);
  });

  it("never reports the candidate as clashing with itself", () => {
    const self = abs({ id: "same", status: "approved", startDate: WED, endDate: THU });
    expect(findOverlapping([self], self)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Another person's holiday is not this person's problem.
// ---------------------------------------------------------------------------

describe("findOverlapping staff scope", () => {
  it("a different staff member's overlapping holiday does not block", () => {
    const existing = [
      abs({ id: "other", staffId: "staff-2", status: "approved", startDate: MON, endDate: FRI }),
    ];
    const candidate = abs({ id: "new", staffId: "staff-1", startDate: WED, endDate: THU });
    expect(findOverlapping(existing, candidate)).toEqual([]);
  });

  it("the same staff member's overlapping holiday does block", () => {
    const existing = [
      abs({ id: "mine", staffId: "staff-1", status: "approved", startDate: MON, endDate: FRI }),
    ];
    const candidate = abs({ id: "new", staffId: "staff-1", startDate: WED, endDate: THU });
    expect(findOverlapping(existing, candidate).map((a) => a.id)).toEqual(["mine"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Who may decide, and the self-approval refusal.
// ---------------------------------------------------------------------------

describe("canDecide", () => {
  const pending = abs({ id: "p", status: "pending", requestedBy: "user-clinician" });

  it("is false for a clinician, who requests but never decides", () => {
    expect(canDecide("client_clinician", pending, "user-clinician")).toBe(false);
    expect(canDecide("client_clinician", pending, "user-someone-else")).toBe(false);
  });

  it("is false when an owner tries to approve their OWN request", () => {
    const own = abs({ id: "own", status: "pending", requestedBy: "user-owner" });
    expect(canDecide("client_owner", own, "user-owner")).toBe(false);
  });

  it("is false when a coordinator tries to approve their OWN request", () => {
    const own = abs({ id: "own", status: "pending", requestedBy: "user-manager" });
    expect(canDecide("client_coordinator", own, "user-manager")).toBe(false);
  });

  it("is true for an owner, a coordinator and the agency admin on someone else's request", () => {
    expect(canDecide("client_owner", pending, "user-owner")).toBe(true);
    expect(canDecide("client_coordinator", pending, "user-manager")).toBe(true);
    expect(canDecide("agency_admin", pending, "user-agency")).toBe(true);
  });

  it("is false once the request is no longer pending", () => {
    for (const status of ["approved", "refused", "cancelled"] as const) {
      expect(canDecide("client_owner", abs({ id: "x", status }), "user-owner")).toBe(false);
    }
  });

  it("with auth enforcement off (role null) the role axis passes but self-approval is still refused", () => {
    expect(canDecide(null, pending, "user-owner")).toBe(true);
    expect(canDecide(null, pending, "user-clinician")).toBe(false);
  });

  it("APPROVER_ROLES is exactly the three deciding roles (the clinician is not one)", () => {
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
  });
});

describe("canRequest", () => {
  it("lets an approver record absence for anybody", () => {
    expect(canRequest("client_owner", "staff-9", null)).toBe(true);
    expect(canRequest("client_coordinator", "staff-9", "staff-1")).toBe(true);
    expect(canRequest("agency_admin", "staff-9", null)).toBe(true);
  });

  it("lets a clinician request only their own absence", () => {
    expect(canRequest("client_clinician", "staff-1", "staff-1")).toBe(true);
    expect(canRequest("client_clinician", "staff-2", "staff-1")).toBe(false);
  });

  it("refuses a clinician with no resolved staff record", () => {
    expect(canRequest("client_clinician", "staff-1", null)).toBe(false);
  });

  it("lets a member of staff request only their own absence", () => {
    // The fifth role, added with the self-service surface. Same shape as the
    // clinician: their own, from their own session, and nobody else's.
    expect(canRequest("client_staff", "staff-1", "staff-1")).toBe(true);
    expect(canRequest("client_staff", "staff-2", "staff-1")).toBe(false);
  });

  it("refuses a member of staff with no resolved staff record", () => {
    expect(canRequest("client_staff", "staff-1", null)).toBe(false);
  });

  it("SELF_REQUEST_ROLES is exactly the two non-approver roles, and none of them approves", () => {
    // A named list, so widening it is a decision rather than an edit inside an
    // if-statement. Neither role may ever also decide.
    expect([...SELF_REQUEST_ROLES]).toEqual(["client_clinician", "client_staff"]);
    for (const role of SELF_REQUEST_ROLES) {
      expect(APPROVER_ROLES).not.toContain(role);
    }
  });

  it("refuses an empty target staff id whatever the role", () => {
    expect(canRequest("client_owner", "", null)).toBe(false);
    expect(canRequest(null, "", null)).toBe(false);
    expect(canRequest("client_staff", "", "staff-1")).toBe(false);
  });
});

describe("canCancel", () => {
  it("lets an approver withdraw a pending or an approved absence", () => {
    expect(canCancel("client_coordinator", abs({ id: "p", status: "pending" }), "user-x")).toBe(true);
    expect(canCancel("client_owner", abs({ id: "a", status: "approved" }), "user-x")).toBe(true);
  });

  it("lets the requester withdraw their own request", () => {
    const mine = abs({ id: "m", status: "pending", requestedBy: "user-clinician" });
    expect(canCancel("client_clinician", mine, "user-clinician")).toBe(true);
  });

  it("does not let a clinician withdraw somebody else's request", () => {
    const theirs = abs({ id: "t", status: "pending", requestedBy: "user-other" });
    expect(canCancel("client_clinician", theirs, "user-clinician")).toBe(false);
  });

  it("refuses to cancel an already closed row", () => {
    expect(canCancel("client_owner", abs({ id: "r", status: "refused" }), "user-x")).toBe(false);
    expect(canCancel("client_owner", abs({ id: "c", status: "cancelled" }), "user-x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Request validation, judged against a passed-in `now`.
// ---------------------------------------------------------------------------

describe("validateRequest", () => {
  it("accepts a well-formed future request", () => {
    expect(validateRequest(request({ startDate: THU, endDate: FRI }), NOW)).toEqual({ ok: true });
  });

  it("refuses an end date before the start date", () => {
    const result = validateRequest(request({ startDate: FRI, endDate: THU }), NOW);
    expect(result).toEqual({ ok: false, reason: "The end date cannot be before the start date." });
  });

  it("refuses a range that is wholly in the past", () => {
    const result = validateRequest(request({ startDate: "2026-06-29", endDate: "2026-07-03" }), NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(
      "That absence has already finished, so there is nothing to approve.",
    );
  });

  it("accepts a range that started before today but has not finished (sickness reported late)", () => {
    expect(validateRequest(request({ startDate: MON, endDate: FRI }), NOW)).toEqual({ ok: true });
  });

  it("accepts a range that ends today", () => {
    expect(validateRequest(request({ startDate: MON, endDate: WED }), NOW)).toEqual({ ok: true });
  });

  it("uses the LONDON day of `now`, not the UTC day", () => {
    // 23:30 UTC on 8 Jul is 00:30 on 9 Jul in British Summer Time, so an absence
    // ending on the 8th has finished.
    const justAfterLondonMidnight = new Date("2026-07-08T23:30:00Z");
    const result = validateRequest(
      request({ startDate: MON, endDate: WED }),
      justAfterLondonMidnight,
    );
    expect(result.ok).toBe(false);
  });

  it(`refuses a span longer than ${MAX_ABSENCE_SPAN_DAYS} days`, () => {
    const tooLong = request({ startDate: THU, endDate: addDayKey(THU, MAX_ABSENCE_SPAN_DAYS) });
    expect(inclusiveDays(tooLong.startDate, tooLong.endDate)).toBe(MAX_ABSENCE_SPAN_DAYS + 1);
    const result = validateRequest(tooLong, NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(`longer than ${MAX_ABSENCE_SPAN_DAYS} days`);
  });

  it(`accepts a span of exactly ${MAX_ABSENCE_SPAN_DAYS} days`, () => {
    const atLimit = request({ startDate: THU, endDate: addDayKey(THU, MAX_ABSENCE_SPAN_DAYS - 1) });
    expect(inclusiveDays(atLimit.startDate, atLimit.endDate)).toBe(MAX_ABSENCE_SPAN_DAYS);
    expect(validateRequest(atLimit, NOW)).toEqual({ ok: true });
  });

  it("refuses a missing staff member, an unknown kind and a malformed date", () => {
    expect(validateRequest(request({ staffId: "" }), NOW)).toEqual({
      ok: false,
      reason: "Choose who the absence is for.",
    });
    expect(
      validateRequest({ ...request(), kind: "sabbatical" as AbsenceRequestInput["kind"] }, NOW),
    ).toEqual({ ok: false, reason: "Choose a type of absence." });
    expect(validateRequest(request({ startDate: "09/07/2026" }), NOW)).toEqual({
      ok: false,
      reason: "Enter a valid start and end date.",
    });
  });

  it("refuses a well-shaped but impossible calendar date", () => {
    // Date.parse would roll 30 Feb forward into March and store a different day.
    expect(validateRequest(request({ startDate: "2027-02-30", endDate: "2027-03-02" }), NOW)).toEqual({
      ok: false,
      reason: "Enter a valid start and end date.",
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Working days, from the rota availability map.
// ---------------------------------------------------------------------------

describe("workingDaysInRange", () => {
  const monToFri: Availability = {
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: false,
    sunday: false,
  };

  it("skips the days the staff member is not available", () => {
    // Thu 9 .. Mon 13 is five calendar days: Thu, Fri, Sat, Sun, Mon.
    expect(inclusiveDays(THU, NEXT_MON)).toBe(5);
    // Only Thu, Fri and Mon are working days for a Monday-to-Friday person.
    expect(workingDaysInRange(THU, NEXT_MON, monToFri)).toBe(3);
  });

  it("counts a Saturday for someone who works Saturdays", () => {
    const withSaturday: Availability = { ...monToFri, saturday: true };
    expect(workingDaysInRange(THU, NEXT_MON, withSaturday)).toBe(4);
  });

  it("is zero for a range made entirely of non-working days", () => {
    expect(workingDaysInRange(SAT, SUN, monToFri)).toBe(0);
  });

  it("treats a missing weekday key as not available", () => {
    expect(workingDaysInRange(MON, SUN, { monday: true })).toBe(1);
  });

  it("is zero when the range is inverted", () => {
    expect(workingDaysInRange(FRI, MON, monToFri)).toBe(0);
  });

  it("counts a single working day as one", () => {
    expect(workingDaysInRange(WED, WED, monToFri)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. The seam into the rota generator.
// ---------------------------------------------------------------------------

describe("absenceBlocksShift", () => {
  const shift = { staffId: "staff-1", shiftDate: THU };

  it("an APPROVED absence covering the shift date blocks it", () => {
    const away = [abs({ id: "a", status: "approved", startDate: WED, endDate: FRI })];
    expect(absenceBlocksShift(shift, away)).toBe(true);
  });

  it("a PENDING request does NOT block: nothing has been agreed yet", () => {
    const away = [abs({ id: "p", status: "pending", startDate: WED, endDate: FRI })];
    expect(absenceBlocksShift(shift, away)).toBe(false);
  });

  it("a refused or cancelled absence does not block", () => {
    for (const status of ["refused", "cancelled"] as const) {
      expect(absenceBlocksShift(shift, [abs({ id: "x", status, startDate: WED, endDate: FRI })])).toBe(
        false,
      );
    }
  });

  it("blocks on the first and last day of the range (inclusive bounds)", () => {
    const away = [abs({ id: "a", status: "approved", startDate: WED, endDate: FRI })];
    expect(absenceBlocksShift({ staffId: "staff-1", shiftDate: WED }, away)).toBe(true);
    expect(absenceBlocksShift({ staffId: "staff-1", shiftDate: FRI }, away)).toBe(true);
    expect(absenceBlocksShift({ staffId: "staff-1", shiftDate: SAT }, away)).toBe(false);
    expect(absenceBlocksShift({ staffId: "staff-1", shiftDate: MON }, away)).toBe(false);
  });

  it("another person's approved absence does not block this person's shift", () => {
    const away = [abs({ id: "a", staffId: "staff-2", status: "approved", startDate: WED, endDate: FRI })];
    expect(absenceBlocksShift(shift, away)).toBe(false);
  });

  it("an empty absence list never blocks", () => {
    expect(absenceBlocksShift(shift, [])).toBe(false);
  });
});

describe("groupAbsencesByStaff", () => {
  it("buckets every absence under its own staff id", () => {
    const grouped = groupAbsencesByStaff([
      abs({ id: "1", staffId: "staff-1" }),
      abs({ id: "2", staffId: "staff-2" }),
      abs({ id: "3", staffId: "staff-1" }),
    ]);
    expect([...grouped.keys()].sort()).toEqual(["staff-1", "staff-2"]);
    expect(grouped.get("staff-1")?.map((a) => a.id)).toEqual(["1", "3"]);
    expect(grouped.get("staff-2")?.map((a) => a.id)).toEqual(["2"]);
  });
});

// ---------------------------------------------------------------------------
// Day-key helpers (the arithmetic every rule above is built on).
// ---------------------------------------------------------------------------

describe("day key helpers", () => {
  it("isDayKey accepts a real day and rejects shapes that are not one", () => {
    expect(isDayKey("2026-07-06")).toBe(true);
    expect(isDayKey("2026-2-6")).toBe(false);
    expect(isDayKey("06/07/2026")).toBe(false);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-13-01")).toBe(false);
    expect(isDayKey(20260706)).toBe(false);
    expect(isDayKey(null)).toBe(false);
  });

  it("addDayKey walks across a month and a year boundary", () => {
    expect(addDayKey("2026-07-30", 3)).toBe("2026-08-02");
    expect(addDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDayKey("2026-07-06", -1)).toBe("2026-07-05");
  });

  it("addDayKey is unaffected by the British Summer Time change", () => {
    // BST ends at 02:00 on Sun 25 Oct 2026; a local-midnight implementation would
    // return the 24th twice here.
    expect(addDayKey("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDayKey("2026-10-25", 1)).toBe("2026-10-26");
  });

  it("weekdayOfDayKey names the right day", () => {
    expect(weekdayOfDayKey(MON)).toBe("monday");
    expect(weekdayOfDayKey(SAT)).toBe("saturday");
    expect(weekdayOfDayKey(SUN)).toBe("sunday");
    expect(weekdayOfDayKey("not-a-day")).toBe(null);
  });

  it("inclusiveDays counts both ends", () => {
    expect(inclusiveDays(WED, WED)).toBe(1);
    expect(inclusiveDays(MON, SUN)).toBe(7);
    expect(inclusiveDays(SUN, MON)).toBe(0);
  });

  it("isAbsenceKind accepts the five kinds and nothing else", () => {
    expect(isAbsenceKind("holiday")).toBe(true);
    expect(isAbsenceKind("sick")).toBe(true);
    expect(isAbsenceKind("training")).toBe(true);
    expect(isAbsenceKind("unpaid")).toBe(true);
    expect(isAbsenceKind("other")).toBe(true);
    expect(isAbsenceKind("sabbatical")).toBe(false);
    expect(isAbsenceKind("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the UI actually renders: every condition computed here, never in a component.
// ---------------------------------------------------------------------------

describe("decorateAbsences", () => {
  const rows = decorateAbsences(
    [
      abs({ id: "pending-mine", status: "pending", requestedBy: "user-manager", startDate: SAT, endDate: SUN }),
      abs({ id: "pending-theirs", status: "pending", requestedBy: "user-clinician", startDate: SAT, endDate: SUN }),
      abs({ id: "current", status: "approved", startDate: MON, endDate: FRI, staffId: "staff-2" }),
      abs({ id: "finished", status: "approved", startDate: "2026-06-29", endDate: "2026-07-03", staffId: "staff-3" }),
    ],
    { role: "client_coordinator", userId: "user-manager" },
    NOW,
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  it("computes canDecide per row, refusing the manager's own request", () => {
    expect(byId["pending-mine"].canDecide).toBe(false);
    expect(byId["pending-theirs"].canDecide).toBe(true);
    expect(byId["current"].canDecide).toBe(false); // already approved
  });

  it("computes the inclusive day span", () => {
    expect(byId["current"].days).toBe(5);
    expect(byId["pending-mine"].days).toBe(2);
  });

  it("marks a finished absence past, and a running one current", () => {
    expect(byId["finished"].past).toBe(true);
    expect(byId["finished"].current).toBe(false);
    expect(byId["current"].past).toBe(false);
    expect(byId["current"].current).toBe(true);
    expect(byId["pending-mine"].past).toBe(false);
    expect(byId["pending-mine"].current).toBe(false);
  });

  it("lists the clashing rows for the same person only", () => {
    // The two Sat..Sun requests are both staff-1 and both pending: each sees the other.
    expect(byId["pending-mine"].overlapIds).toEqual(["pending-theirs"]);
    expect(byId["pending-theirs"].overlapIds).toEqual(["pending-mine"]);
    // staff-2's absence overlaps nobody else's.
    expect(byId["current"].overlapIds).toEqual([]);
  });
});

describe("summariseAbsences", () => {
  it("counts pending, upcoming approved and away-today", () => {
    const rows = decorateAbsences(
      [
        abs({ id: "p1", status: "pending", startDate: SAT, endDate: SUN }),
        abs({ id: "p2", status: "pending", staffId: "staff-9", startDate: SAT, endDate: SUN }),
        abs({ id: "a-now", status: "approved", staffId: "staff-2", startDate: MON, endDate: FRI }),
        abs({ id: "a-later", status: "approved", staffId: "staff-3", startDate: NEXT_MON, endDate: NEXT_MON }),
        abs({ id: "a-done", status: "approved", staffId: "staff-4", startDate: "2026-06-29", endDate: "2026-07-03" }),
        abs({ id: "refused", status: "refused", staffId: "staff-5", startDate: SAT, endDate: SUN }),
      ],
      { role: "client_owner", userId: "user-owner" },
      NOW,
    );
    expect(summariseAbsences(rows)).toEqual({
      pending: 2,
      upcoming: 2, // a-now and a-later; a-done has finished
      awayToday: 1, // only a-now covers Wed 8 Jul
      total: 6,
    });
  });

  it("is all zeros for an empty list", () => {
    expect(summariseAbsences([])).toEqual({ pending: 0, upcoming: 0, awayToday: 0, total: 0 });
  });
});

describe("partitionAbsences", () => {
  const rows = decorateAbsences(
    [
      abs({ id: "pending-later", status: "pending", startDate: NEXT_MON, endDate: NEXT_MON }),
      abs({ id: "pending-sooner", status: "pending", staffId: "s2", startDate: THU, endDate: FRI }),
      abs({ id: "pending-stale", status: "pending", staffId: "s3", startDate: "2026-06-29", endDate: "2026-07-03" }),
      abs({ id: "approved-soon", status: "approved", staffId: "s4", startDate: SAT, endDate: SUN }),
      abs({ id: "approved-later", status: "approved", staffId: "s5", startDate: NEXT_MON, endDate: NEXT_MON }),
      abs({ id: "refused-old", status: "refused", staffId: "s6", startDate: "2026-06-29", endDate: "2026-07-01" }),
      abs({ id: "cancelled-older", status: "cancelled", staffId: "s7", startDate: "2026-06-20", endDate: "2026-06-22" }),
    ],
    { role: "client_owner", userId: "user-owner" },
    NOW,
  );
  const parts = partitionAbsences(rows);

  it("puts every undecided request in `awaiting`, soonest first", () => {
    expect(parts.awaiting.map((r) => r.id)).toEqual(["pending-stale", "pending-sooner", "pending-later"]);
  });

  it("keeps a pending request whose dates have passed in `awaiting`, never hidden in `past`", () => {
    // Filing an unanswered request under "past" is exactly how a holiday request goes
    // permanently unnoticed, which is the failure this module exists to prevent.
    expect(parts.awaiting.some((r) => r.id === "pending-stale")).toBe(true);
    expect(parts.past.some((r) => r.id === "pending-stale")).toBe(false);
  });

  it("puts decided-and-still-to-come rows in `upcoming`, soonest first", () => {
    expect(parts.upcoming.map((r) => r.id)).toEqual(["approved-soon", "approved-later"]);
  });

  it("puts finished rows in `past`, most recent first", () => {
    expect(parts.past.map((r) => r.id)).toEqual(["refused-old", "cancelled-older"]);
  });

  it("loses nothing: the three lists together are every row", () => {
    expect(parts.awaiting.length + parts.upcoming.length + parts.past.length).toBe(rows.length);
  });

  it("handles an empty list", () => {
    expect(partitionAbsences([])).toEqual({ awaiting: [], upcoming: [], past: [] });
  });
});
