import { describe, it, expect } from "vitest";
import {
  buildPublication,
  diffAgainstPublished,
  nextVersion,
  summarisePrePublish,
  weekRange,
} from "./publish";
import type { Absence } from "@/lib/absence/types";
import type { RotaShift } from "./types";

const WEEK_START = "2026-07-06"; // Monday

function shift(over: Partial<RotaShift> & Pick<RotaShift, "id" | "staffId" | "shiftDate">): RotaShift {
  return {
    clientId: "vitality",
    siteId: "site-a",
    startTime: "09:00",
    endTime: "17:30",
    role: "dentist",
    status: "scheduled",
    origin: "generated",
    pairedStaffId: null,
    note: null,
    ...over,
  } as RotaShift;
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

const WEEK: RotaShift[] = [
  shift({ id: "s1", staffId: "d1", shiftDate: "2026-07-06" }),
  shift({ id: "s2", staffId: "n1", shiftDate: "2026-07-06", role: "nurse" }),
  shift({ id: "s3", staffId: "d1", shiftDate: "2026-07-07" }),
];

describe("weekRange", () => {
  it("covers Monday to Sunday inclusive", () => {
    expect(weekRange(WEEK_START)).toEqual({ from: "2026-07-06", to: "2026-07-12" });
  });
});

describe("nextVersion", () => {
  it("publish version increments", () => {
    // THE NAMED RULE. Versions start at 1 and only ever go up.
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([{ version: 1 }])).toBe(2);
    expect(nextVersion([{ version: 1 }, { version: 2 }, { version: 3 }])).toBe(4);
  });

  it("derives from the MAX, never the count, so a deleted row cannot reuse a number", () => {
    // Two different rotas both calling themselves v3 is the one thing this log
    // exists to make impossible.
    expect(nextVersion([{ version: 1 }, { version: 3 }])).toBe(4);
    expect(nextVersion([{ version: 7 }])).toBe(8);
  });

  it("ignores nonsense rather than producing NaN", () => {
    expect(nextVersion([{ version: Number.NaN }, { version: 2 }])).toBe(3);
  });
});

