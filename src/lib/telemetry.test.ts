import { describe, it, expect, vi, beforeEach } from "vitest";

// telemetry.ts is server-only and talks to Supabase via serviceClient. Stub the
// server-only marker and back serviceClient with a tiny in-memory usage_event table
// so the allowlist gate, the action write, and the grouped read are all covered.
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  let rows: Array<Record<string, unknown>> = [];
  const inserted: Array<Record<string, unknown>> = [];
  let throwNext = false;
  // Every page the summary's walk asked for, in order: how many rows it wanted and
  // which row it said it was continuing after. Rulings W3/32 (page width) and the
  // keyset rewrite are both about the SHAPE of the request, so the request has to
  // be observable — a tally-only assertion cannot tell 999 from 1,000, nor a
  // cursor from an offset.
  const pages: Array<{ want: number | null; after: { createdAt: string; id: string } | null }> = [];
  // Offsets, if the walk ever asks for one again. Nothing should land here.
  const ranges: Array<[number, number]> = [];
  let onPage: ((index: number) => void) | null = null;

  // The one filter shape this module is allowed to send: "strictly older than the
  // row I stopped at, or the same instant with a higher id". Anything else is a
  // filter string nobody meant to write, and the double refuses it rather than
  // quietly matching everything.
  const KEYSET =
    /^created_at\.lt\."([^"]*)",and\(created_at\.eq\."([^"]*)",id\.gt\."([^"]*)"\)$/;

  function makeBuilder() {
    const state: {
      head: boolean;
      count: boolean;
      cols: string;
      filters: Array<[string, unknown]>;
      gte: [string, string] | null;
      or: string | null;
      orders: Array<[string, boolean]>;
      limit: number | null;
      range: [number, number] | null;
      insert: Array<Record<string, unknown>> | null;
    } = {
      head: false,
      count: false,
      cols: "",
      filters: [],
      gte: null,
      or: null,
      orders: [],
      limit: null,
      range: null,
      insert: null,
    };

    const resolve = () => {
      if (state.insert) {
        for (const r of state.insert) inserted.push(r);
        return { data: null, error: null };
      }
      let filtered = rows.filter((r) => state.filters.every(([c, v]) => r[c] === v));
      if (state.gte) {
        const [col, val] = state.gte;
        filtered = filtered.filter((r) => String(r[col] ?? "") >= val);
      }
      if (state.head && state.count) return { count: filtered.length, error: null };

      // Ordering is applied for real, so the walk's cursor means what it says.
      const orders = state.orders;
      filtered = [...filtered].sort((a, b2) => {
        for (const [col, asc] of orders) {
          const x = String(a[col] ?? "");
          const y = String(b2[col] ?? "");
          if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });

      let after: { createdAt: string; id: string } | null = null;
      if (state.or !== null) {
        const m = KEYSET.exec(state.or);
        if (!m) throw new Error(`the usage scan sent a filter that is not a keyset cursor: ${state.or}`);
        const [, lt, eq, gt] = m;
        if (lt !== eq) throw new Error(`keyset cursor disagrees with itself: ${state.or}`);
        after = { createdAt: lt, id: gt };
        filtered = filtered.filter((r) => {
          const created = String(r.created_at ?? "");
          return created < lt || (created === eq && String(r.id ?? "") > gt);
        });
      }

      let slice = filtered;
      if (state.range) slice = filtered.slice(state.range[0], state.range[1] + 1);
      if (state.limit !== null) slice = slice.slice(0, state.limit);
      const cols = state.cols.split(",").map((c) => c.trim());
      const data = slice.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));

      const index = pages.length;
      pages.push({ want: state.limit ?? (state.range ? state.range[1] - state.range[0] + 1 : null), after });
      // A page has landed: let a test move the table underneath the scan, exactly
      // as the live beacon does while an owner is reading Reports.
      onPage?.(index);
      return { data, error: null };
    };

    const b: Record<string, unknown> = {
      select(cols: string, opts?: { count?: string; head?: boolean }) {
        state.cols = cols;
        if (opts?.head) state.head = true;
        if (opts?.count) state.count = true;
        return b;
      },
      insert(payload: Record<string, unknown> | Array<Record<string, unknown>>) {
        state.insert = Array.isArray(payload) ? payload : [payload];
        return b;
      },
      eq(col: string, val: unknown) {
        state.filters.push([col, val]);
        return b;
      },
      gte(col: string, val: unknown) {
        state.gte = [col, String(val)];
        return b;
      },
      lte() {
        return b;
      },
      or(filter: string) {
        state.or = filter;
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        state.orders.push([col, opts?.ascending !== false]);
        return b;
      },
      limit(n: number) {
        state.limit = n;
        return b;
      },
      range(from: number, to: number) {
        state.range = [from, to];
        ranges.push([from, to]);
        return b;
      },
      then(onFulfilled: (v: unknown) => void) {
        onFulfilled(resolve());
        return Promise.resolve();
      },
    };
    return b;
  }

  const serviceClient = vi.fn(() => {
    if (throwNext) {
      throwNext = false;
      throw new Error("boom");
    }
    return { from: () => makeBuilder() };
  });

  return {
    serviceClient,
    inserted,
    pages,
    ranges,
    setRows(r: Array<Record<string, unknown>>) {
      rows = r;
    },
    addRows(r: Array<Record<string, unknown>>) {
      rows = [...rows, ...r];
    },
    onPage(cb: (index: number) => void) {
      onPage = cb;
    },
    reset() {
      rows = [];
      inserted.length = 0;
      throwNext = false;
      pages.length = 0;
      ranges.length = 0;
      onPage = null;
    },
    failOnce() {
      throwNext = true;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";

import {
  sanitiseSurface,
  recordUsage,
  usageSummary,
  resolveScanCap,
  USAGE_SCAN_CAP,
  USAGE_READ_ERROR,
} from "@/lib/telemetry";

/** The instant row 0 of a fixture was recorded; every later row is a second older. */
const NEWEST = Date.parse("2026-06-01T12:00:00.000Z");

/** The `created_at` of fixture row `i`, newest first — the scan's own order. */
function stamp(i: number): string {
  return new Date(NEWEST - i * 1_000).toISOString();
}

/**
 * n page-view rows for one client, newest first, all on the same surface.
 *
 * They carry `created_at` and a sortable `id` because the walk pages by those two
 * columns now: a fixture without them could not tell a keyset cursor from an
 * offset, which is the whole point of the tests below.
 */
function pageViews(n: number, surface = "patients"): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `u-${String(i).padStart(6, "0")}`,
    client_id: "vitality",
    event: "page_view",
    surface,
    user_email: "owner@vitality.co.uk",
    created_at: stamp(i),
  }));
}

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

