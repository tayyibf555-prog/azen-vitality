import { describe, expect, it } from "vitest";
import { normaliseDurationMin, validateMove, type MoveContext, type MoveProposal } from "./move-validate";

const BOUNDS = { startMin: 480, endMin: 1200 };

function ctx(over: Partial<MoveContext> = {}): MoveContext {
  return {
    targetPractitionerId: "prac-2",
    targetPractitionerName: "Femi Osei",
    workState: "working",
    workingSpans: [{ startMin: 540, endMin: 1020 }],
    occupiedSpans: [],
    breakSpans: [],
    bounds: BOUNDS,
    movingAppointmentId: "appt-1",
    // The DEFAULT is a time-only move: the appointment is already with the
    // target clinician, so the continuing-treatment rule is not in play and
    // every check below reads as it did before that rule existed. The rule's own
    // behaviour is exercised by its own describe block, which changes the source.
    movingReason: "Checkup",
    sourcePractitionerId: "prac-2",
    sourcePractitionerName: "Femi Osei",
    ...over,
  };
}

/** The same context with the appointment currently held by SOMEONE ELSE. */
function fromOther(over: Partial<MoveContext> = {}): MoveContext {
  return ctx({
    sourcePractitionerId: "prac-1",
    sourcePractitionerName: "Dana Hale",
    ...over,
  });
}

function move(over: Partial<MoveProposal> = {}): MoveProposal {
  return {
    appointmentId: "appt-1",
    startMin: 870,
    endMin: 900,
    practitionerId: "prac-2",
    dayKey: "2026-07-31",
    ...over,
  };
}

