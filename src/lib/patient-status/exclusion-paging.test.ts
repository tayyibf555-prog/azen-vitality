// ===========================================================================
// THE TARGETING-EXCLUSION READS SURVIVE POSTGREST'S ROW CEILING.
//
// Supabase clips every REST response at a server-side max-rows ceiling —
// measured at 1,000 on this project (the measurement is written up in
// src/lib/dentally/sync-ledger.ts, which had to drop its count cap to 900
// because of it). A clipped response carries `error: null` and a perfectly
// valid array, so it is INDISTINGUISHABLE from a complete one: nothing throws,
// nothing logs, and the caller builds its exclusion set out of the first page.
//
// On this table that is a consent failure, not a display glitch. These rows are
// the patients a human marked `inactive` or `do_not_contact`; a short list means
// the sweeps and the outreach builder target the tail. `inactive` has no second
// barrier at the send choke point (applyStatusChange writes message_suppression
// for `do_not_contact` only), which is the exact residue ruling W1-B/2 refused
// to accept for a read ERROR — and a truncation is the same residue arriving
// with no error to catch.
//
// The fake below is therefore NOT the shared in-memory Supabase: that one has no
// ceiling, which is precisely why the suite could not express this before. This
// one clips like the real server does, so removing the paging loop from any read
// under test turns one of these red.
// ===========================================================================
import { describe, it, expect, beforeEach, vi } from "vitest";

interface Row {
  site_id: string;
  dentally_patient_id: string;
  status: string;
  reason: string | null;
  set_by: string | null;
  set_at: string;
  dentally_synced: boolean;
  dentally_synced_at: string | null;
}

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** The server's max-rows ceiling: no response ever carries more rows than this. */
  ceiling: 1000,
  /** Every [from, to] window the code under test asked for, in order. */
  windows: [] as Array<[number, number]>,
}));

vi.mock("server-only", () => ({}));