describe("sanitiseSurface", () => {
  it("accepts known module slugs", () => {
    expect(sanitiseSurface("patients")).toBe("patients");
    expect(sanitiseSurface("outreach")).toBe("outreach");
    expect(sanitiseSurface("co-pilot")).toBe("co-pilot");
  });

  it("maps the empty slug to overview", () => {
    expect(sanitiseSurface("")).toBe("overview");
    expect(sanitiseSurface("overview")).toBe("overview");
  });

  it("lower-cases before matching", () => {
    expect(sanitiseSurface("OUTREACH")).toBe("outreach");
  });

  it("rejects anything not on the allowlist (ids, junk, non-strings)", () => {
    expect(sanitiseSurface("patients/12345")).toBeNull();
    expect(sanitiseSurface("definitely-not-a-module")).toBeNull();
    expect(sanitiseSurface(42)).toBeNull();
    expect(sanitiseSurface(null)).toBeNull();
  });
});

describe("recordUsage", () => {
  it("writes one action event with the action name as detail", async () => {
    await recordUsage("outreach", "campaign_launch", {
      clientId: "vitality",
      userEmail: "owner@vitality.co.uk",
      role: "client_owner",
    });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      client_id: "vitality",
      user_email: "owner@vitality.co.uk",
      role: "client_owner",
      event: "action",
      surface: "outreach",
      detail: "campaign_launch",
    });
  });

  it("never throws when the write fails (telemetry must not break the app)", async () => {
    h.failOnce();
    await expect(
      recordUsage("patients", "note_added", { clientId: "vitality" }),
    ).resolves.toBeUndefined();
    expect(h.inserted).toHaveLength(0);
  });
});

