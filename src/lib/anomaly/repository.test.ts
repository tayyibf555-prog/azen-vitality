import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// ===========================================================================
// THE READS, AGAINST AN IN-MEMORY DATABASE RATHER THAN A MOCK.
//
// The queries are the thing that can break here — a forgotten site filter, a
// missing status filter, a `not_before_at` clause dropped from a table that
// needs it — and a mocked query cannot break. So the real repository runs
// against a small in-memory Postgres stand-in, the same approach the closer's
// approval-repository test takes.
//
// Three properties matter most and each has its own block:
//   1. A FAILED read returns null, never an empty reading. Zero stuck messages
//      and an unreadable outbox must not look the same to the detectors.
//   2. A CAPPED read reports `truncated`, so the alert says "at least".
//   3. A row held back on purpose (quiet hours, an overnight post-op timing) is
//      WAITING, not stuck, and only the three tables that carry the column are
//      queried for it.
// ===========================================================================

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
/** Tables whose every read should throw, to exercise the failure branches. */
const broken = new Set<string>();

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private cmps: Array<[string, "lt" | "lte" | "gte", string]> = [];
  private isNulls: string[] = [];
  private cols: string[] | null = null;
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;

  constructor(private table: string) {}

  private rows(): Row[] {
    return (db[this.table] ??= []);
  }

  private matches(r: Row): boolean {
    for (const [c, v] of this.eqs) if (r[c] !== v) return false;
    for (const [c, vals] of this.ins) if (!vals.includes(r[c])) return false;
    for (const c of this.isNulls) if (r[c] !== null && r[c] !== undefined) return false;
    for (const [c, op, v] of this.cmps) {
      const cell = r[c];
      // Postgres: a comparison against NULL is never true. Selecting a column a
      // table does not have would be an error, which is what `broken` models.
      if (typeof cell !== "string") return false;
      if (op === "lt" && !(cell < v)) return false;
      if (op === "lte" && !(cell <= v)) return false;
      if (op === "gte" && !(cell >= v)) return false;
    }
    return true;
  }

  select(cols?: string) {
    // "*" is every column, exactly as PostgREST reads it.
    this.cols = cols && cols.trim() !== "*" ? cols.split(",").map((c) => c.trim()) : null;
    return this;
  }
  eq(col: string, val: unknown) {
    this.eqs.push([col, val]);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.ins.push([col, vals]);
    return this;
  }
  is(col: string, _val: null) {
    this.isNulls.push(col);
    return this;
  }
  lt(col: string, val: string) {
    this.cmps.push([col, "lt", val]);
    return this;
  }
  lte(col: string, val: string) {
    this.cmps.push([col, "lte", val]);
    return this;
  }
  gte(col: string, val: string) {
    this.cmps.push([col, "gte", val]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  insert(row: Row) {
    this.mode = "insert";
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.payload = patch;
    return this;
  }

  private run(): { data: unknown; error: unknown } {
    if (broken.has(this.table)) return { data: null, error: { message: `relation ${this.table} exploded` } };

    const rows = this.rows();
    if (this.mode === "insert") {
      const row: Row = { id: `id-${rows.length + 1}`, ...(this.payload ?? {}) };
      // Emulate the unique (client_id, dedupe_key) constraint.
      const clash = rows.find(
        (r) => r.client_id === row.client_id && r.dedupe_key === row.dedupe_key,
      );
      if (clash) return { data: null, error: { message: "duplicate key" } };
      rows.push(row);
      return { data: [row], error: null };
    }
    if (this.mode === "update") {
      const hit = rows.filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.payload);
      return { data: hit, error: null };
    }

    let out = rows.filter((r) => this.matches(r));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) =>
        String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0,
      );
    }
    if (this.max !== null) out = out.slice(0, this.max);
    const projected = this.cols
      ? out.map((r) => Object.fromEntries(this.cols!.map((c) => [c, r[c]])))
      : out;
    return { data: projected, error: null };
  }

  then<R1, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ from: (table: string) => new Query(table) }),
}));

