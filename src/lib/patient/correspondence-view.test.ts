import { describe, it, expect } from "vitest";
import {
  CORRESPONDENCE_PAGE_SIZE,
  pageCount,
  pageOf,
  pageRangeLabel,
  parseCorrespondenceView,
} from "./correspondence-view";

// ===========================================================================
// THE PAGES/LIST TOGGLE AND ITS PAGER.
//
// The owner's ask: "I'll put a tab that they can switch between list and pages",
// with Pages the default because he leaned toward Dentally's shape — "maybe do it
// the way dentally has it".
//
// The pager is tested purely, away from the component, for the reason the whole
// module exists: the ONE thing that is easy to get wrong here is which end of an
// oldest-first array page 1 comes from, and getting it wrong opens a clinician's
// screen on a patient's oldest messages from years ago.
// ===========================================================================

/** 1..n as strings, standing in for an oldest-first timeline. */
function entries(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(i + 1));
}

describe("the remembered view survives a round trip", () => {
  it("defaults to PAGES for anything unset or unrecognised", () => {
    // The owner's stated preference, not the layout that happened to exist first. A
    // practice that has never touched the toggle gets the shape they asked for.
    expect(parseCorrespondenceView(undefined)).toBe("pages");
    expect(parseCorrespondenceView(null)).toBe("pages");
    expect(parseCorrespondenceView("")).toBe("pages");
    expect(parseCorrespondenceView("nonsense")).toBe("pages");
  });

  it("honours an explicitly stored list choice", () => {
    expect(parseCorrespondenceView("list")).toBe("list");
    expect(parseCorrespondenceView("pages")).toBe("pages");
  });
});

describe("page 1 is the NEWEST slice of an oldest-first timeline", () => {
  it("opens on the most recent entries, not the oldest", () => {
    // THE WHOLE POINT OF THE MODULE. The timeline is built oldest-first because that is
    // chat order and it is what the list view wants. A pager slicing from the FRONT
    // would open a clinician's screen on a patient's messages from years ago.
    const page1 = pageOf(entries(60), 1, 25);
    expect(page1).toHaveLength(25);
    expect(page1[page1.length - 1]).toBe("60");
    expect(page1[0]).toBe("36");
  });

  it("reads oldest-to-newest WITHIN a page, so a page reads top to bottom", () => {
    // Reversing inside the page as well would give a screen that reads backwards
    // within a page and forwards between them.
    expect(pageOf(entries(60), 1, 25)[0]).toBe("36");
    expect(pageOf(entries(60), 1, 25)[1]).toBe("37");
  });

  it("walks BACK through time as the page number rises", () => {
    expect(pageOf(entries(60), 2, 25)).toEqual(entries(35).slice(10)); // 11..35
    // The last page holds the remainder, which is the OLDEST entries.
    expect(pageOf(entries(60), 3, 25)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  it("CLAMPS an out-of-range page instead of rendering nothing", () => {
    // A pasted or stale page number must not render an empty panel on a patient with a
    // full history: an empty panel on this tab is the state that says "nobody
    // contacted her".
    expect(pageOf(entries(60), 99, 25)).toEqual(pageOf(entries(60), 3, 25));
    expect(pageOf(entries(60), 0, 25)).toEqual(pageOf(entries(60), 1, 25));
    expect(pageOf(entries(60), -5, 25)).toEqual(pageOf(entries(60), 1, 25));
  });

  it("returns everything when there is less than one page of it", () => {
    expect(pageOf(entries(4), 1, 25)).toEqual(["1", "2", "3", "4"]);
    expect(pageOf([], 1, 25)).toEqual([]);
  });

  it("every entry appears on exactly one page, so paging loses nothing", () => {
    // The property that actually matters on a correspondence history: a reader who
    // pages to the end has seen all of it, exactly once.
    const all = entries(60);
    const seen = [1, 2, 3].flatMap((p) => pageOf(all, p, 25));
    expect(seen.slice().sort((a, b) => Number(a) - Number(b))).toEqual(
      all.slice().sort((a, b) => Number(a) - Number(b)),
    );
    expect(new Set(seen).size).toBe(60);
  });
});

describe("the pager tells a reader where they are", () => {
  it("counts pages, and always has at least one", () => {
    expect(pageCount(0, 25)).toBe(1); // an empty history still has a page to draw
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(60, 25)).toBe(3);
  });

  it("states the range in READING order even though page 1 is the newest", () => {
    // "Showing 36 to 60" on the first page reads as though something has been skipped.
    // The low number comes first because that is how a reader parses a range.
    expect(pageRangeLabel(60, 1, 25)).toBe("Showing 36 to 60 of 60");
    expect(pageRangeLabel(60, 3, 25)).toBe("Showing 1 to 10 of 60");
  });

  it("says nothing at all when there is nothing to count", () => {
    expect(pageRangeLabel(0, 1, 25)).toBe("");
  });

  it("uses a page size the practice is already trained on", () => {
    // Twenty-five is Dentally's own page size. Copying the number the practice already
    // counts in costs nothing and means a coordinator lands in the same place here.
    expect(CORRESPONDENCE_PAGE_SIZE).toBe(25);
  });
});