describe("usageSummary", () => {
  it("groups page views by surface (desc) and finds the most active user", async () => {
    h.setRows([
      { id: "1", client_id: "vitality", event: "page_view", surface: "patients", user_email: "a@x.com", created_at: stamp(0) },
      { id: "2", client_id: "vitality", event: "page_view", surface: "patients", user_email: "a@x.com", created_at: stamp(1) },
      { id: "3", client_id: "vitality", event: "page_view", surface: "patients", user_email: "b@x.com", created_at: stamp(2) },
      { id: "4", client_id: "vitality", event: "page_view", surface: "outreach", user_email: "a@x.com", created_at: stamp(3) },
      // Excluded: an action event, and another client's page view.
      { id: "5", client_id: "vitality", event: "action", surface: "outreach", user_email: "a@x.com", created_at: stamp(4) },
      { id: "6", client_id: "other", event: "page_view", surface: "patients", user_email: "z@x.com", created_at: stamp(5) },
    ]);

    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });

    expect(summary.totalViews).toBe(4);
    expect(summary.surfaces).toEqual([
      { surface: "patients", views: 3 },
      { surface: "outreach", views: 1 },
    ]);
    expect(summary.mostActiveUser).toEqual({ email: "a@x.com", views: 3 });
  });

  it("returns an empty summary when there is no usage", async () => {
    h.setRows([]);
    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });
    expect(summary.totalViews).toBe(0);
    expect(summary.surfaces).toEqual([]);
    expect(summary.mostActiveUser).toBeNull();
    // A QUIET WINDOW IS NOT A BROKEN ONE. This read happened and found nothing,
    // so the panel is entitled to its "No usage recorded yet" empty state — and
    // that entitlement is exactly what `readError: null` grants it.
    expect(summary.readError, "a window that was read and was empty is not an error").toBeNull();
  });

  // AN UNREADABLE TABLE IS NOT AN IDLE PRACTICE (charter §0/5, ruling W3/11).
  //
  // This test used to assert the OPPOSITE property: that a failed read returns
  // `{ totalViews: 0, surfaces: [] }` and nothing else — which is byte-identical
  // to the summary the test directly above produces from a window that was read
  // and was genuinely empty. The Reports panel's only branch is
  // `summary.surfaces.length === 0`, so the two facts rendered as one sentence:
  // "No usage recorded yet — as your team moves around the platform, the modules
  // they use appear here". An owner sizing a renewal read that as thirty days of
  // an untouched platform, when what had actually happened was that the read
  // never ran. Home's OS band states the rule this breaks
  // (src/lib/home/os-band.ts): a failed read never wears a number's clothes, and
  // an empty table and an unreachable one are different facts. The remedy is the
  // one `assembleSyncStatus` already ships one directory over — a discriminator
  // the caller cannot miss, carrying the sentence to print.
  //
  // MUTATION: return `readError: null` from the catch in usageSummary (i.e.
  // restore the old shape). This test goes red on the discriminator; the
  // "does not flag a window that fitted" test below goes red on the log.
  it("says a failed read FAILED, distinguishably from a window that was empty", async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logged.push(a);
    });
    try {
      h.failOnce();
      const failed = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });

      // It still never throws, and it still claims no figures.
      expect(failed.totalViews).toBe(0);
      expect(failed.surfaces).toEqual([]);
      expect(failed.mostActiveUser).toBeNull();
      expect(failed.capped, "there was no scan to have capped").toBe(false);

      // …and it is now TELLABLE from the empty window, which is the whole point.
      expect(failed.readError, "a failed read wore an empty window's clothes").toBe(USAGE_READ_ERROR);
      h.setRows([]);
      const empty = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });
      expect(empty.readError).toBeNull();
      expect(failed).not.toEqual(empty);

      // The server hears about it too. Every other degrading read in this
      // programme logs before it returns its honest empty; this one swallowed
      // silently, so nobody could find out the panel had been broken rather
      // than the practice idle.
      expect(logged.some((a) => String(a[0]).includes("[telemetry]") && String(a[0]).includes("vitality"))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });

  // The sentence is owner-facing copy, and it has to say the two things the
  // honest-numbers rule asks of it: that this is a fault with the page, and that
  // it is NOT a statement about the practice. Pinned so a later edit cannot
  // soften it back into "no usage recorded".
  it("the failed-read sentence names the fault and refuses the claim about the practice", () => {
    expect(USAGE_READ_ERROR).toContain("could not be read");
    expect(USAGE_READ_ERROR).toContain("a fault with this page");
    expect(USAGE_READ_ERROR).toContain("not a statement that nobody has been using the platform");
    // Owner-facing, but the funding-jargon rule is tree-wide (charter §0/7).
    expect(USAGE_READ_ERROR).not.toMatch(/\bNHS\b|\bprivate\b/i);
  });
});

