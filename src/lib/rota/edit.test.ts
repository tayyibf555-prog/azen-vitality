import { describe, it, expect } from "vitest";
import {
  isTimeOfDay,
  notificationIsStale,
  originAfterEdit,
  pairingViolations,
  timesOverlap,
  validateShiftEdit,
  wouldDoubleBook,
  type ShiftEditInput,
} from "./edit";
import type { Absence } from "@/lib/absence/types";
import type { RotaConfig, RotaShift } from "./types";

// Wed 8 Jul 2026, midday UTC. London day = 2026-07-08.
const NOW = new Date("2026-07-08T12:00:00Z");
const TODAY = "2026-07-08";
const TOMORROW = "2026-07-09";

const CONFIG: RotaConfig = {
  rolesNeeded: { dentist: 1, nurse: 1 },
  notifyLeadDays: 7,
  generateWeeksAhead: 1,
  pairRoles: { clinical: "dentist", support: "nurse" },
};

function shift(over: Partial<RotaShift> & Pick<RotaShift, "id" | "staffId">): RotaShift {
  return {
    clientId: "vitality",
    siteId: "site-a",
    shiftDate: TOMORROW,
    startTime: "09:00",
    endTime: "17:30",
    role: "dentist",
    status: "scheduled",
    origin: "generated",
    pairedStaffId: null,
    ...over,
  } as RotaShift;
}

function edit(over: Partial<ShiftEditInput> = {}): ShiftEditInput {
  return {
    siteId: "site-a",
    staffId: "d1",
    shiftDate: TOMORROW,
    startTime: "09:00",
    endTime: "17:30",
    role: "dentist",
    ...over,
  };
}

function absence(over: Partial<Absence> & Pick<Absence, "id" | "staffId" | "startDate" | "endDate">): Absence {
  return {
    clientId: "vitality",
    siteId: null,
    kind: "holiday",
    status: "approved",
    note: null,
    requestedBy: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...over,
  };
}

/** The codes reported, so an assertion reads as a sentence rather than an index. */
function codes(result: ReturnType<typeof validateShiftEdit>): string[] {
  return result.issues.map((i) => i.code);
}

describe("isTimeOfDay", () => {
  it("accepts a zero-padded 24-hour time", () => {
    expect(isTimeOfDay("09:00")).toBe(true);
    expect(isTimeOfDay("00:00")).toBe(true);
    expect(isTimeOfDay("23:59")).toBe(true);
  });

  it("rejects the shapes a hand-typed time actually takes", () => {
    for (const bad of ["9:00", "24:00", "09:60", "0900", "09:00:00", "", null, 900]) {
      expect(isTimeOfDay(bad), `${String(bad)} should be rejected`).toBe(false);
    }
  });
});

describe("timesOverlap", () => {
  it("counts a genuine overlap", () => {
    expect(timesOverlap({ startTime: "09:00", endTime: "13:00" }, { startTime: "12:00", endTime: "17:00" })).toBe(true);
  });

  it("does NOT count touching windows, so a split shift is legal", () => {
    // A morning and an afternoon is how a half-day is recorded. Treating 13:00 as a
    // clash would make the commonest real shift pattern impossible to enter.
    expect(timesOverlap({ startTime: "09:00", endTime: "13:00" }, { startTime: "13:00", endTime: "17:30" })).toBe(false);
  });

  it("counts full containment either way round", () => {
    expect(timesOverlap({ startTime: "09:00", endTime: "17:30" }, { startTime: "11:00", endTime: "12:00" })).toBe(true);
    expect(timesOverlap({ startTime: "11:00", endTime: "12:00" }, { startTime: "09:00", endTime: "17:30" })).toBe(true);
  });
});