import { DRAIN_SOURCE_TO_SLUG, SYSTEM_BY_SLUG } from "@/lib/systems/catalog";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";

import {
  APPROVAL_WATCHES,
  OUTBOX_WATCHES,
  ROW_CAP,
  insertAlert,
  labelForSlug,
  listAlerts,
  listOpenAlerts,
  readApprovalQueue,
  readOutboxHealth,
  refreshAlert,
  reraiseAlert,
  resolveAlerts,
} from "./repository";
import { OUTBOX_STUCK_HOURS, SEND_FAILURE_WINDOW_HOURS, type Alert } from "./types";

const NOW = new Date("2026-08-21T10:00:00.000Z");
const HOUR = 3_600_000;
const SITES = ["site-ng", "site-rv"];
const ELSEWHERE = "site-of-another-practice";

const agoIso = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  broken.clear();
});

// ---------------------------------------------------------------------------
// The registries. These are the lists a future module has to be added to, so
// they are checked against the lists it will definitely be added to.
// ---------------------------------------------------------------------------

describe("the watch registries cannot silently fall behind the platform", () => {
  it("watches EVERY outbox the shared messaging drain delivers from", () => {
    expect(OUTBOX_WATCHES.map((w) => w.source).sort()).toEqual(
      Object.keys(DRAIN_SOURCE_TO_SLUG).sort(),
    );
  });

  it("names the same system slug the drain does for each source", () => {
    for (const watch of OUTBOX_WATCHES) {
      expect(DRAIN_SOURCE_TO_SLUG[watch.source], watch.source).toBe(watch.slug);
    }
  });

  it("only ever watches a slug the systems catalog knows, so the label is real", () => {
    for (const watch of [...OUTBOX_WATCHES, ...APPROVAL_WATCHES]) {
      expect(SYSTEM_BY_SLUG.has(watch.slug), watch.slug).toBe(true);
      expect(labelForSlug(watch.slug)).toBe(SYSTEM_BY_SLUG.get(watch.slug)?.label);
    }
  });

  it("deep-links only to screens that exist, or to none at all", () => {
    const known = new Set(CLIENT_MODULE_SLUGS);
    for (const watch of [...OUTBOX_WATCHES, ...APPROVAL_WATCHES]) {
      if (watch.href === null) continue;
      expect(known.has(watch.href), `${watch.slug} -> ${watch.href}`).toBe(true);
    }
  });

  it("claims not_before_at on exactly the three tables that have it", () => {
    // Migrations 0063 (diary), 0091 (post-op) and 0097 (pre-visit). Selecting the
    // column on any other table would fail the read outright, and OMITTING it on
    // one that has it is the opposite defect: a row deliberately parked until
    // 08:00 would be counted as jammed and raise an alert at breakfast.
    expect(OUTBOX_WATCHES.filter((w) => w.hasNotBefore).map((w) => w.table).sort()).toEqual([
      "diary_outbox",
      "postop_outbox",
      "previsit_outbox",
    ]);
  });

  it("watches every draft-for-approval module, and no others", () => {
    expect(APPROVAL_WATCHES.map((w) => w.slug).sort()).toEqual([
      "balance-reminders",
      "postop-checkin",
      "treatment-closer",
    ]);
  });
});