describe("validateMove: the continuing-treatment refusal", () => {
  it("refuses a continuing course handed to another clinician, naming the one it stays with", () => {
    const res = validateMove(move(), fromOther({ movingReason: "Root canal review" }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a refusal");
    expect(res.code).toBe("continuing_treatment");
    expect(res.message).toContain("Dana Hale");
  });

  it("refuses an ambiguous reason across clinicians rather than allowing it", () => {
    const res = validateMove(move(), fromOther({ movingReason: "Review" }));
    expect(res.ok === false && res.code).toBe("continuity_unclear");
  });

  it("refuses a reason it has never seen, and one that is missing entirely", () => {
    // The fail-safe direction, asserted at the VALIDATOR and not only inside
    // continuity.ts: a treatment string the practice invents tomorrow must not
    // become freely draggable by default.
    expect(validateMove(move(), fromOther({ movingReason: "Zzz unheard of thing" })).ok).toBe(false);
    expect(validateMove(move(), fromOther({ movingReason: null })).ok).toBe(false);
  });

  it("allows a checkup across clinicians", () => {
    expect(validateMove(move(), fromOther({ movingReason: "Checkup" }))).toEqual({ ok: true });
  });

  it("allows a continuing course to move in TIME within its own clinician's column", () => {
    // Same clinician, a different hour: the rule is about who, never about when.
    const res = validateMove(
      move({ startMin: 600, endMin: 630 }),
      ctx({ movingReason: "Root canal review" }),
    );
    expect(res).toEqual({ ok: true });
  });

  it("allows an Unassigned appointment to be given to a clinician", () => {
    const res = validateMove(
      move(),
      fromOther({ movingReason: "Root canal review", sourcePractitionerId: null }),
    );
    expect(res).toEqual({ ok: true });
  });

  it("is checked BEFORE hours_unknown, because it needs no read to be true", () => {
    const res = validateMove(
      move(),
      fromOther({ movingReason: "Root canal review", workState: "unknown" }),
    );
    expect(res.ok === false && res.code).toBe("continuing_treatment");
  });

  it("is checked AFTER unassigned, so the target being nobody is still the first thing said", () => {
    const res = validateMove(
      move({ practitionerId: null }),
      fromOther({ movingReason: "Root canal review", targetPractitionerId: null }),
    );
    expect(res.ok === false && res.code).toBe("unassigned");
  });
});

describe("validateMove: the six refusals", () => {
  it("1. unassigned", () => {
    const res = validateMove(move({ practitionerId: null }), ctx({ targetPractitionerId: null }));
    expect(res).toEqual({
      ok: false,
      code: "unassigned",
      message: "An appointment cannot be moved to Unassigned. Choose a clinician.",
    });
  });

  it("2. hours_unknown REFUSES rather than warning", () => {
    const res = validateMove(move(), ctx({ workState: "unknown" }));
    expect(res).toEqual({
      ok: false,
      code: "hours_unknown",
      message: "Working hours could not be read for Femi Osei, so this move cannot be checked.",
    });
  });

  it("3. outside_day", () => {
    const res = validateMove(move({ startMin: 1180, endMin: 1240 }), ctx());
    expect(res).toEqual({
      ok: false,
      code: "outside_day",
      message: "That is outside the diary's hours for this day.",
    });
  });

  it("4. outside_hours: the whole span must lie inside the working union", () => {
    const res = validateMove(move({ startMin: 1000, endMin: 1030 }), ctx());
    expect(res).toEqual({
      ok: false,
      code: "outside_hours",
      message: "The proposed time is outside Femi Osei's working hours.",
    });
  });

  it("5. occupied names the clashing appointment's own start time", () => {
    const res = validateMove(
      move({ startMin: 870, endMin: 900 }),
      ctx({ occupiedSpans: [{ startMin: 840, endMin: 885, appointmentId: "appt-other" }] }),
    );
    expect(res).toEqual({
      ok: false,
      code: "occupied",
      message: "Femi Osei already has an appointment at 14:00.",
    });
  });

  it("6. on_break", () => {
    const res = validateMove(move(), ctx({ breakSpans: [{ startMin: 860, endMin: 920 }] }));
    expect(res).toEqual({
      ok: false,
      code: "on_break",
      message: "Femi Osei has a break booked at that time.",
    });
  });
});

describe("validateMove: ordering when several apply", () => {
  it("settles unassigned before anything that would consult availability", () => {
    const res = validateMove(
      move({ practitionerId: null, startMin: 1180, endMin: 1240 }),
      ctx({ targetPractitionerId: null, workState: "unknown" }),
    );
    expect(res.ok === false && res.code).toBe("unassigned");
  });

  it("reports hours_unknown ahead of an occupancy clash", () => {
    const res = validateMove(
      move(),
      ctx({ workState: "unknown", occupiedSpans: [{ startMin: 870, endMin: 900, appointmentId: "x" }] }),
    );
    expect(res.ok === false && res.code).toBe("hours_unknown");
  });

  it("reports outside_day ahead of outside_hours", () => {
    const res = validateMove(move({ startMin: 300, endMin: 330 }), ctx());
    expect(res.ok === false && res.code).toBe("outside_day");
  });

  it("reports outside_hours ahead of occupied", () => {
    const res = validateMove(
      move({ startMin: 1080, endMin: 1110 }),
      ctx({ occupiedSpans: [{ startMin: 1080, endMin: 1110, appointmentId: "x" }] }),
    );
    expect(res.ok === false && res.code).toBe("outside_hours");
  });

  it("reports occupied ahead of on_break", () => {
    const res = validateMove(
      move(),
      ctx({
        occupiedSpans: [{ startMin: 870, endMin: 900, appointmentId: "x" }],
        breakSpans: [{ startMin: 870, endMin: 900 }],
      }),
    );
    expect(res.ok === false && res.code).toBe("occupied");
  });
});

describe("validateMove: occupancy", () => {
  it("refuses a clash EVEN WHEN a working window covers the time", () => {
    // Whether Dentally's availability windows already exclude booked time is
    // unproven, so bookings are subtracted explicitly rather than trusted away.
    const res = validateMove(
      move({ startMin: 600, endMin: 630 }),
      ctx({
        workingSpans: [{ startMin: 540, endMin: 1020 }],
        occupiedSpans: [{ startMin: 600, endMin: 630, appointmentId: "appt-other" }],
      }),
    );
    expect(res.ok === false && res.code).toBe("occupied");
  });

  it("excludes the appointment being moved, so a five minute nudge onto itself is legal", () => {
    const res = validateMove(
      move({ startMin: 605, endMin: 635 }),
      ctx({ occupiedSpans: [{ startMin: 600, endMin: 630, appointmentId: "appt-1" }] }),
    );
    expect(res).toEqual({ ok: true });
  });

  it("treats a caller that omitted cancelled and DNA spans as unoccupied", () => {
    // The CALLER decides what occupies: cancelled and did_not_attend are not
    // passed in, so the slot is free and the drop succeeds.
    expect(validateMove(move(), ctx({ occupiedSpans: [] }))).toEqual({ ok: true });
  });

  it("allows a drop onto a NOTE, because a note is not passed as a break", () => {
    expect(validateMove(move(), ctx({ breakSpans: [] }))).toEqual({ ok: true });
  });
});

describe("validateMove: the happy path", () => {
  it("accepts a span wholly inside working hours with nothing in the way", () => {
    expect(validateMove(move(), ctx())).toEqual({ ok: true });
  });

  it("accepts a span sitting exactly on the working boundary", () => {
    expect(validateMove(move({ startMin: 540, endMin: 570 }), ctx())).toEqual({ ok: true });
    expect(validateMove(move({ startMin: 990, endMin: 1020 }), ctx())).toEqual({ ok: true });
  });

  it("names 'this clinician' rather than an empty gap when the name is missing", () => {
    const res = validateMove(move({ startMin: 1000, endMin: 1030 }), ctx({ targetPractitionerName: "  " }));
    expect(res.ok === false && res.message).toBe("The proposed time is outside this clinician's working hours.");
  });
});

describe("normaliseDurationMin", () => {
  it("accepts 5 to 480 on a five minute mark", () => {
    expect(normaliseDurationMin(5)).toBe(5);
    expect(normaliseDurationMin(30)).toBe(30);
    expect(normaliseDurationMin(480)).toBe(480);
    expect(normaliseDurationMin("45")).toBe(45);
  });

  it("refuses out of range, off-grid and unreadable durations rather than clamping", () => {
    expect(normaliseDurationMin(0)).toBeNull();
    expect(normaliseDurationMin(4)).toBeNull();
    expect(normaliseDurationMin(485)).toBeNull();
    expect(normaliseDurationMin(32)).toBeNull();
    expect(normaliseDurationMin(-30)).toBeNull();
    expect(normaliseDurationMin("half an hour")).toBeNull();
    expect(normaliseDurationMin(undefined)).toBeNull();
  });
});

describe("the cross-site refusal", () => {
  it("refuses a drop onto a clinician we cannot place at this practice", () => {
    // Their availability windows may describe another practice entirely, so the
    // drop cannot be checked at all. Refused, never permitted with a warning.
    const result = validateMove(
      { appointmentId: "a1", startMin: 600, endMin: 630, practitionerId: "p", dayKey: "2026-07-31" },
      {
        targetPractitionerId: "p",
        targetPractitionerName: "Femi Osei",
        workState: "unconfirmed",
        workingSpans: [{ startMin: 540, endMin: 1020 }],
        occupiedSpans: [],
        breakSpans: [],
        bounds: { startMin: 480, endMin: 1200 },
        movingAppointmentId: "a1",
        // A time-only move: the continuing-treatment rule is not what is under
        // test here and must not be what answers.
        movingReason: "Checkup",
        sourcePractitionerId: "p",
        sourcePractitionerName: "Femi Osei",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("site_unconfirmed");
      expect(result.message).toContain("Femi Osei");
      expect(result.message).toContain("more than one practice");
    }
  });

  it("is settled AFTER unassigned and hours_unknown, which are more fundamental", () => {
    const unassigned = validateMove(
      { appointmentId: "a1", startMin: 600, endMin: 630, practitionerId: null, dayKey: "2026-07-31" },
      {
        targetPractitionerId: null,
        targetPractitionerName: "",
        workState: "unconfirmed",
        workingSpans: [],
        occupiedSpans: [],
        breakSpans: [],
        bounds: { startMin: 480, endMin: 1200 },
        movingAppointmentId: "a1",
        // A time-only move: the continuing-treatment rule is not what is under
        // test here and must not be what answers.
        movingReason: "Checkup",
        sourcePractitionerId: "p",
        sourcePractitionerName: "Femi Osei",
      },
    );
    expect(unassigned.ok).toBe(false);
    if (!unassigned.ok) expect(unassigned.code).toBe("unassigned");
  });
});

describe("a move onto a day that has already gone", () => {
  it("is refused, and named as the calendar fact it is rather than an outage", () => {
    const res = validateMove(move(), ctx({ workState: "past" }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("hours_past");
    expect(res.ok === false && res.message).toContain("passed");
  });

  it("is refused even where the day's own bookings would have contained the drop", () => {
    // The union of a past day is bookings ALONE -- Dentally will not report the
    // hours -- so accepting a drop into the gap between two of them books a
    // patient against hours nobody can verify.
    const res = validateMove(
      move(),
      ctx({ workState: "past", workingSpans: [{ startMin: 0, endMin: 1440 }] }),
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("hours_past");
  });
});

describe("a move onto today, when the hours we can ask about are gone", () => {
  it("is refused with its own code, so the write path agrees with the hatched column", () => {
    // The grid hatches this column rather than greying it, and a refusal is the
    // same statement on the write side: a drop checked against no working hours
    // at all is not checked.
    const res = validateMove(move(), ctx({ workState: "unreportable", workingSpans: [] }));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("hours_unreportable");
  });

  it("does NOT tell the reader the date has passed, because today has not", () => {
    // The whole reason this is not "past": "Date has passed" said about today is
    // plainly wrong, and a wrong sentence here teaches staff to distrust the
    // right ones.
    const res = validateMove(move(), ctx({ workState: "unreportable", workingSpans: [] }));
    expect(res.ok === false && res.message).not.toContain("passed");
    expect(res.ok === false && res.message).toContain("Femi Osei");
  });

  it("is refused even where the day's own bookings would have contained the drop", () => {
    const res = validateMove(
      move(),
      ctx({ workState: "unreportable", workingSpans: [{ startMin: 0, endMin: 1440 }] }),
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("hours_unreportable");
  });

  it("is settled AFTER a failed read, which is the more fundamental gap", () => {
    const res = validateMove(move(), ctx({ workState: "unknown" }));
    expect(res.ok === false && res.code).toBe("hours_unknown");
  });
});
