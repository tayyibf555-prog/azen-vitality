import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

import { srcPath, walkSrc } from "@/lib/test-support/walk-src";

import { pageToCeiling, metaTotal } from "./paging";
import { metaTotal as reportsMetaTotal } from "@/lib/reports/scan";

// ---------------------------------------------------------------------------
// F4 — TWO COPIES OF ONE BOUNDED PAGER, BOTH MEASURING THE WRONG THING.
//
// dentally/read.ts declared `pageBounded` and charting-read.ts declared
// `pageToCeiling`: line for line the same walk, differing only in whether the
// truncation came back or was thrown away. Both measured a short page against their
// OWN module's PER_PAGE constant while every caller chose `per_page` inside its own
// closure — nothing tied the size ASKED FOR to the size MEASURED AGAINST. That is
// the exact drift `pageAll` had just been fixed for two directories away, sitting
// unfixed in two more places.
// ---------------------------------------------------------------------------

describe("F4: the page size asked for is the page size measured against", () => {
  it("does NOT mistake a full page for a short one when the caller pages at something other than 100", async () => {
    // A source with 120 rows, paged at 50. The old pagers compared 50 against a
    // module constant of 100, read the first FULL page as short, ended the walk on
    // page one and handed back 50 rows of 120 — as a complete read.
    const rows = Array.from({ length: 120 }, (_, i) => i);
    const seen: Array<[number, number]> = [];

    const read = await pageToCeiling(
      (page, perPage) => {
        seen.push([page, perPage]);
        return Promise.resolve(rows.slice((page - 1) * perPage, page * perPage));
      },
      50,
      10,
    );

    expect(read.rows).toHaveLength(120);
    expect(read.truncated).toBe(false);
    expect(seen).toEqual([
      [1, 50],
      [2, 50],
      [3, 50],
    ]);
  });

  it("hands `perPage` to the fetcher, so the request and the stop cannot disagree", async () => {
    const asked: number[] = [];
    await pageToCeiling(
      (_page, perPage) => {
        asked.push(perPage);
        return Promise.resolve([]);
      },
      37,
      5,
    );
    expect(asked).toEqual([37]);
  });

  it("reports truncated when it runs out of PAGES rather than out of rows", async () => {
    const read = await pageToCeiling(
      (page, perPage) => Promise.resolve(Array.from({ length: perPage }, (_, i) => page * 100 + i)),
      10,
      3,
    );
    expect(read.rows).toHaveLength(30);
    expect(read.truncated).toBe(true);
  });

  it("a zero-row source is a complete read, not a truncated one", async () => {
    const read = await pageToCeiling(() => Promise.resolve([]), 100, 5);
    expect(read).toEqual({ rows: [], truncated: false });
  });
});

// ---------------------------------------------------------------------------
// AND THE COPY IS THE ONLY COPY. A fourth bounded pager will not be written where
// the last two were, so this crawls src/ rather than a list of files.
// ---------------------------------------------------------------------------

describe("F4: exactly one bounded pager is declared in src/", () => {
  it("finds no second declaration of pageToCeiling or pageBounded", () => {
    // walkSrc, not a fourth hand-rolled crawl: it is rooted at THIS file's src/
    // rather than at process.cwd(), so a run started from the trunk cannot sweep a
    // worktree's copy and report a clean result about source it never read.
    const DECLARES =
      /(?:function\s+(?:pageToCeiling|pageBounded)\s*[<(]|(?:const|let|var)\s+(?:pageToCeiling|pageBounded)\s*[:=])/;
    const found = walkSrc().filter((rel) => DECLARES.test(readFileSync(srcPath(rel), "utf8")));

    expect(
      found,
      "a second bounded pager is back; two copies of one walk is how a short-page " +
        "stop and a page size come to disagree",
    ).toEqual(["lib/dentally/paging.ts"]);
  });
});

// ---------------------------------------------------------------------------
// THE meta.total GRAMMAR EXISTS TWICE ON PURPOSE, AND MAY NEVER DIVERGE.
//
// reports/scan.ts opens with `import "server-only"`, and dentally/read.ts is imported
// by thirty test files and by paths that do not carry that boundary — importing it
// there breaks them at module resolution. So the parser is co-located here, and this
// is the pin: both implementations are fed the same envelopes and must agree about
// every one of them.
// ---------------------------------------------------------------------------

describe("F4: the co-located meta.total parser cannot drift from the reports one", () => {
  const ENVELOPES: unknown[] = [
    { total: 0 },
    { total: 27_594 },
    { total: "585" },
    { total: "  585  " },
    { total: "5.5" },
    { total: -1 },
    { total: 1.5 },
    { total: Number.MAX_SAFE_INTEGER + 2 },
    { total: null },
    { total: undefined },
    { total: true },
    { current_page: 1 },
    {},
    [],
    [{ total: 3 }],
    null,
    undefined,
    "meta",
    42,
  ];

  it("answers identically for every envelope shape", () => {
    for (const meta of ENVELOPES) {
      expect(metaTotal(meta), `disagreed about ${JSON.stringify(meta) ?? String(meta)}`).toBe(
        reportsMetaTotal(meta),
      );
    }
  });

  it("and the answers are the ones the money paths depend on", () => {
    // Pinned outright, so "both wrong in the same way" cannot pass the test above.
    expect(metaTotal({ total: 585 })).toBe(585);
    expect(metaTotal({ total: "585" })).toBe(585);
    expect(metaTotal({ total: 0 })).toBe(0);
    expect(metaTotal({ total: -1 })).toBeNull();
    expect(metaTotal({ total: 1.5 })).toBeNull();
    expect(metaTotal({})).toBeNull();
    expect(metaTotal(null)).toBeNull();
  });
});
