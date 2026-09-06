// ===========================================================================
// EVERY PAGED READ WHOSE "WE ARE DONE" SIGNAL IS A SHORT PAGE.
//
// WHAT IS BEING PINNED (programme ruling W3/32). Supabase clips every REST
// response at a server-side max-rows ceiling — measured on this project at
// POSTGREST_MAX_ROWS, silently: no error, nothing on the response to read. A
// family of repository reads in this tree walks a table in pages and stops when a
// page comes back SHORTER than the page it asked for. At a page width of exactly
// the ceiling a CLIPPED page and a FINAL page are the same observation, so the day
// the server's cap is anything below the page size, the first page reads as the
// last one and the read returns a truncated set that claims to be complete. Every
// one of them fails OPEN when it does: an incomplete overlay makes suppressed
// tasks reappear as open, a short recall-key set makes reactivation double-chase
// patients recall still owns, a short opportunity list makes the coordinator's
// retire step retire opportunities that are still live, and a short month of clock
// events understates somebody's hours and therefore their pay.
//
// TWO GUARDS, BECAUSE ONE OF THEM CANNOT SEE THE WHOLE TREE.
//
// 1. THE DRIVEN READS. Each read below is run against the shared fake — the one
//    that MODELS the ceiling — with more rows than a single page holds, and the
//    test reads back the widths the loop actually asked for. The property is
//    asserted on the REQUEST, which is where it is real: a tally-only assertion
//    could not tell 999 from 1000, since at today's ceiling both return every row,
//    which is exactly how the constants came to sit on it in four separate modules
//    without a single test going red.
//
// 2. THE CRAWL, WHICH IS WHY THIS FILE NO LONGER NAMES A COUNT. The first version
//    of this pin opened by asserting that THREE reads in this tree had the shape.
//    That was a hand-written list and it was wrong — `collectPages` in
//    src/lib/hours/paging.ts and the step-event scan in
//    src/lib/smile-assessment/step-events-repository.ts had the identical shape and
//    the identical constant, and a hand list cannot go red when a sixth is added.
//    So the enumeration is now a SWEEP of src/ for any row-count constant sitting
//    exactly on the ceiling, against a ledger where every survivor is named and
//    carries the sentence that makes it safe. A new one is a red test, not a
//    finder's lucky afternoon.
//
// The keyset cursor in the step-event scan is worth calling out, because it looks
// like an answer to this and is not: a cursor stops concurrent inserts shifting an
// offset walk, and does nothing whatsoever about the ceiling. The end-of-data
// signal is still a short page.
// ===========================================================================
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import { createFakeSupabase, POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";
import { srcPath, walkSrc } from "@/lib/test-support/walk-src";

const world = createFakeSupabase();
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.client }));

import { getOverlayMap } from "@/lib/task-queue/repository";
import { listOpenRecallPatientKeys } from "@/lib/recall/repository";
import { listOpportunities } from "@/lib/coordinator/repository";
import { listAllEvents } from "@/lib/clock/repository";

/** One and a bit pages, so the loop has to ask twice and the width is checkable. */
const ROWS = POSTGREST_MAX_ROWS + 250;