describe("wouldDoubleBook", () => {
  it("catches the same person overlapping themselves", () => {
    const day = [shift({ id: "s1", staffId: "d1", startTime: "09:00", endTime: "17:30" })];
    expect(wouldDoubleBook(edit({ startTime: "12:00", endTime: "16:00" }), day)).toBe(true);
  });

  it("a shift never clashes with itself, so a move can be re-validated", () => {
    const day = [shift({ id: "s1", staffId: "d1" })];
    expect(wouldDoubleBook(edit({ id: "s1" }), day)).toBe(false);
  });

  it("ignores other people entirely", () => {
    const day = [shift({ id: "s1", staffId: "d2" })];
    expect(wouldDoubleBook(edit({ staffId: "d1" }), day)).toBe(false);
  });

  it("a cancelled or removed shift never blocks its own slot being re-used", () => {
    // Otherwise deleting a shift would permanently poison the slot: the manager
    // could not put the person back where they just took them from.
    for (const status of ["cancelled", "removed"] as const) {
      const day = [shift({ id: "s1", staffId: "d1", status })];
      expect(wouldDoubleBook(edit(), day), `${status} should not block`).toBe(false);
    }
  });

  it("a split shift on the same day is not a double booking", () => {
    const day = [shift({ id: "s1", staffId: "d1", startTime: "09:00", endTime: "13:00" })];
    expect(wouldDoubleBook(edit({ startTime: "13:00", endTime: "17:30" }), day)).toBe(false);
  });
});