// ---------------------------------------------------------------------------
// THE `not_before_at` CLAIM, DERIVED RATHER THAN REMEMBERED.
//
// Charter section 0 item 1: in this tree the comments ARE the calibration
// contract, and the next engineer deciding whether a new outbox may carry
// `not_before_at` reads the flag's docstring to find out which migrations to
// copy. That docstring claimed the column for exactly two of them until the pin
// above was widened to three and the sentence beside the flag was not — one
// change, one file, a known-changed fact left wrong in one of the two places it
// was written.
//
// So the count and the migration numbers are now READ OFF THE SQL rather than
// off anybody's memory. A fourth outbox given the column, a flag set on a table
// no migration ever gave it, or a citation that names the wrong migration turns
// the sentence red instead of quietly stale.
//
// The scans flatten comment markers first: where a comment's line breaks fall is
// a function of where the prose reached column 80 and is not a claim about
// anything (the lesson os-band-note.test.ts records, where a phrase scan sailed
// past the very sentence it existed to forbid because the sentence wrapped).
// ---------------------------------------------------------------------------

const REPOSITORY_SRC = "src/lib/anomaly/repository.ts";
const REPOSITORY_TEST_SRC = "src/lib/anomaly/repository.test.ts";
const MIGRATIONS_DIR = "supabase/migrations";

const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/**
 * A sentence that COUNTS the tables carrying the column: a number word, the
 * noun, and the rest of that same sentence saying what is being counted. The
 * qualifier is what keeps unrelated prose out — "the one table it owns", at the
 * top of the repository, is the alert store and no business of this block's.
 */
const COUNT_CLAIM =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+tables?\b[^.]*\b(column|have it)\b/gi;

/** A comment with its markers and its wrapping taken off. */
function flattenComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\/|\*)\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** The `hasNotBefore` docstring as it stands in the repository, flattened. */
function hasNotBeforeDoc(): string {
  const src = readFileSync(REPOSITORY_SRC, "utf8");
  const start = src.indexOf("True when the table carries");
  expect(start, "the docstring scan went stale: its opening words moved").toBeGreaterThan(-1);
  const end = src.indexOf("*/", start);
  expect(end, "the docstring is never closed").toBeGreaterThan(start);
  return flattenComments(src.slice(start, end));
}

/**
 * Every table a migration gives `not_before_at`, mapped to the migration that
 * gave it. Line comments are stripped before the scan: two of these migrations
 * discuss the column in their headers, and a sentence about a column is not a
 * column. Index statements name it too and create nothing, so a statement only
 * counts when it also creates the table or adds the column to it.
 */
function tablesGrantedNotBefore(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8").replace(/--[^\n]*/g, "");
    for (const statement of sql.split(";")) {
      if (!/\bnot_before_at\b/.test(statement)) continue;
      const created = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)\s*\(/i.exec(
        statement,
      );
      const altered = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_]+)[\s\S]*?add\s+column/i.exec(
        statement,
      );
      const table = created?.[1] ?? altered?.[1];
      if (table && !out.has(table)) out.set(table, file.slice(0, 4));
    }
  }
  return out;
}

/** The tables the watch registry claims the column for, sorted. */
function flaggedTables(): string[] {
  return OUTBOX_WATCHES.filter((w) => w.hasNotBefore)
    .map((w) => w.table)
    .sort();
}

