import { describe, it, expect } from "vitest";
import { canEditNote } from "./edit-window";

// The rule is AUTHORSHIP ONLY. The fifteen minute window this file used to pin was
// removed deliberately: the owner chose to match Dentally, whose pencil has no window.
// Attribution carries the safety instead (updated_at / updated_by, migration 0064).

const NOW = new Date("2026-07-31T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("canEditNote", () => {
  it("lets the author edit their own note", () => {
    expect(canEditNote({ authorId: "u1", createdAt: minutesAgo(2) }, NOW, "u1")).toBe(true);
  });

  it("STILL lets the author edit a note written years ago", () => {
    // This is the behaviour that changed. A typo noticed later is still the author's
    // to fix, and refusing it is friction a Dentally user would not understand.
    expect(canEditNote({ authorId: "u1", createdAt: "2019-03-04T09:00:00Z" }, NOW, "u1")).toBe(true);
  });

  it("refuses someone else's note however recent it is", () => {
    expect(canEditNote({ authorId: "u2", createdAt: minutesAgo(1) }, NOW, "u1")).toBe(false);
  });

  it("refuses an authored note to an unauthenticated caller", () => {
    // Written under enforcement, so it has an author; an anonymous caller can never
    // be shown to be that person.
    expect(canEditNote({ authorId: "u1", createdAt: minutesAgo(1) }, NOW, null)).toBe(false);
  });

  it("refuses an unauthored note to a signed-in caller: authorship cannot be shown", () => {
    // Written before enforcement, so nobody is recorded as the author. A signed-in
    // reader must not inherit it.
    expect(canEditNote({ authorId: null, createdAt: minutesAgo(1) }, NOW, "u1")).toBe(false);
  });

  it("allows the unenforced pilot case, where there is no author and no session", () => {
    expect(canEditNote({ authorId: null, createdAt: minutesAgo(1) }, NOW, null)).toBe(true);
  });

  it("does not care about the timestamp at all now", () => {
    // Pins that `now` and `createdAt` no longer influence the answer, so a future
    // reader does not have to guess whether a window is still lurking somewhere.
    for (const createdAt of ["2001-01-01T00:00:00Z", "2099-01-01T00:00:00Z", "not a date"]) {
      expect(canEditNote({ authorId: "u1", createdAt }, NOW, "u1")).toBe(true);
    }
  });
});
