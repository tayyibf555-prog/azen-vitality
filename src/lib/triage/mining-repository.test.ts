import { describe, it, expect, beforeEach, vi } from "vitest";

// ===========================================================================
// THE COVERAGE ROW SURVIVES A DATABASE THAT IS ONE MIGRATION BEHIND.
//
// `previsit_mining_scan.excluded_unreadable` arrives in migration 0101, and
// migrations in this platform are applied BY HAND — a lane writes the file, an
// integrator applies it. So this repository runs against two shapes of database
// and has to be right on both, and the direction of the failure is what makes it
// worth a suite of its own:
//
//   A PostgREST select NAMES ITS COLUMNS. Asking for one that does not exist
//   fails the WHOLE read with 42703 — it does not return the row without that
//   field. The coverage row is what puts the window ("Built from appointments
//   between 6 August and 4 September") and the exclusion sentence on the screen,
//   so a failed read takes the provenance off a list of named patients and leaves
//   the list: fail OPEN, the one direction this platform does not accept.
//
//   AND THE WRITE IS A WHOLE RUN'S WORK. `recordScanRun` is the only thing that
//   banks the days a nightly scan has read. A refused write (PGRST204) would
//   throw away the night AND leave coverage where it was, so the next run reads
//   the same days again, for ever.
//
// So both re-try in the older shape, and the missing figure is reported as NULL —
// "we do not know" — never as the zero that would be a claim (charter §0/5).
// ===========================================================================

vi.mock("server-only", () => ({}));

interface Row extends Record<string, unknown> {
  site_id: string;
}

const db = {
  /** Rows, as the table holds them. */
  rows: [] as Row[],
  /** True while the database is one migration behind: no excluded_unreadable. */
  columnMissing: true,
  /** Every select's column list, in order — the read half of the contract. */
  selects: [] as string[],
  /** Every upsert payload the repository actually sent. */
  writes: [] as Record<string, unknown>[],
  /** A failure that is NOT "the column is missing" — a permission error, say. */
  hardError: null as null | { code: string; message: string },
  reset() {
    this.rows = [];
    this.columnMissing = true;
    this.selects = [];
    this.writes = [];
    this.hardError = null;
  },
};

const MISSING_ON_READ = { code: "42703", message: 'column previsit_mining_scan.excluded_unreadable does not exist' };
const MISSING_ON_WRITE = { code: "PGRST204", message: "Could not find the 'excluded_unreadable' column" };

function project(row: Row, columns: string): Row {
  const wanted = columns.split(",").map((c) => c.trim());
  const out: Row = { site_id: row.site_id };
  for (const c of wanted) if (c in row) out[c] = row[c];
  return out;
}

function selectBuilder(columns: string) {
  db.selects.push(columns);
  const asks = columns.includes("excluded_unreadable");
  let sites: string[] = [];
  const result = (single: boolean) => {
    if (db.hardError) return { data: null, error: db.hardError };
    if (asks && db.columnMissing) return { data: null, error: MISSING_ON_READ };
    const matched = db.rows.filter((r) => sites.includes(r.site_id)).map((r) => project(r, columns));
    return { data: single ? matched[0] ?? null : matched, error: null };
  };
  const api = {
    eq(_col: string, value: string) {
      sites = [value];
      return api;
    },
    in(_col: string, values: string[]) {
      sites = values;
      return api;
    },
    maybeSingle: async () => result(true),
    then<T>(onfulfilled?: (v: ReturnType<typeof result>) => T, onrejected?: (r: unknown) => T) {
      return Promise.resolve(result(false)).then(onfulfilled, onrejected);
    },
  };
  return api;
}

const client = {
  from(table: string) {
    expect(table).toBe("previsit_mining_scan");
    return {
      select: (columns: string) => selectBuilder(columns),
      upsert: async (row: Record<string, unknown>) => {
        db.writes.push(row);
        if ("excluded_unreadable" in row && db.columnMissing) return { error: MISSING_ON_WRITE };
        const at = db.rows.findIndex((r) => r.site_id === row.site_id);
        if (at >= 0) db.rows[at] = row as Row;
        else db.rows.push(row as Row);
        return { error: null };
      },
    };
  },
};

vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => client }));

const { getCoverage, listCoverage, recordScanRun } = await import("./mining-repository");

function seed(over: Partial<Row> = {}): void {
  db.rows.push({
    site_id: "site-cc",
    covered_from: "2026-08-06",
    covered_to: "2026-09-04",
    examined: 120,
    candidates: 41,
    excluded_no_dob: 3,
    excluded_under_age: 1,
    last_run_at: "2026-09-04T02:20:00.000Z",
    more_to_read: true,
    ...over,
  });
}

const RUN = {
  siteId: "site-cc",
  coveredFrom: "2026-07-07",
  coveredTo: "2026-09-04",
  examined: 10,
  candidates: 2,
  excludedNoDob: 1,
  excludedUnderAge: 0,
  excludedUnreadable: 4,
  moreToRead: true,
  now: "2026-09-05T02:20:00.000Z",
};

beforeEach(() => db.reset());