describe("buildPublication", () => {
  it("records exactly the shifts that were published, in a stable order", () => {
    const snap = buildPublication(WEEK, WEEK_START, 1);
    expect(snap.version).toBe(1);
    expect(snap.weekStart).toBe(WEEK_START);
    expect(snap.shifts.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("is independent of the order the shifts arrived in", () => {
    const forwards = buildPublication(WEEK, WEEK_START, 1);
    const backwards = buildPublication([...WEEK].reverse(), WEEK_START, 1);
    expect(backwards).toEqual(forwards);
  });

  it("publishing twice with no change produces an identical snapshot", () => {
    // THE NAMED RULE. If the same rota produced a different snapshot each time, the
    // diff would report changes nobody made and the "your rota changed" message
    // would go out for nothing.
    const first = buildPublication(WEEK, WEEK_START, 1);
    const second = buildPublication(WEEK, WEEK_START, 2);
    expect(second.shifts).toEqual(first.shifts);
  });

  it("excludes cancelled and tombstoned shifts: nobody is being told to work them", () => {
    const withDead = [
      ...WEEK,
      shift({ id: "s4", staffId: "d2", shiftDate: "2026-07-08", status: "cancelled" }),
      shift({ id: "s5", staffId: "d3", shiftDate: "2026-07-08", status: "removed" }),
    ];
    expect(buildPublication(withDead, WEEK_START, 1).shifts.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("excludes shifts outside the week", () => {
    const spanning = [...WEEK, shift({ id: "s9", staffId: "d1", shiftDate: "2026-07-13" })];
    expect(buildPublication(spanning, WEEK_START, 1).shifts.map((s) => s.id)).not.toContain("s9");
  });

  it("filters to one site when a site is named, and every site when it is not", () => {
    const twoSites = [...WEEK, shift({ id: "s6", staffId: "d2", shiftDate: "2026-07-06", siteId: "site-b" })];
    expect(buildPublication(twoSites, WEEK_START, 1, "site-a").shifts.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(buildPublication(twoSites, WEEK_START, 1, null).shifts).toHaveLength(4);
  });

  it("carries the pairing and the note, because they are part of what somebody was told", () => {
    const paired = [shift({ id: "s1", staffId: "d1", shiftDate: "2026-07-06", pairedStaffId: "n1", note: "Late start" })];
    expect(buildPublication(paired, WEEK_START, 1).shifts[0]).toMatchObject({
      pairedStaffId: "n1",
      note: "Late start",
    });
  });

  it("carries no status or timestamp, so a text message cannot look like a rota change", () => {
    // A snapshot holding notifiedAt would differ from the previous one the instant
    // anybody was texted, and every publish would report changes that are not changes.
    const snap = buildPublication(WEEK, WEEK_START, 1);
    expect(Object.keys(snap.shifts[0]).sort()).toEqual([
      "endTime",
      "id",
      "note",
      "pairedStaffId",
      "role",
      "shiftDate",
      "siteId",
      "staffId",
      "startTime",
    ]);
  });
});

describe("diffAgainstPublished", () => {
  const published = buildPublication(WEEK, WEEK_START, 1);

  it("reports nothing when nothing changed", () => {
    const diff = diffAgainstPublished(WEEK, published);
    expect(diff.changeCount).toBe(0);
    expect(diff.unchanged).toBe(3);
  });

  it("a shift moved after publish shows in diffAgainstPublished", () => {
    // THE NAMED RULE, and the reason a move is an UPDATE and a delete is a
    // tombstone: the id survives, so this reads as one shift that changed rather
    // than a deletion plus an unrelated addition.
    const moved = WEEK.map((s) => (s.id === "s3" ? { ...s, shiftDate: "2026-07-09" } : s));
    const diff = diffAgainstPublished(moved, published);
    expect(diff.changeCount).toBe(1);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].before.shiftDate).toBe("2026-07-07");
    expect(diff.changed[0].after.shiftDate).toBe("2026-07-09");
    expect(diff.changed[0].fields).toEqual(["shiftDate"]);
  });

  it("names exactly which fields moved, so the copy can say what happened", () => {
    const retimed = WEEK.map((s) => (s.id === "s1" ? { ...s, startTime: "12:00", siteId: "site-b" } : s));
    expect(diffAgainstPublished(retimed, published).changed[0].fields.sort()).toEqual(["siteId", "startTime"]);
  });

  it("a new shift reads as added", () => {
    const withNew = [...WEEK, shift({ id: "s7", staffId: "d2", shiftDate: "2026-07-08" })];
    const diff = diffAgainstPublished(withNew, published);
    expect(diff.added.map((s) => s.id)).toEqual(["s7"]);
    expect(diff.changeCount).toBe(1);
  });

  it("a tombstoned shift reads as removed, which is exactly what the staff member needs told", () => {
    const withTombstone = WEEK.map((s) => (s.id === "s2" ? { ...s, status: "removed" as const } : s));
    const diff = diffAgainstPublished(withTombstone, published);
    expect(diff.removed.map((s) => s.id)).toEqual(["s2"]);
    expect(diff.changeCount).toBe(1);
  });

  it("a change to the pairing counts as a change", () => {
    const repaired = WEEK.map((s) => (s.id === "s1" ? { ...s, pairedStaffId: "n1" } : s));
    expect(diffAgainstPublished(repaired, published).changed[0].fields).toEqual(["pairedStaffId"]);
  });

  it("compares against the published SITE scope, not the whole practice", () => {
    const siteA = buildPublication(WEEK, WEEK_START, 1, "site-a");
    const withOtherSite = [...WEEK, shift({ id: "s8", staffId: "d5", shiftDate: "2026-07-06", siteId: "site-b" })];
    // A shift at another site is not a change to what site-a's team was told.
    expect(diffAgainstPublished(withOtherSite, siteA).changeCount).toBe(0);
  });
});

describe("summarisePrePublish", () => {
  const base = {
    shifts: WEEK,
    weekStart: WEEK_START,
    siteId: null,
    previous: null,
    existingVersions: [] as { version: number }[],
    absences: [] as Absence[],
  };

  it("a first publish is version 1 and counts everything as new", () => {
    // Calling a first publish "0 changes" would read as "nothing to send" on the one
    // press that sends the most.
    const summary = summarisePrePublish(base);
    expect(summary.version).toBe(1);
    expect(summary.firstPublish).toBe(true);
    expect(summary.shiftCount).toBe(3);
    expect(summary.changeCount).toBe(3);
    expect(summary.diff).toBeNull();
  });

  it("counts the distinct people who would be told something", () => {
    expect(summarisePrePublish(base).staffCount).toBe(2);
  });

  it("a re-publish with no change reports zero changes", () => {
    const summary = summarisePrePublish({
      ...base,
      previous: buildPublication(WEEK, WEEK_START, 1),
      existingVersions: [{ version: 1 }],
    });
    expect(summary.version).toBe(2);
    expect(summary.firstPublish).toBe(false);
    expect(summary.changeCount).toBe(0);
  });

  it("counts a moved shift as one change against the last published version", () => {
    const moved = WEEK.map((s) => (s.id === "s3" ? { ...s, startTime: "12:00" } : s));
    const summary = summarisePrePublish({
      ...base,
      shifts: moved,
      previous: buildPublication(WEEK, WEEK_START, 1),
      existingVersions: [{ version: 1 }],
    });
    expect(summary.changeCount).toBe(1);
  });

  it("surfaces a shift rostered on agreed time off, without blocking the publish", () => {
    const summary = summarisePrePublish({
      ...base,
      absences: [absence({ id: "a1", staffId: "d1", startDate: "2026-07-06", endDate: "2026-07-06" })],
    });
    expect(summary.conflicts).toEqual([{ shiftId: "s1", staffId: "d1", shiftDate: "2026-07-06" }]);
    // It is a thing to look at, not a refusal: the summary still describes a
    // publishable week.
    expect(summary.shiftCount).toBe(3);
  });

  it("a pending absence is not a conflict, because nobody has agreed it", () => {
    const summary = summarisePrePublish({
      ...base,
      absences: [
        absence({ id: "a1", staffId: "d1", startDate: "2026-07-06", endDate: "2026-07-06", status: "pending" }),
      ],
    });
    expect(summary.conflicts).toEqual([]);
  });

  it("is stable: the same inputs always produce the same summary", () => {
    expect(summarisePrePublish(base)).toEqual(summarisePrePublish(base));
  });
});