// ---------------------------------------------------------------------------
// THE PAGE WIDTH, AND THE FLOOR THE SCREEN PRINTS (programme ruling W3/32, W3/11).
//
// Supabase clips every REST response at a server-side max-rows ceiling, measured
// on this project at POSTGREST_MAX_ROWS, silently — no error, nothing on the
// response to read. A scan that asks for exactly the ceiling cannot tell a full
// page from a clipped one, and this loop's page size sat on it. The tally never
// depended on the distinction (it is anchored to a head-count), which is why
// nothing went red for months, so the property is pinned where it is real: on the
// window the loop asks for.
//
// The second half is the number that reaches the owner. `USAGE_SCAN_CAP` is a
// bound on work, and past it `totalViews` is a FLOOR — so it may only be printed
// as "at least N" (charter §0/5). `scanCap` lowers the bound for these tests the
// same one-way way `createFakeSupabase({ maxRows })` lowers the ceiling.
// ---------------------------------------------------------------------------
describe("the usage scan never asks for a page the server could clip (W3/32)", () => {
  // MUTATION: put SUMMARY_PAGE back to 1000. Every other test here stays green —
  // the tally is right either way — and the loop is once again asking for exactly
  // as many rows as the server will hand back, where "the rows ran out" and "you
  // were cut off" are the same response.
  it("asks for windows strictly narrower than PostgREST's ceiling", async () => {
    h.setRows(pageViews(2_500));
    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });
    expect(summary.totalViews).toBe(2_500);
    expect(summary.capped).toBe(false);

    expect(h.pages.length, "the scan did not page at all").toBeGreaterThan(1);
    for (const p of h.pages) {
      expect(p.want, "a page was read with no row bound at all").not.toBeNull();
      expect(
        p.want as number,
        `a page of ${p.want} rows is at or above the ${POSTGREST_MAX_ROWS}-row ceiling, so a clipped page would look like the last one`,
      ).toBeLessThan(POSTGREST_MAX_ROWS);
    }
  });

  // MUTATION: drop the `Math.min(SUMMARY_PAGE, total - scanned)` and ask for a
  // full page every time. The count stays right and the loop reads rows past its
  // own bound to get it — which is the bound not being a bound.
  it("stops ON its cap rather than overshooting it by whatever the last page held", async () => {
    h.setRows(pageViews(3_000));
    const summary = await usageSummary({
      clientId: "vitality",
      sinceIso: "2026-01-01T00:00:00Z",
      scanCap: 1_500,
    });
    expect(summary.totalViews).toBe(1_500);
    const asked = h.pages.reduce((n, p) => n + (p.want ?? 0), 0);
    expect(asked, "the scan asked for more rows than its own cap").toBe(1_500);
    expect(h.pages[h.pages.length - 1].want, "the last page was not narrowed to what was left").toBe(501);
  });
});