describe("reading the coverage row before migration 0101 is applied", () => {
  it("asks for the new column, and re-reads without it rather than losing the row", () => {
    // The whole point: a 42703 here would take the provenance sentence off the
    // screen and leave the list of names under it.
    seed();
    return listCoverage(["site-cc"]).then((rows) => {
      expect(rows).toHaveLength(1);
      expect(db.selects[0]).toContain("excluded_unreadable");
      expect(db.selects[1], "no second read in the older shape").not.toContain("excluded_unreadable");
      expect(rows[0].coveredFrom).toBe("2026-08-06");
      expect(rows[0].excludedNoDob).toBe(3);
    });
  });

  it("reports the figure it cannot read as NULL, never as zero", async () => {
    // Zero is a claim: "nobody was unreadable". Null is the truth: the scan
    // counted them and had nowhere to put the number.
    seed();
    const rows = await listCoverage(["site-cc"]);
    expect(rows[0].excludedUnreadable).toBeNull();
  });

  it("does the same for one site's row", async () => {
    seed();
    const row = await getCoverage("site-cc");
    expect(row?.excludedUnreadable).toBeNull();
    expect(row?.candidates).toBe(41);
  });

  it("reads the figure once the column is there, in ONE round trip", async () => {
    db.columnMissing = false;
    seed({ excluded_unreadable: 7 });
    const rows = await listCoverage(["site-cc"]);
    expect(rows[0].excludedUnreadable).toBe(7);
    expect(db.selects).toHaveLength(1);
  });

  it("throws a real read failure rather than retrying into a narrower answer", async () => {
    // Only "the column is not there" is retried. A permission error or a dead
    // table must surface as the failure it is — the page's own `.catch` turns it
    // into "the dates could not be read just now", which is the honest sentence.
    const boom = { code: "42501", message: "permission denied" };
    const only = {
      from: () => ({
        select: () => ({
          in: () => ({ then: (f: (v: unknown) => unknown) => Promise.resolve({ data: null, error: boom }).then(f) }),
        }),
      }),
    };
    const mod = await import("@/lib/supabase/server");
    const spy = vi.spyOn(mod, "serviceClient").mockReturnValue(only as never);
    // The error itself, not merely "something threw": a TypeError from a broken
    // double would satisfy a bare rejects and prove nothing.
    await expect(listCoverage(["site-cc"])).rejects.toMatchObject({ code: "42501" });
    spy.mockRestore();
  });

  it("does not re-read at all on a failure that is NOT the missing column", async () => {
    // The retry is for one thing. A permission error or a dead table retried into
    // the older shape costs a second round trip on every page load of a practice
    // whose database is unhappy, and answers exactly the same way — so the guard
    // is on the code, not on "did it fail".
    db.hardError = { code: "42501", message: "permission denied" };
    await expect(listCoverage(["site-cc"])).rejects.toMatchObject({ code: "42501" });
    expect(db.selects, "a real failure was retried in the older shape").toHaveLength(1);
  });

  it("an empty scope reads nothing at all", async () => {
    expect(await listCoverage([])).toEqual([]);
    expect(db.selects).toHaveLength(0);
  });
});

describe("recording a run never loses a night to a column that is not there yet", () => {
  it("writes the new figure first, then the same row without it", async () => {
    await recordScanRun(RUN);
    expect(db.writes).toHaveLength(2);
    expect(db.writes[0]).toHaveProperty("excluded_unreadable", 4);
    expect(db.writes[1], "the retry smuggled the column back in").not.toHaveProperty("excluded_unreadable");
    // AND THE RUN LANDED. The days read and the candidates are what the screen
    // depends on, and they must be banked either way.
    expect(db.rows[0]).toMatchObject({ covered_from: "2026-07-07", examined: 10, candidates: 2 });
  });

  it("writes it once, with no retry, when the column exists", async () => {
    db.columnMissing = false;
    await recordScanRun(RUN);
    expect(db.writes).toHaveLength(1);
    expect(db.rows[0]).toHaveProperty("excluded_unreadable", 4);
  });

  it("ADDS the figure to what is already there, like every other counter", async () => {
    // Coverage is everything read so far, and reading cannot be undone.
    db.columnMissing = false;
    seed({ excluded_unreadable: 5, covered_from: "2026-08-06" });
    await recordScanRun(RUN);
    expect(db.rows[0]).toMatchObject({
      excluded_unreadable: 9,
      excluded_no_dob: 4,
      examined: 130,
      candidates: 43,
    });
  });

  it("counts from zero when the column has only just been added", async () => {
    // The row predates 0101, so the existing value reads as null. Null + 4 is 4,
    // not NaN, and not a write that fails a not-null constraint.
    seed();
    db.columnMissing = false;
    await recordScanRun(RUN);
    expect(db.rows[0]).toHaveProperty("excluded_unreadable", 4);
  });

  it("still only ever widens the window", async () => {
    // The property the rest of this repository is shaped around, re-checked
    // through the retry path: a run that read less must not shrink a claim the
    // practice has already been shown.
    seed({ covered_from: "2026-01-01", covered_to: "2026-09-04" });
    await recordScanRun({ ...RUN, coveredFrom: "2026-07-07", coveredTo: "2026-08-01" });
    expect(db.rows[0]).toMatchObject({ covered_from: "2026-01-01", covered_to: "2026-09-04" });
  });

  it("throws a real write failure rather than swallowing it", async () => {
    const boom = { code: "42501", message: "permission denied" };
    const only = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        upsert: async () => ({ error: boom }),
      }),
    };
    const mod = await import("@/lib/supabase/server");
    const spy = vi.spyOn(mod, "serviceClient").mockReturnValue(only as never);
    await expect(recordScanRun(RUN)).rejects.toMatchObject({ code: "42501" });
    spy.mockRestore();
  });
});
