// The step-event READ path: how the drop-off report pages a table that is being
// written to by an anonymous public endpoint while the report runs.
//
// The Supabase seam is faked rather than the repository mocked away, because the
// thing worth pinning here IS the query: which columns are selected, in which
// order the rows come back, and — the reason this file exists — that each page
// asks for "strictly older than the row I stopped at" rather than "skip the first
// N rows". Those two page the same way right up until somebody inserts a row
// mid-scan, at which point OFFSET silently drops one and keyset does not. A
// dropped row here is a session quietly missing from a step's tally, which is
// invisible in the answer and therefore has to be caught in a test.

import { describe, it, expect, beforeEach, vi } from "vitest";

interface Row {
  id: string;
  created_at: string;
  step_index: number;
  session_nonce: string;
}

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Forced error on the next query. */
  error: null as { code?: string; message?: string } | null,
  /** Every `or` filter string the repository built, in order. */
  filters: [] as string[],
  /** The select list, and the order() calls, from the last page. */
  selected: "",
  ordered: [] as Array<[string, boolean]>,
  /** Fires after each page is served — the seam for a concurrent insert. */
  onPage: null as ((pageIndex: number) => void) | null,
  pageCount: 0,
  /**
   * Bottomless mode: every page comes back full, so the scan runs into its own
   * ceiling. The only way to exercise MAX_SCAN_ROWS without materialising it.
   */
  bottomless: false,
}));

/** Newest first: created_at desc, then id desc. The order the repository asks for. */
function byNewest(a: Row, b: Row): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * Read back the keyset filter the repository wrote. Doubles as a syntax check: if
 * the filter string ever stops being the shape PostgREST would understand, this
 * fails to match and the test blows up rather than quietly passing.
 */
function applyKeyset(rows: Row[], filter: string): Row[] {
  const m = filter.match(
    /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/,
  );
  if (!m) throw new Error(`unrecognised keyset filter: ${filter}`);
  const [, ltTs, eqTs, ltId] = m;
  expect(ltTs).toBe(eqTs);
  return rows.filter((r) => r.created_at < ltTs! || (r.created_at === eqTs! && r.id < ltId!));
}

function fakeTable() {
  let or: string | null = null;
  let gte = "";
  let lte = "";
  const eqs: Array<[string, unknown]> = [];
  const api = {
    select: (cols: string) => {
      state.selected = cols;
      return api;
    },
    eq: (k: string, v: unknown) => {
      eqs.push([k, v]);
      return api;
    },
    gte: (_k: string, v: string) => {
      gte = v;
      return api;
    },
    lte: (_k: string, v: string) => {
      lte = v;
      return api;
    },
    or: (s: string) => {
      or = s;
      state.filters.push(s);
      return api;
    },
    order: (k: string, o: { ascending: boolean }) => {
      state.ordered.push([k, o.ascending]);
      return api;
    },
    /**
     * Deliberately present and deliberately fatal. OFFSET paging is the bug this
     * file exists to keep out; if it ever comes back, it fails loudly here rather
     * than passing every assertion until a row goes missing in production.
     */
    range: () => {
      throw new Error("OFFSET paging (.range) is not allowed on this read");
    },
    limit: async (n: number) => {
      if (state.error) return { data: null, error: state.error };
      const index = state.pageCount;
      state.pageCount += 1;

      let page: Row[];
      if (state.bottomless) {
        const base = index * n;
        page = Array.from({ length: n }, (_, i) => ({
          id: `id-${String(1_000_000 - base - i).padStart(8, "0")}`,
          created_at: `2026-08-16T00:00:00.000+00:00`,
          step_index: i % 4,
          session_nonce: `n-${base + i}`,
        }));
      } else {
        let rows = state.rows
          .filter((r) => eqs.every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v))
          .filter((r) => r.created_at >= gte && r.created_at <= lte)
          .sort(byNewest);
        if (or) rows = applyKeyset(rows, or);
        page = rows.slice(0, n);
      }

      state.onPage?.(index);
      return { data: page, error: null };
    },
  };
  return api;
}

vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ from: () => fakeTable() }) }));

import { POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";
import { SCAN_PAGE, readStepEvents, StepEventTableMissingError } from "./step-events-repository";

const FROM = "2026-01-01T00:00:00.000+00:00";
const TO = "2027-01-01T00:00:00.000+00:00";

function scan() {
  return readStepEvents({
    campaignId: "camp-1",
    flowVersion: 7,
    fromIso: FROM,
    toIso: TO,
  });
}

/**
 * n rows inside the window, all for the scanned campaign.
 *
 * TEN ROWS PER TIMESTAMP, on purpose: whole batches land inside one millisecond on
 * this table, which is exactly why the cursor cannot be created_at alone. If the
 * repository ever drops id from the cursor, the pages start overlapping here.
 */
function makeRows(n: number, prefix = "r"): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${prefix}-${String(n - i).padStart(6, "0")}`,
    created_at: new Date(Date.UTC(2026, 5, 1) + Math.floor(i / 10) * 1000).toISOString(),
    step_index: i % 5,
    session_nonce: `${prefix}-${i}`,
    campaign_id: "camp-1",
    flow_version: 7,
  })) as unknown as Row[];
}

/** n rows with a STRICTLY unique timestamp each, so the sort order cannot move. */
function makeUniqueRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-u-${String(i).padStart(6, "0")}`,
    // Descending: index 0 is the newest, so index k is the (k+1)th row read.
    created_at: new Date(Date.UTC(2026, 5, 1) - i * 1000).toISOString(),
    step_index: i % 5,
    session_nonce: `u-${i}`,
    campaign_id: "camp-1",
    flow_version: 7,
  })) as unknown as Row[];
}

/** The (created_at, id) pair a keyset filter string is carrying. */
function cursorIn(filter: string): [string, string] {
  const m = filter.match(/^created_at\.lt\."([^"]+)",and\(created_at\.eq\."[^"]+",id\.lt\."([^"]+)"\)$/);
  if (!m) throw new Error(`unrecognised keyset filter: ${filter}`);
  return [m[1]!, m[2]!];
}

beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.filters = [];
  state.selected = "";
  state.ordered = [];
  state.onPage = null;
  state.pageCount = 0;
  state.bottomless = false;
});

describe("readStepEvents, the query it builds", () => {
  it("selects the cursor columns as well as the tally columns", async () => {
    state.rows = makeRows(3);
    await scan();
    // id and created_at are read for the cursor. Both are KEY columns of 0080's
    // read-path index — its last two — so this select is still an index-only scan
    // AND the ORDER BY below needs no sort, which is why id is in the key rather
    // than merely in the INCLUDE list.
    expect(state.selected).toBe("id, created_at, step_index, session_nonce");
  });

  it("reads newest first, by created_at then id", async () => {
    state.rows = makeRows(3);
    await scan();
    expect(state.ordered).toEqual([
      ["created_at", false],
      ["id", false],
    ]);
  });

  it("asks for no keyset filter on the first page", async () => {
    state.rows = makeRows(3);
    await scan();
    expect(state.filters).toEqual([]);
  });
});

