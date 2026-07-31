import { describe, expect, it } from "vitest";
import {
  entriesForColumn,
  entryAppliesTo,
  entrySentence,
  occupyingEntries,
  validateEntryInput,
  type DiaryEntryRecord,
} from "./entries";

function entry(over: Partial<DiaryEntryRecord> = {}): DiaryEntryRecord {
  return {
    id: "de-1",
    clientId: "vitality",
    siteId: "site-cc",
    practitionerId: "prac-2",
    day: "2026-07-31",
    startMin: 780,
    endMin: 840,
    kind: "break",
    title: "Lunch",
    body: null,
    authorName: "Team",
    createdAt: "2026-07-30T10:00:00Z",
    updatedAt: "2026-07-30T10:00:00Z",
    ...over,
  };
}

describe("entryAppliesTo", () => {
  it("is true for EVERY column when practitionerId is null (a site-wide entry)", () => {
    const siteWide = entry({ practitionerId: null });
    expect(entryAppliesTo(siteWide, "prac-1")).toBe(true);
    expect(entryAppliesTo(siteWide, "prac-2")).toBe(true);
    expect(entryAppliesTo(siteWide, null)).toBe(true);
  });

  it("is true only for its own column otherwise", () => {
    expect(entryAppliesTo(entry(), "prac-2")).toBe(true);
    expect(entryAppliesTo(entry(), "prac-1")).toBe(false);
    expect(entryAppliesTo(entry(), null)).toBe(false);
  });
});

describe("entrySentence", () => {
  it("LEADS with the kind, so a screen reader cannot take it for a booking", () => {
    expect(entrySentence(entry(), "Femi Osei")).toBe("Break. 13:00 to 14:00, 60 minutes. Lunch. Femi Osei.");
  });

  it("says Note for a note and never a patient name", () => {
    const note = entry({ kind: "note", title: "Shak working", startMin: 540, endMin: 545, body: "BEE" });
    expect(entrySentence(note, null)).toBe("Note. 09:00 to 09:05, 5 minutes. Shak working. BEE.");
  });

  it("uses the singular for a one minute entry", () => {
    expect(entrySentence(entry({ startMin: 780, endMin: 781 }), null)).toContain("1 minute.");
  });
});

describe("occupyingEntries", () => {
  it("returns BREAKS only: a note does not occupy", () => {
    const rows = [entry({ id: "a" }), entry({ id: "b", kind: "note" })];
    expect(occupyingEntries(rows, "prac-2").map((e) => e.id)).toEqual(["a"]);
  });

  it("includes a site-wide break in every column", () => {
    const rows = [entry({ id: "site", practitionerId: null })];
    expect(occupyingEntries(rows, "prac-9")).toHaveLength(1);
  });
});

describe("entriesForColumn", () => {
  it("filters by day AND column, breaks and notes alike", () => {
    const rows = [
      entry({ id: "today" }),
      entry({ id: "tomorrow", day: "2026-08-01" }),
      entry({ id: "other-clinician", practitionerId: "prac-9" }),
      entry({ id: "note", kind: "note" }),
    ];
    expect(entriesForColumn(rows, "prac-2", "2026-07-31").map((e) => e.id)).toEqual(["today", "note"]);
  });
});

describe("validateEntryInput", () => {
  const good = { kind: "break", title: "Lunch", body: "", day: "2026-07-31", startMin: 780, endMin: 840 };

  it("accepts a well-formed break and normalises an empty body to null", () => {
    const res = validateEntryInput(good);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        kind: "break",
        title: "Lunch",
        body: null,
        day: "2026-07-31",
        startMin: 780,
        endMin: 840,
        practitionerId: null,
      });
    }
  });

  it("refuses a kind outside the union", () => {
    expect(validateEntryInput({ ...good, kind: "holiday" }).ok).toBe(false);
    expect(validateEntryInput({ ...good, kind: undefined }).ok).toBe(false);
  });

  it("refuses an empty title and an 81 character title", () => {
    expect(validateEntryInput({ ...good, title: "   " }).ok).toBe(false);
    expect(validateEntryInput({ ...good, title: "x".repeat(80) }).ok).toBe(true);
    expect(validateEntryInput({ ...good, title: "x".repeat(81) }).ok).toBe(false);
  });

  it("refuses a 501 character body", () => {
    expect(validateEntryInput({ ...good, body: "x".repeat(500) }).ok).toBe(true);
    expect(validateEntryInput({ ...good, body: "x".repeat(501) }).ok).toBe(false);
  });

  it("refuses start >= end", () => {
    expect(validateEntryInput({ ...good, startMin: 840, endMin: 840 }).ok).toBe(false);
    expect(validateEntryInput({ ...good, startMin: 900, endMin: 840 }).ok).toBe(false);
  });

  it("refuses a minute that is not a multiple of five", () => {
    expect(validateEntryInput({ ...good, startMin: 782 }).ok).toBe(false);
    expect(validateEntryInput({ ...good, endMin: 841 }).ok).toBe(false);
  });

  it("refuses an end past midnight and a negative start", () => {
    expect(validateEntryInput({ ...good, startMin: 1435, endMin: 1440 }).ok).toBe(true);
    expect(validateEntryInput({ ...good, startMin: 1435, endMin: 1445 }).ok).toBe(false);
    expect(validateEntryInput({ ...good, startMin: -5, endMin: 60 }).ok).toBe(false);
  });

  it("refuses a malformed day key", () => {
    expect(validateEntryInput({ ...good, day: "31/07/2026" }).ok).toBe(false);
    expect(validateEntryInput({ ...good, day: "2026-7-31" }).ok).toBe(false);
    expect(validateEntryInput({ ...good, day: 20260731 }).ok).toBe(false);
  });

  it("keeps a supplied practitioner id and blanks an empty one", () => {
    const withId = validateEntryInput({ ...good, practitionerId: " prac-2 " });
    expect(withId.ok && withId.value.practitionerId).toBe("prac-2");
    const blank = validateEntryInput({ ...good, practitionerId: "   " });
    expect(blank.ok && blank.value.practitionerId).toBeNull();
  });
});