// ---------------------------------------------------------------------------
// KEYSET, NOT OFFSET — THE SHAPE OF THE WALK ITSELF.
//
// `usageSummary` is awaited inline by an async server component on the owner
// Reports page (src/components/client/reports/usage-section.tsx), in a tree with
// no loading.tsx and no Suspense boundary — the page's first byte waits on this
// loop. It used to page with `.range(scanned, …)`, which is wrong twice over:
//
//   * deep offset re-walks the prefix it is about to discard, so at the scan cap
//     it was 51 sequential round trips with offsets climbing to 50,000; and
//   * offset moves under a table that is being written to, and this table is
//     written by every page view in the building. Rows land at the TOP (the order
//     is created_at desc), so each insert shifts the set down and the next page
//     re-reads rows the last page already tallied. This is a raw tally with no
//     set to swallow the repeat: a shifted page double-counts.
//
// The interest scan one directory over was rewritten for exactly this
// (countInterestByTreatmentDetailed in src/lib/triage/repository.ts); this is the
// same cursor, in the same (created_at desc, id asc) order.
// ---------------------------------------------------------------------------
describe("the usage scan pages by keyset, not by offset", () => {
  // MUTATION: put the walk back on `.range(scanned, Math.min(scanned + SUMMARY_PAGE, total) - 1)`.
  // The tally is unchanged on a still table, so only this goes red.
  it("carries the last row it read forward as a cursor, and asks for no offset at all", async () => {
    h.setRows(pageViews(2_500));
    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });
    expect(summary.totalViews).toBe(2_500);

    expect(h.ranges, "the scan asked for an offset window").toEqual([]);
    expect(h.pages.length).toBe(3);
    expect(h.pages[0].after, "the first page cannot have a cursor").toBeNull();
    // Page 2 continues strictly after the last row of page 1 (index 998), page 3
    // after the last row of page 2 (index 1997).
    expect(h.pages[1].after).toEqual({ createdAt: stamp(998), id: "u-000998" });
    expect(h.pages[2].after).toEqual({ createdAt: stamp(1_997), id: "u-001997" });
  });

  // MUTATION: as above. Under `.range()` the second page restarts at offset 999 of
  // a set that five new views have pushed down, so it re-reads the five "reports"
  // rows and this tally reads 10 — a made-up number on the owner's Reports page.
  it("counts a view once even when new page views arrive mid-scan", async () => {
    // 1,200 views, of which the five sitting just above the first page boundary
    // are on their own surface, so a repeated page is visible in the numbers.
    const rows = pageViews(1_200).map((r, i) => (i >= 994 && i <= 998 ? { ...r, surface: "reports" } : r));
    h.setRows(rows);
    // The beacon keeps writing while the owner reads: five brand-new views land
    // after the first page comes back. Newest, so under `created_at desc` they go
    // to the front of the set and shift every offset by five.
    h.onPage((index) => {
      if (index !== 0) return; // the head-count read is not a page; 0 is the first one
      h.addRows(
        Array.from({ length: 5 }, (_, k) => ({
          id: `live-${k}`,
          client_id: "vitality",
          event: "page_view",
          surface: "co-pilot",
          user_email: "manager@vitality.co.uk",
          created_at: new Date(NEWEST + (k + 1) * 1_000).toISOString(),
        })),
      );
    });

    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });

    expect(summary.totalViews).toBe(1_200);
    const bySurface = Object.fromEntries(summary.surfaces.map((s) => [s.surface, s.views]));
    expect(bySurface.reports, "a page was re-read, so five views were counted twice").toBe(5);
    expect(bySurface.patients).toBe(1_195);
    // The views that arrived mid-scan are simply outside this window's answer —
    // the cursor is older than all of them — rather than half-counted.
    expect(bySurface["co-pilot"]).toBeUndefined();
  });

  // MUTATION: delete the `capped = true` in the cursor-safety branch. The scan
  // still stops — it will not page on a filter string it did not mean to write —
  // but it now reports 999 of 1,200 views as a TOTAL, which is the one thing
  // charter §0/5 forbids. (Deleting the whole check is red too: the double refuses
  // a filter that is not a keyset cursor, so the summary comes back empty.)
  it("stops and says the figures are floors rather than page on a cursor it cannot quote", async () => {
    const rows = pageViews(1_200).map((r, i) =>
      // The last row of the first page carries a value that cannot be interpolated
      // into a PostgREST filter safely. Nothing in this table can produce one — it
      // is a uuid column — which is exactly why the branch has to be pinned.
      i === 998 ? { ...r, id: 'u-000998"evil' } : r,
    );
    h.setRows(rows);

    const summary = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });

    expect(h.pages.length, "the scan paged on an unquotable cursor").toBe(1);
    expect(summary.totalViews).toBe(999);
    expect(summary.capped, "999 of 1,200 views reached the screen as a total").toBe(true);
  });
});