function ids(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(6, "0")}`);
}

/**
 * Every page width this read asked for, on one table.
 *
 * A `null` here is a select that set NEITHER .limit() nor .range() — the
 * unbounded read POSTGREST_MAX_ROWS exists to catch — so it fails the assertion
 * below rather than passing it by asking for nothing.
 */
function widths(table: string): Array<number | null> {
  return world.db.reads.filter((r) => r.table === table).map((r) => r.asked);
}

function expectEveryPageUnderTheCeiling(table: string): void {
  const asked = widths(table);
  expect(asked.length, `${table} was never read`).toBeGreaterThan(1);
  for (const n of asked) {
    expect(n, `${table} was read with no row bound at all`).not.toBeNull();
    expect(
      n as number,
      `${table} asked for ${n} rows, at or above the ${POSTGREST_MAX_ROWS}-row ceiling: a clipped page would read as the last one`,
    ).toBeLessThan(POSTGREST_MAX_ROWS);
  }
}

beforeEach(() => {
  world.reset();
});

describe("every paged read asks for less than the server will hand back (W3/32)", () => {
  // MUTATION: put PAGE back to 1000 in src/lib/task-queue/repository.ts. The map
  // is still complete against today's ceiling and nothing else goes red.
  it("the task overlay pages to exhaustion, one row under the ceiling", async () => {
    world.seed(
      "task_overlay",
      ...ids(ROWS, "task").map((task_key) => ({
        client_id: "vitality",
        task_key,
        status: "done",
        assignee: null,
        snoozed_until: null,
        note: null,
      })),
    );

    const map = await getOverlayMap("vitality");
    expect(map.size, "the overlay came back short, so suppressed tasks would reappear").toBe(ROWS);
    expectEveryPageUnderTheCeiling("task_overlay");
  });

  // MUTATION: put PAGE back to 1000 in src/lib/recall/repository.ts.
  it("the open-recall key set pages to exhaustion, one row under the ceiling", async () => {
    world.seed(
      "recall_target",
      ...ids(ROWS, "pat").map((dentally_patient_id) => ({
        site_id: "site-cc",
        dentally_patient_id,
        status: "due",
      })),
    );

    const keys = await listOpenRecallPatientKeys(["site-cc"]);
    expect(keys.size, "a short key set makes reactivation double-chase recall's patients").toBe(ROWS);
    expectEveryPageUnderTheCeiling("recall_target");
  });

  // MUTATION: put PAGE back to 1000 in src/lib/coordinator/repository.ts.
  it("the opportunity list pages to exhaustion, one row under the ceiling", async () => {
    world.seed(
      "treatment_opportunity",
      // No client_id: treatment_opportunity is scoped by site_id alone and has no
      // such column (the key was copied from the task_overlay seed above). Live
      // would answer PGRST204 and write nothing; fake-supabase now says so too.
      ...ids(ROWS, "opp").map((id, i) => ({
        id,
        site_id: "site-cc",
        dentally_patient_id: `p-${i}`,
        status: "open",
        priority_score: i,
      })),
    );

    const rows = await listOpportunities({ siteIds: ["site-cc"] });
    expect(rows.length, "a short list makes the retire step retire live opportunities").toBe(ROWS);
    expectEveryPageUnderTheCeiling("treatment_opportunity");
  });

  // THE FOURTH, MISSED BY THIS FILE'S FIRST VERSION AND FOUND BY THE ROUND-2 REVIEW.
  // /api/hours/month passes no pageSize, so DEFAULT_PAGE_SIZE applies, and it was
  // 1000 — the whole width of the ceiling, on the one read in the tree whose short
  // answer is a short PAYSLIP.
  //
  // MUTATION: put DEFAULT_PAGE_SIZE back to 1000 in src/lib/hours/paging.ts.
  it("a month of clock events pages to exhaustion, one row under the ceiling", async () => {
    const day = (i: number) => new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + i * 60_000).toISOString();
    world.seed(
      "staff_clock_event",
      ...ids(ROWS, "evt").map((id, i) => ({
        id,
        client_id: "vitality",
        site_id: "site-cc",
        staff_id: `staff-${i % 30}`,
        kind: i % 2 === 0 ? "in" : "out",
        occurred_at: day(i),
        source: "kiosk",
        recorded_by: null,
        note: null,
        created_at: day(i),
      })),
    );

    const out = await listAllEvents("vitality", {
      fromIso: "2026-07-01T00:00:00.000Z",
      toIso: "2026-07-31T23:59:59.999Z",
    });
    expect(out.ready).toBe(true);
    expect(
      out.events.length,
      "a short month understates everybody's hours, and therefore their pay",
    ).toBe(ROWS);
    // And it does NOT wear a complete month's clothes while short.
    expect(out.truncated).toBe(false);
    expectEveryPageUnderTheCeiling("staff_clock_event");
  });
});

// ---------------------------------------------------------------------------
// THE CRAWL.
// ---------------------------------------------------------------------------

/**
 * A row-count constant sitting exactly on the ceiling, wherever it is declared.
 *
 * Two shapes, because both have shipped here: a named constant
 * (`const SCAN_PAGE = 1000`) and a bare literal in the query itself
 * (`.limit(1000)`). The literal form has no ledger at all — a paged read that
 * hard-codes the ceiling inline is never the right answer, so it simply fails.
 */
const CONST_ON_THE_CEILING =
  /(?:^|[\n;])[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?::[ \t]*number[ \t]*)?=[ \t]*(?:1000|1_000)\b/g;

const INLINE_ON_THE_CEILING = /\.limit\(\s*(?:1000|1_000)\s*\)/g;

/**
 * Which constants are ABOUT ROWS.
 *
 * 1000 is a popular number: it is also a character cap on a free-text field
 * (MAX_REASON, MAX_ANSWER_DETAIL, MAX_MESSAGE) and a pounds threshold
 * (HIGH_VALUE_OUTSTANDING), and dragging those into a paging ledger would make it
 * long enough that nobody reads it. So the sweep matches on the name carrying a
 * row-count WORD — PAGE, ROWS, BATCH, SCAN, CHUNK, WINDOW — which is what every
 * instance found so far has been called.
 */
const ROW_COUNT_NAME = /(?:^|_)(?:PAGE|PAGES|ROWS|BATCH|SCAN|CHUNK|WINDOW)(?:_|$)/;

/**
 * Source with comments stripped: what a file DOES, not what it explains.
 *
 * Needed because the thing being swept for is also the thing worth WRITING ABOUT —
 * this very file, and both constants it moved, carry paragraphs quoting the old
 * `= 1000` declaration, and a raw scan would read those explanations as offences.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

interface Sighting {
  file: string;
  name: string;
}

function sweep(): Sighting[] {
  const out: Sighting[] = [];
  for (const file of walkSrc()) {
    const code = codeOnly(readFileSync(srcPath(file), "utf8"));
    for (const m of code.matchAll(CONST_ON_THE_CEILING)) {
      const name = m[1];
      if (ROW_COUNT_NAME.test(name)) out.push({ file, name });
    }
  }
  return out.sort((a, b) => `${a.file} ${a.name}`.localeCompare(`${b.file} ${b.name}`));
}

/**
 * THE LEDGER: every row-count constant allowed to equal the ceiling, and why.
 *
 * A new entry is a DECISION, not a formality. The question it has to answer is
 * narrow: does anything treat "this page came back shorter than I asked for" as
 * proof that the data ran out? If it does, the constant is wrong at 1000 and no
 * sentence here can rescue it — move it to 999, or page by rows-returned. The
 * entries below are the reads for which the answer is genuinely no.
 */
const ALLOWED: ReadonlyArray<Sighting & { because: string }> = [
  {
    file: "app/api/sync/reactivation/route.ts",
    name: "ENROL_WINDOW",
    because:
      "ONE bounded read, not a loop: the enrol pass deliberately reads a WINDOW of the " +
      "newest-lapsed worklist (its own comment) and never claims to have seen the book. A " +
      "clip at the ceiling returns exactly the window it asked for, and the only figure " +
      "derived from it is the 'widen ENROL_WINDOW' warning, which fires on a FULL window.",
  },
  {
    file: "lib/meta-ads/apify.ts",
    name: "APIFY_PAGE_LIMIT",
    because:
      "Not a Supabase read at all — Apify's dataset-items REST API, whose own documented " +
      "per-page cap is this same number (the module's comment says so). W3/32 is about " +
      "POSTGREST_MAX_ROWS; this constant is calibrated against a different server.",
  },
  {
    file: "lib/patient-status/repository.ts",
    name: "OVERRIDE_PAGE",
    because:
      "The one loop in the tree that is INDEPENDENT of the ceiling's value: readAllOverridePages " +
      "advances by the number of rows ACTUALLY RETURNED and stops only on an EMPTY page, so a " +
      "clipped page is just a smaller step. Its header explains exactly this, and calls a " +
      "'short page means the end' loop 'the exact bug, wearing the fix's clothes'.",
  },
  {
    file: "lib/speed-to-lead/repository.ts",
    name: "MAX_BATCH_ATTEMPTS",
    because:
      "ONE bounded read with no loop behind it: listAttemptsForLeads caps a batch of at most " +
      "MAX_BATCH_IDS (200) leads at a thousand attempt rows. There is no second page to decide " +
      "about, and nothing counts the result as a total — the co-pilot summarises attempts per " +
      "lead. A clip at the ceiling is the limit it already asked for.",
  },
  {
    file: "lib/test-support/fake-supabase.ts",
    name: "POSTGREST_MAX_ROWS",
    because: "The ceiling ITSELF, measured on this project. Everything above is defined against it.",
  },
];

describe("no row-count constant sits on the PostgREST ceiling unledgered (W3/32)", () => {
  // MUTATION: put SCAN_PAGE back to 1000 in
  // src/lib/smile-assessment/step-events-repository.ts, or DEFAULT_PAGE_SIZE back to
  // 1000 in src/lib/hours/paging.ts. Either one appears here as an unledgered
  // sighting; neither reddens anything else.
  it("every row-count constant equal to the ceiling is one the ledger names", () => {
    const ledgered = new Set(ALLOWED.map((a) => `${a.file} ${a.name}`));
    const strays = sweep().filter((s) => !ledgered.has(`${s.file} ${s.name}`));
    expect(
      strays.map((s) => `${s.file}: ${s.name}`),
      "a row-count constant equal to POSTGREST_MAX_ROWS: if anything treats a short page as " +
        "end-of-data it must be 999 (or page by rows-returned); if not, add it to ALLOWED with " +
        "the sentence that makes it safe",
    ).toEqual([]);
  });

  // A ledger entry that no longer matches anything is a claim about code that has
  // moved on, and it would silently permit a NEW constant of the same name in the
  // same file. Stale citations go red here rather than rotting.
  it("every ledger entry still points at a constant that exists", () => {
    const seen = new Set(sweep().map((s) => `${s.file} ${s.name}`));
    const stale = ALLOWED.filter((a) => !seen.has(`${a.file} ${a.name}`)).map((a) => `${a.file}: ${a.name}`);
    expect(stale, "ALLOWED cites a constant the sweep no longer finds; delete the entry").toEqual([]);
  });

  it("every ledger entry says why, in a sentence and not a shrug", () => {
    for (const a of ALLOWED) {
      expect(a.because.length, `${a.file}: ${a.name} has no reason recorded`).toBeGreaterThan(80);
    }
  });

  // MUTATION: add `.limit(1000)` to any select in src/ (outside a test) — it lands
  // here with no ledger to hide in, which is the point: a paged read that hard-codes
  // the ceiling inline has skipped the decision entirely.
  it("no select hard-codes the ceiling as a bare literal", () => {
    const hits: string[] = [];
    for (const file of walkSrc()) {
      const code = codeOnly(readFileSync(srcPath(file), "utf8"));
      if (INLINE_ON_THE_CEILING.test(code)) hits.push(file);
      INLINE_ON_THE_CEILING.lastIndex = 0;
    }
    expect(hits, "give it a named constant under the ceiling; a bare .limit(1000) is a clip waiting to happen").toEqual(
      [],
    );
  });

  // The sweep itself is invisible in a green result: a walk that found nothing and a
  // tree that is clean look identical. So it is checked against something it MUST
  // find — the ceiling constant every other assertion here is defined against.
  it("the sweep actually reads the tree", () => {
    const seen = sweep();
    expect(seen.length, "the sweep found no row-count constants at all, so it is reading nothing").toBeGreaterThan(3);
    expect(seen.map((s) => `${s.file} ${s.name}`)).toContain("lib/test-support/fake-supabase.ts POSTGREST_MAX_ROWS");
  });
});