// A PostgREST-shaped reader for patient_status_override, and only that table.
// Supports the exact chain the repository uses: select / eq / in / order / range.
vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    if (table !== "patient_status_override") throw new Error(`unexpected table: ${table}`);
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const orderBy: string[] = [];
    let window: [number, number] | null = null;

    function run(): { data: unknown; error: unknown } {
      let out = store.rows.filter((r) => filters.every((f) => f(r)));
      for (const col of [...orderBy].reverse()) {
        out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
      }
      const start = window ? window[0] : 0;
      // An UNRANGED read is a window of [0, ∞) — and the server clips it at the
      // ceiling exactly as it clips a too-wide explicit range. That is what makes
      // this fake able to catch a missing paging loop rather than just an
      // off-by-one in one that exists.
      const asked = window ? window[1] - window[0] + 1 : Number.POSITIVE_INFINITY;
      store.windows.push(window ?? [0, -1]);
      return { data: out.slice(start, start + Math.min(asked, store.ceiling)), error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order(col: string) {
        orderBy.push(col);
        return builder;
      },
      range(a: number, b: number) {
        window = [a, b];
        return builder;
      },
      then<R>(onF?: ((v: { data: unknown; error: unknown }) => R) | null) {
        return Promise.resolve(run()).then(onF ?? undefined);
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import {
  excludedTargetKey,
  listOverridesForSites,
  loadDoNotContactKeys,
  loadExcludedPatientIds,
  loadExcludedTargetKeys,
} from "./repository";

const SITE_A = "site-cc";
const SITE_B = "site-n17";

/**
 * `count` excluded patients plus one active decoy.
 *
 * Site alternates on i, status on (i mod 4) — INDEPENDENTLY, so that each read
 * under test has more than one page of its OWN rows to find. An earlier version
 * put a third of the rows on do_not_contact, which left the loadDoNotContactKeys
 * case with 834 matches: under the ceiling, and therefore green with the paging
 * removed. A truncation test whose subject fits in one page proves nothing.
 */
function seedExclusions(count: number): void {
  store.rows = [];
  for (let i = 0; i < count; i++) {
    store.rows.push({
      site_id: i % 2 === 0 ? SITE_A : SITE_B,
      dentally_patient_id: `p-${String(i).padStart(6, "0")}`,
      status: i % 4 < 2 ? "do_not_contact" : "inactive",
      reason: null,
      set_by: null,
      set_at: "2026-09-01T09:00:00.000Z",
      dentally_synced: false,
      dentally_synced_at: null,
    } satisfies Row as unknown as Record<string, unknown>);
  }
  store.rows.push({
    site_id: SITE_A,
    dentally_patient_id: "p-active",
    status: "active",
    reason: null,
    set_by: null,
    set_at: "2026-09-01T09:00:00.000Z",
    dentally_synced: false,
    dentally_synced_at: null,
  });
}

beforeEach(() => {
  store.ceiling = 1000;
  store.windows = [];
  seedExclusions(0);
});

describe("patient_status_override reads page past PostgREST's row ceiling", () => {
  it("loadExcludedTargetKeys returns EVERY exclusion when there are more than one page of them", async () => {
    // 2,500 marked patients, a 1,000-row ceiling. An unranged select would come
    // back with 1,000 rows, no error, and 1,500 patients quietly targetable.
    seedExclusions(2500);

    const keys = await loadExcludedTargetKeys();

    expect(keys.size, "the exclusion set was clipped at the server's ceiling").toBe(2500);
    expect(keys.has(excludedTargetKey(SITE_A, "p-000000"))).toBe(true);
    // The patient furthest past the ceiling is the one who would have been messaged.
    expect(keys.has(excludedTargetKey(SITE_B, "p-002499")), "the last marked patient fell off the end").toBe(
      true,
    );
    expect(keys.has(excludedTargetKey(SITE_A, "p-active"))).toBe(false);
    // Three requests: 1,000 + 1,000 + 500, then one empty page to prove the end.
    expect(store.windows.length).toBeGreaterThanOrEqual(3);
  });

  it("loadExcludedPatientIds (the outreach audience builder's only check) reads to exhaustion too", async () => {
    seedExclusions(2500);

    const ids = await loadExcludedPatientIds(SITE_A);

    // Even patient indices are SITE_A: 0, 2, 4 ... 2498 = 1,250 of them.
    expect(ids.size, "the builder's exclusion set was clipped, and a build is a permanent snapshot").toBe(1250);
    // 2,498 is an INACTIVE patient at site A — the status with no second barrier
    // at the send choke point, and so the one this whole read exists to protect.
    expect(ids.has("p-002498")).toBe(true);
    expect(ids.has("p-active")).toBe(false);
  });

  it("loadDoNotContactKeys reads to exhaustion (a clipped read is a missing staff flag)", async () => {
    seedExclusions(2500);

    const keys = await loadDoNotContactKeys([SITE_A, SITE_B]);

    // Half the rows are do_not_contact (i mod 4 in {0, 1}): 1,250 of 2,500 — more
    // than one page of them, which is the only way this can fail when it should.
    expect(keys.size, "the flag list was clipped at the server's ceiling").toBe(1250);
    // The highest do_not_contact index is 2,497 (2,499 is inactive, and inactive
    // deliberately does NOT appear on this staff-review list).
    expect(keys.has(excludedTargetKey(SITE_B, "p-002497"))).toBe(true);
    expect(keys.has(excludedTargetKey(SITE_B, "p-002499"))).toBe(false);
  });

  it("listOverridesForSites reads to exhaustion (a clipped read is a missing chip)", async () => {
    seedExclusions(2500);

    const rows = await listOverridesForSites([SITE_A, SITE_B]);

    expect(rows).toHaveLength(2501); // 2,500 marked + the active decoy
    expect(rows.some((r) => r.patientId === "p-002499")).toBe(true);
  });

  it("a ceiling LOWER than the page size does not silently truncate either", async () => {
    // THE REASON THE LOOP STOPS ON AN EMPTY PAGE RATHER THAN A SHORT ONE. If
    // Supabase's max-rows is ever lowered below OVERRIDE_PAGE, every page comes
    // back shorter than the window it asked for — and a "short page means the
    // end" loop would stop after the FIRST one, silently truncating again while
    // looking exactly like a fix. 250 here stands in for that lowered ceiling.
    store.ceiling = 250;
    seedExclusions(900);

    const keys = await loadExcludedTargetKeys();

    expect(keys.size, "the read stopped at the first short page").toBe(900);
    expect(keys.has(excludedTargetKey(SITE_A, "p-000898"))).toBe(true);
  });

  it("a read that fits inside one page still issues no extra work than paging needs", async () => {
    seedExclusions(5);

    const keys = await loadExcludedTargetKeys();

    expect(keys.size).toBe(5);
    // One full-width request that comes back short, then one that comes back
    // empty. The extra round trip is the price of being ceiling-agnostic.
    expect(store.windows).toEqual([
      [0, 999],
      [5, 1004],
    ]);
  });
});