describe("validateShiftEdit", () => {
  it("accepts a plain, well-formed shift with nothing to say about it", () => {
    const result = validateShiftEdit(edit(), [], [], NOW);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("refuses a missing person, site or role", () => {
    expect(codes(validateShiftEdit(edit({ staffId: "" }), [], [], NOW))).toContain("missing-field");
    expect(codes(validateShiftEdit(edit({ siteId: "" }), [], [], NOW))).toContain("missing-field");
    expect(codes(validateShiftEdit(edit({ role: "" }), [], [], NOW))).toContain("missing-field");
  });

  it("refuses a date that is not a real calendar day", () => {
    // 30 February is well-shaped nonsense that Date.parse rolls into March, so a
    // shift would be stored on a different day than the one typed.
    const result = validateShiftEdit(edit({ shiftDate: "2026-02-30" }), [], [], NOW);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("bad-date");
  });

  it("refuses a finish time that is not after the start", () => {
    for (const [start, end] of [["17:30", "09:00"], ["09:00", "09:00"]]) {
      const result = validateShiftEdit(edit({ startTime: start, endTime: end }), [], [], NOW);
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("end-before-start");
    }
  });

  it("refuses a double booking, because being in two places at once is not a judgement call", () => {
    const day = [shift({ id: "s1", staffId: "d1", shiftDate: TOMORROW })];
    const result = validateShiftEdit(edit({ startTime: "10:00", endTime: "12:00" }), day, [], NOW);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("double-booked");
  });

  it("refuses pairing somebody with themselves", () => {
    const result = validateShiftEdit(edit({ pairedStaffId: "d1" }), [], [], NOW);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("paired-with-self");
  });

  it("a manual shift on an approved-absence day produces a WARNING, not a refusal", () => {
    // THE NAMED RULE. The manager knows the person is off and is asking them in
    // anyway, which happens. Refusing it pushes the arrangement onto paper, where
    // nothing is recorded at all -- the opposite of what this module is for.
    const away = [absence({ id: "a1", staffId: "d1", startDate: TOMORROW, endDate: TOMORROW })];
    const result = validateShiftEdit(edit(), [], away, NOW);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].level).toBe("warning");
    expect(result.issues[0].code).toBe("on-approved-absence");
  });

  it("a PENDING absence says nothing at all: it has not been agreed yet", () => {
    const pending = [
      absence({ id: "a1", staffId: "d1", startDate: TOMORROW, endDate: TOMORROW, status: "pending" }),
    ];
    expect(validateShiftEdit(edit(), [], pending, NOW).issues).toEqual([]);
  });

  it("somebody else's absence is not this person's problem", () => {
    const away = [absence({ id: "a1", staffId: "d2", startDate: TOMORROW, endDate: TOMORROW })];
    expect(validateShiftEdit(edit(), [], away, NOW).issues).toEqual([]);
  });

  it("a past day warns rather than refusing, so last week's rota can be corrected", () => {
    const result = validateShiftEdit(edit({ shiftDate: "2026-07-06" }), [], [], NOW);
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(["past-day"]);
  });

  it("today is not the past", () => {
    expect(validateShiftEdit(edit({ shiftDate: TODAY }), [], [], NOW).issues).toEqual([]);
  });

  it("judges the past against the `now` it is given, never the wall clock", () => {
    // The whole reason `now` is a parameter. Same input, a later `now`, and the day
    // that was in the future is now in the past.
    const later = new Date("2026-07-20T12:00:00Z");
    expect(codes(validateShiftEdit(edit(), [], [], later))).toEqual(["past-day"]);
  });

  it("reports every problem at once rather than one at a time", () => {
    const result = validateShiftEdit(edit({ staffId: "", startTime: "17:30", endTime: "09:00" }), [], [], NOW);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("originAfterEdit", () => {
  it("a human touch always makes a shift manual, generated or not", () => {
    // THE RULE THAT MAKES AN EDIT STICK. A moved shift that stayed 'generated' would
    // be re-derived from the config and moved straight back on the next run.
    expect(originAfterEdit()).toBe("manual");
  });
});

describe("notificationIsStale", () => {
  const before = {
    staffId: "d1",
    siteId: "site-a",
    shiftDate: TOMORROW,
    startTime: "09:00",
    endTime: "17:30",
  };

  it("a move makes the last text wrong, so the notification is stale", () => {
    // Otherwise a shift texted on Monday and moved on Tuesday is never corrected,
    // and somebody turns up at the old time.
    expect(notificationIsStale(before, { ...before, startTime: "12:00" })).toBe(true);
    expect(notificationIsStale(before, { ...before, shiftDate: "2026-07-10" })).toBe(true);
    expect(notificationIsStale(before, { ...before, siteId: "site-b" })).toBe(true);
    expect(notificationIsStale(before, { ...before, staffId: "d2" })).toBe(true);
    expect(notificationIsStale(before, { ...before, endTime: "13:00" })).toBe(true);
  });

  it("a note or a pairing change does not, because nobody needs texting at 2am about it", () => {
    expect(notificationIsStale(before, { ...before })).toBe(false);
  });
});

describe("pairingViolations", () => {
  const NURSE = { role: "nurse" } as const;

  it("says nothing at all when the practice does not work in pairs", () => {
    const day = [shift({ id: "s1", staffId: "d1" }), shift({ id: "s2", staffId: "n1", ...NURSE })];
    expect(pairingViolations(day, { ...CONFIG, pairRoles: null })).toEqual([]);
  });

  it("is happy with a mutual, same-site pairing", () => {
    const day = [
      shift({ id: "s1", staffId: "d1", pairedStaffId: "n1" }),
      shift({ id: "s2", staffId: "n1", ...NURSE, pairedStaffId: "d1" }),
    ];
    expect(pairingViolations(day, CONFIG)).toEqual([]);
  });

  it("flags a partner who is not working that day", () => {
    const day = [shift({ id: "s1", staffId: "d1", pairedStaffId: "n9" })];
    expect(pairingViolations(day, CONFIG).map((v) => v.code)).toEqual(["partner-not-working"]);
  });

  it("flags a partner at another site, because they are not in the same room", () => {
    const day = [
      shift({ id: "s1", staffId: "d1", pairedStaffId: "n1" }),
      shift({ id: "s2", staffId: "n1", ...NURSE, siteId: "site-b", pairedStaffId: "d1" }),
    ];
    expect(pairingViolations(day, CONFIG).some((v) => v.code === "partner-at-another-site")).toBe(true);
  });

  it("flags a one-way pairing, because the two shifts disagree about it", () => {
    const day = [
      shift({ id: "s1", staffId: "d1", pairedStaffId: "n1" }),
      shift({ id: "s2", staffId: "n1", ...NURSE, pairedStaffId: null }),
    ];
    expect(pairingViolations(day, CONFIG).map((v) => v.code)).toContain("pairing-not-mutual");
  });

  it("flags an unpaired clinician only when the practice actually rosters support that day", () => {
    const withNurse = [shift({ id: "s1", staffId: "d1" }), shift({ id: "s2", staffId: "n1", ...NURSE })];
    expect(pairingViolations(withNurse, CONFIG).some((v) => v.code === "unpaired")).toBe(true);

    // A dentist-only day is a dentist-only day, not a fault. Flagging it would train
    // the manager to ignore this list, which is worse than not having one.
    const withoutNurse = [shift({ id: "s1", staffId: "d1" })];
    expect(pairingViolations(withoutNurse, CONFIG)).toEqual([]);
  });

  it("ignores cancelled and tombstoned shifts entirely", () => {
    const day = [
      shift({ id: "s1", staffId: "d1", status: "removed", pairedStaffId: "n9" }),
      shift({ id: "s2", staffId: "d2", status: "cancelled", pairedStaffId: "n9" }),
    ];
    expect(pairingViolations(day, CONFIG)).toEqual([]);
  });
});