describe("readStepEvents, paging", () => {
  it("returns a short first page without asking again", async () => {
    state.rows = makeRows(12);
    const out = await scan();
    expect(out.rows).toHaveLength(12);
    expect(out.truncated).toBe(false);
    expect(state.pageCount).toBe(1);
  });

  it("walks several full pages and returns every row exactly once", async () => {
    state.rows = makeRows(2500);
    const out = await scan();

    expect(out.rows).toHaveLength(2500);
    expect(out.truncated).toBe(false);
    expect(new Set(out.rows.map((r) => r.nonce)).size).toBe(2500);
    expect(state.pageCount).toBe(3);
  });

  it("carries a (created_at, id) cursor, not an offset", async () => {
    state.rows = makeRows(2500);
    await scan();

    expect(state.filters).toHaveLength(2);

    const [ts1, id1] = cursorIn(state.filters[0]!);
    const [ts2, id2] = cursorIn(state.filters[1]!);
    // The cursor is the LAST row of the page before it, so page 3's cursor must
    // name a strictly OLDER row than page 2's — which is what makes the walk
    // monotonic no matter what is being inserted underneath it.
    expect(ts2 < ts1 || (ts2 === ts1 && id2 < id1)).toBe(true);

    // And it is the real boundary row, not an approximation of one. Indexed off
    // SCAN_PAGE rather than off a literal: the width moved once already (W3/32
    // took it off the PostgREST ceiling) and a hard-coded 999/1999 here would go
    // red for the page size rather than for the cursor this test is about.
    const sorted = [...state.rows].sort(byNewest);
    expect([ts1, id1]).toEqual([sorted[SCAN_PAGE - 1]!.created_at, sorted[SCAN_PAGE - 1]!.id]);
    expect([ts2, id2]).toEqual([sorted[2 * SCAN_PAGE - 1]!.created_at, sorted[2 * SCAN_PAGE - 1]!.id]);
  });

  it("never skips a row when the table is written to mid-scan", async () => {
    // THE POINT OF THE REWRITE. A row inserted while the report is running shifts
    // every later OFFSET page down by one, so exactly one row is read twice and
    // exactly one is never read at all. The dropped one is a session missing from
    // a step's tally, and nothing in the answer would say so.
    const original = makeRows(2500);
    state.rows = [...original];
    state.onPage = (i) => {
      if (i !== 0) return;
      // A brand-new event: newer than anything already in the table, so under
      // OFFSET paging it lands at the very top and pushes every page boundary.
      state.rows.unshift({
        id: "id-live-999999",
        created_at: new Date(Date.UTC(2026, 11, 1)).toISOString(),
        step_index: 0,
        session_nonce: "arrived-mid-scan",
        campaign_id: "camp-1",
        flow_version: 7,
      } as unknown as Row);
    };

    const out = await scan();
    const got = out.rows.map((r) => r.nonce);

    // Every row that existed when the scan started is present, exactly once.
    expect(new Set(got).size).toBe(got.length);
    for (const r of original) expect(got).toContain(r.session_nonce);
    // And the late arrival is simply not in this window's answer, which is the
    // honest outcome: it was not there when the question was asked.
    expect(got).not.toContain("arrived-mid-scan");
  });

  it("stops at its ceiling and SAYS the tally is partial", async () => {
    state.bottomless = true;
    const out = await scan();

    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(200_000);
    // The ceiling is read in WHOLE pages plus whatever remainder is left, so the
    // count follows the page width rather than a memorised 200.
    expect(state.pageCount).toBe(Math.ceil(200_000 / SCAN_PAGE));
  });

  it("stops rather than paging on a cursor it cannot safely quote", async () => {
    // Unique timestamps here so the boundary row stays the boundary row even after
    // its id is rewritten.
    const rows = makeUniqueRows(2000);
    // A value that could break out of the quoting in the filter string. It cannot
    // come from this table in practice; the guard is what makes that a fact rather
    // than an assumption.
    rows[SCAN_PAGE - 1]!.id = 'id-"; drop';
    state.rows = rows;

    const out = await scan();
    expect(out.rows).toHaveLength(SCAN_PAGE);
    expect(out.truncated).toBe(true);
    expect(state.pageCount).toBe(1);
  });

  // W3/32, and the reason the width is 999 rather than the round number it reads
  // like. PostgREST clips every response at POSTGREST_MAX_ROWS silently — no error,
  // nothing on the response — and this scan's only end-of-data signal is a page
  // that comes back shorter than it asked for. At exactly the ceiling those two are
  // the same observation, so a clipped FIRST page would end the scan and the report
  // would print a fraction of the funnel with `truncated: false` on it. The
  // tree-wide sweep for this shape lives in src/lib/offset-paging-ceiling.test.ts;
  // this is the module's own copy, next to the loop it is about.
  //
  // MUTATION: set SCAN_PAGE back to 1000 in step-events-repository.ts.
  it("asks for one row LESS than the server will hand back, so a clip is visible", () => {
    expect(SCAN_PAGE).toBeLessThan(POSTGREST_MAX_ROWS);
  });
});

describe("readStepEvents, when 0080 has not been applied", () => {
  it.each([
    ["42P01", "undefined_table"],
    ["PGRST205", "not found in the schema cache"],
  ])("names the migration for %s", async (code) => {
    state.error = { code, message: "whatever" };
    await expect(scan()).rejects.toBeInstanceOf(StepEventTableMissingError);
  });

  it("names the migration from the message alone when there is no code", async () => {
    state.error = { message: 'relation "public.assessment_step_event" does not exist' };
    await expect(scan()).rejects.toBeInstanceOf(StepEventTableMissingError);
  });

  it("rethrows anything else untouched, so a real fault is not misreported", async () => {
    state.error = { code: "57014", message: "canceling statement due to statement timeout" };
    await expect(scan()).rejects.not.toBeInstanceOf(StepEventTableMissingError);
  });
});