describe("the not_before_at claim the module makes about itself", () => {
  it("the flag's own docstring counts the tables the migrations gave the column", () => {
    const claims = [...hasNotBeforeDoc().matchAll(COUNT_CLAIM)];
    expect(claims.length, "the docstring no longer says how many carry it").toBe(1);
    expect(claims[0][1].toLowerCase(), `the docstring says: "${claims[0][0]}"`).toBe(
      COUNT_WORDS[flaggedTables().length],
    );
  });

  it("cites the migrations that actually granted the column, and no others", () => {
    const granted = tablesGrantedNotBefore();
    expect(granted.size, "the migration scan matched nothing at all").toBeGreaterThan(0);
    const expected = [
      ...new Set(
        flaggedTables().map((table) => {
          const migration = granted.get(table);
          expect(migration, `no migration gives ${table} the column its watch claims`).toBeDefined();
          return migration!;
        }),
      ),
    ].sort();
    const cited = [...new Set(hasNotBeforeDoc().match(/\b0\d{3}\b/g) ?? [])].sort();
    expect(cited).toEqual(expected);
  });

  it("no watched outbox carries the column without the flag", () => {
    // The other direction, and the one with teeth: a migration that hands a
    // future outbox `not_before_at` without the flag being set makes every
    // overnight defer look like a jam at breakfast, which is the alert this
    // module exists to NOT raise.
    const granted = tablesGrantedNotBefore();
    for (const watch of OUTBOX_WATCHES) {
      expect(
        granted.has(watch.table),
        `${watch.table}: the migrations and the watch disagree about the column`,
      ).toBe(watch.hasNotBefore);
    }
  });

  it("states that count the same way everywhere the module states it", () => {
    // The docstring is not the only place the number is written: this file's own
    // header and the registry pin say it too, and they drifted apart once.
    for (const file of [REPOSITORY_SRC, REPOSITORY_TEST_SRC]) {
      const claims = [...flattenComments(readFileSync(file, "utf8")).matchAll(COUNT_CLAIM)];
      expect(claims.length, `${file} no longer states the count anywhere`).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim[1].toLowerCase(), `a stale count in ${file}: "${claim[0]}"`).toBe(
          COUNT_WORDS[flaggedTables().length],
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The approval-queue read.
// ---------------------------------------------------------------------------

describe("readApprovalQueue", () => {
  const watch = APPROVAL_WATCHES[0]; // closer_touch

  function draft(over: Row = {}) {
    return {
      id: `t-${(db.closer_touch?.length ?? 0) + 1}`,
      site_id: SITES[0],
      status: "draft",
      direction: "outbound",
      created_at: agoIso(2),
      ...over,
    };
  }

  it("counts only outbound drafts belonging to the caller's own sites", async () => {
    db.closer_touch = [
      draft(),
      draft({ site_id: SITES[1] }),
      draft({ site_id: ELSEWHERE }), // another practice
      draft({ status: "sent" }), // already gone
      draft({ direction: "inbound" }), // a patient's reply
    ];
    const r = await readApprovalQueue(watch, SITES);
    expect(r?.count).toBe(2);
    expect(r?.truncated).toBe(false);
    expect(r?.key).toBe("treatment-closer");
    expect(r?.label).toBe("Treatment-plan closer");
  });

  it("reports the OLDEST waiting draft, not just any", async () => {
    db.closer_touch = [draft({ created_at: agoIso(3) }), draft({ created_at: agoIso(90) })];
    const r = await readApprovalQueue(watch, SITES);
    expect(r?.oldestAt).toBe(agoIso(90));
  });

  it(`reports a floor, not a total, once the read hits ${ROW_CAP}`, async () => {
    db.closer_touch = Array.from({ length: ROW_CAP + 40 }, () => draft());
    const r = await readApprovalQueue(watch, SITES);
    expect(r?.count).toBe(ROW_CAP);
    expect(r?.truncated).toBe(true);
  });

  it("returns NULL on a failed read, not an empty queue", async () => {
    broken.add("closer_touch");
    expect(await readApprovalQueue(watch, SITES)).toBeNull();
  });

  it("returns null rather than a practice-wide read when no sites are in scope", async () => {
    expect(await readApprovalQueue(watch, [])).toBeNull();
  });

  it("returns a real zero when the queue is genuinely empty", async () => {
    db.closer_touch = [];
    const r = await readApprovalQueue(watch, SITES);
    expect(r).not.toBeNull();
    expect(r?.count).toBe(0);
    expect(r?.oldestAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The outbox-health read.
// ---------------------------------------------------------------------------

describe("readOutboxHealth", () => {
  const recall = OUTBOX_WATCHES.find((w) => w.source === "recall")!;
  const postop = OUTBOX_WATCHES.find((w) => w.source === "postop")!;

  function row(table: string, over: Row = {}) {
    return {
      id: `o-${(db[table]?.length ?? 0) + 1}`,
      site_id: SITES[0],
      status: "queued",
      created_at: agoIso(OUTBOX_STUCK_HOURS + 1),
      ...over,
    };
  }

  it("counts queued rows older than the cutoff, and not the fresh ones", async () => {
    db.recall_outbox = [
      row("recall_outbox", { created_at: agoIso(OUTBOX_STUCK_HOURS + 1) }), // stuck
      row("recall_outbox", { created_at: agoIso(OUTBOX_STUCK_HOURS - 1) }), // just queued
      row("recall_outbox", { created_at: agoIso(48) }), // stuck, and very
    ];
    const r = await readOutboxHealth(recall, SITES, NOW);
    expect(r?.stuckCount).toBe(2);
    expect(r?.oldestStuckAt).toBe(agoIso(48));
    expect(r?.stuckCutoffHours).toBe(OUTBOX_STUCK_HOURS);
  });

  it("ignores rows that are not queued, and other practices' rows", async () => {
    db.recall_outbox = [
      row("recall_outbox", { status: "sent", created_at: agoIso(20) }),
      row("recall_outbox", { status: "sending", created_at: agoIso(20) }),
      row("recall_outbox", { site_id: ELSEWHERE, created_at: agoIso(20) }),
    ];
    const r = await readOutboxHealth(recall, SITES, NOW);
    expect(r?.stuckCount).toBe(0);
  });

  it("counts recent failures, and only recent ones", async () => {
    db.recall_outbox = [
      row("recall_outbox", { status: "failed", created_at: agoIso(1) }),
      row("recall_outbox", { status: "failed", created_at: agoIso(SEND_FAILURE_WINDOW_HOURS - 1) }),
      row("recall_outbox", { status: "failed", created_at: agoIso(SEND_FAILURE_WINDOW_HOURS + 1) }),
    ];
    const r = await readOutboxHealth(recall, SITES, NOW);
    expect(r?.failedCount).toBe(2);
    expect(r?.failureWindowHours).toBe(SEND_FAILURE_WINDOW_HOURS);
  });

  it("A DELIBERATE HOLD IS NOT STUCK: an overnight defer is excluded", async () => {
    db.postop_outbox = [
      // Queued last night, timed for tomorrow morning: waiting, by design.
      row("postop_outbox", {
        created_at: agoIso(14),
        not_before_at: new Date(NOW.getTime() + 20 * HOUR).toISOString(),
      }),
      // Queued last night, due hours ago, still sitting there: stuck.
      row("postop_outbox", { created_at: agoIso(14), not_before_at: agoIso(9) }),
    ];
    const r = await readOutboxHealth(postop, SITES, NOW);
    expect(r?.stuckCount).toBe(1);
    expect(r?.oldestStuckAt).toBe(agoIso(14));
  });

  it("does not ask for not_before_at on a table that has no such column", async () => {
    // The in-memory database mirrors Postgres here: a comparison against a
    // column that is not there matches nothing. If the recall watch ever claimed
    // the column, this row would vanish from the count.
    db.recall_outbox = [row("recall_outbox", { created_at: agoIso(20) })];
    const r = await readOutboxHealth(recall, SITES, NOW);
    expect(r?.stuckCount).toBe(1);
  });

  it("returns NULL on a failed read, not a clean bill of health", async () => {
    broken.add("recall_outbox");
    expect(await readOutboxHealth(recall, SITES, NOW)).toBeNull();
  });

  it("reports a floor once either half hits the cap", async () => {
    db.recall_outbox = Array.from({ length: ROW_CAP + 5 }, () =>
      row("recall_outbox", { created_at: agoIso(20) }),
    );
    const r = await readOutboxHealth(recall, SITES, NOW);
    expect(r?.stuckCount).toBe(ROW_CAP);
    expect(r?.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The alert store.
// ---------------------------------------------------------------------------

describe("the alert store", () => {
  const CLIENT = "vitality";
  const alert: Alert = {
    kind: "takings_trend",
    severity: "medium",
    dedupeKey: "takings_trend:last7",
    sentence: "Takings are down a bit.",
    href: "payments",
    at: NOW.toISOString(),
  };

  beforeEach(() => {
    db.anomaly_alert = [];
  });

  it("insert then read back: open, anchored, and stamped at both ends", async () => {
    await insertAlert(CLIENT, alert, NOW);
    const [row] = await listOpenAlerts(CLIENT);
    expect(row.dedupeKey).toBe("takings_trend:last7");
    expect(row.sentence).toBe("Takings are down a bit.");
    expect(row.href).toBe("payments");
    expect(row.at).toBe(NOW.toISOString());
    expect(row.firstRaisedAt).toBe(NOW.toISOString());
    expect(row.resolvedAt).toBeNull();
  });

  it("REFRESH takes the newer wording but keeps first_raised_at", async () => {
    await insertAlert(CLIENT, alert, NOW);
    const later = new Date(NOW.getTime() + 30 * HOUR);
    await refreshAlert(
      CLIENT,
      { ...alert, sentence: "Takings are down a lot.", severity: "high" },
      later,
    );
    const [row] = await listOpenAlerts(CLIENT);
    expect(row.sentence).toBe("Takings are down a lot.");
    expect(row.severity).toBe("high");
    expect(row.lastSeenAt).toBe(later.toISOString());
    // The answer to "how long has this been going on" must not be reset.
    expect(row.firstRaisedAt).toBe(NOW.toISOString());
  });

  it("resolve hides it from the open feed but keeps the row", async () => {
    await insertAlert(CLIENT, alert, NOW);
    await resolveAlerts(CLIENT, [alert.dedupeKey], NOW);
    expect(await listOpenAlerts(CLIENT)).toEqual([]);
    expect(await listAlerts(CLIENT)).toHaveLength(1);
  });

  it("resolve is a no-op with nothing to resolve, and never re-stamps a resolved row", async () => {
    await insertAlert(CLIENT, alert, NOW);
    await resolveAlerts(CLIENT, [], NOW);
    expect(await listOpenAlerts(CLIENT)).toHaveLength(1);

    await resolveAlerts(CLIENT, [alert.dedupeKey], NOW);
    const later = new Date(NOW.getTime() + 5 * HOUR);
    await resolveAlerts(CLIENT, [alert.dedupeKey], later);
    expect((await listAlerts(CLIENT))[0].resolvedAt).toBe(NOW.toISOString());
  });

  it("RE-RAISE reopens the same row and restarts its clock", async () => {
    await insertAlert(CLIENT, alert, NOW);
    await resolveAlerts(CLIENT, [alert.dedupeKey], NOW);
    const later = new Date(NOW.getTime() + 100 * HOUR);
    await reraiseAlert(CLIENT, { ...alert, at: later.toISOString() }, later);

    const open = await listOpenAlerts(CLIENT);
    expect(open).toHaveLength(1);
    expect(open[0].resolvedAt).toBeNull();
    expect(open[0].firstRaisedAt).toBe(later.toISOString());
    // Still ONE row: re-raising is an update, never a second row for one condition.
    expect(await listAlerts(CLIENT)).toHaveLength(1);
  });

  it("keeps one practice's alerts out of another's feed", async () => {
    await insertAlert(CLIENT, alert, NOW);
    await insertAlert("someone-else", alert, NOW);
    expect(await listOpenAlerts(CLIENT)).toHaveLength(1);
    expect(await listOpenAlerts("someone-else")).toHaveLength(1);
  });

  it("surfaces a failed store read rather than pretending the feed is empty", async () => {
    broken.add("anomaly_alert");
    await expect(listAlerts(CLIENT)).rejects.toBeTruthy();
    await expect(listOpenAlerts(CLIENT)).rejects.toBeTruthy();
  });
});