describe("a capped usage scan says so, so the screen can print a floor (W3/11)", () => {
  // MUTATION: return `capped: false` unconditionally, or compare the cap against
  // `scanned` instead of the head-count. Both leave a FLOOR on the Reports page
  // wearing a total's clothes: "50,000 page views" for a practice that had more.
  it("flags the summary when the window held more rows than the scan would read", async () => {
    h.setRows(pageViews(120));
    const summary = await usageSummary({
      clientId: "vitality",
      sinceIso: "2026-01-01T00:00:00Z",
      scanCap: 100,
    });
    expect(summary.capped).toBe(true);
    expect(summary.totalViews).toBe(100);
    expect(summary.surfaces).toEqual([{ surface: "patients", views: 100 }]);
  });

  it("does not flag a window that fitted, nor an empty one, nor a failed read", async () => {
    h.setRows(pageViews(100));
    const exact = await usageSummary({
      clientId: "vitality",
      sinceIso: "2026-01-01T00:00:00Z",
      scanCap: 100,
    });
    expect(exact.capped, "a window that fitted exactly is not capped").toBe(false);
    expect(exact.totalViews).toBe(100);

    h.setRows([]);
    expect((await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" })).capped).toBe(false);

    // A FAILED READ IS NOT A CAPPED ONE, AND IT IS NOT AN EMPTY ONE EITHER.
    // `capped: false` here means "no scan happened, so no scan was truncated" —
    // it must never be read as "the whole window was counted". `readError` is
    // the field that carries the difference, and it is asserted alongside so
    // this case cannot be mistaken for the empty one immediately above it.
    // (The catch logs; silenced so a deliberate failure is not suite noise.)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.failOnce();
      const failed = await usageSummary({ clientId: "vitality", sinceIso: "2026-01-01T00:00:00Z" });
      expect(failed.capped).toBe(false);
      expect(failed.readError, "capped:false must not be the only thing a failed read says").toBe(
        USAGE_READ_ERROR,
      );
    } finally {
      spy.mockRestore();
    }
  });

  // MUTATION: drop the Math.min (or the Math.max, or the floor). A caller could
  // then ask for a BIGGER scan than the module's own bound — the option loosening
  // the very thing it exists to tighten, which is the failure mode
  // `createFakeSupabase`'s one-way ceiling is written up around. Asserted on the
  // arithmetic itself: observing it through `usageSummary` would cost a
  // 50,001-row fixture to watch a Math.min happen.
  it("the test-only cap can only ever LOWER the module's bound", () => {
    expect(resolveScanCap(undefined)).toBe(USAGE_SCAN_CAP);
    expect(resolveScanCap(100)).toBe(100);
    expect(resolveScanCap(USAGE_SCAN_CAP + 1), "a bigger cap was accepted").toBe(USAGE_SCAN_CAP);
    expect(resolveScanCap(500_000)).toBe(USAGE_SCAN_CAP);
    expect(resolveScanCap(0), "a scan of no rows is not a scan").toBe(1);
    expect(resolveScanCap(-5)).toBe(1);
    expect(resolveScanCap(10.9), "a fractional page bound is not a row count").toBe(10);
  });

  it("still honours a lowered cap end to end, through the real read", async () => {
    h.setRows(pageViews(2_000));
    const bounded = await usageSummary({
      clientId: "vitality",
      sinceIso: "2026-01-01T00:00:00Z",
      scanCap: 750,
    });
    expect(bounded.totalViews).toBe(750);
    expect(bounded.capped).toBe(true);
  });
});
