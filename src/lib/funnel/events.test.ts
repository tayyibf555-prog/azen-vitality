import { describe, it, expect, vi, beforeEach } from "vitest";

// funnelSummary + funnelVariantSummary against a dataset-backed Supabase mock.
//
// The mock holds an in-memory `rows` table and honours the SAME calls the real
// aggregation makes: head-counts (`select('*', { count, head:true })` -> row
// count of the filtered set, no rows transferred) and paged `select('step')` +
// `.range()` slices. It applies the `.eq()` filters we care about
// (client_id, surface, step, meta->>variant, meta->>landingSlug) so the tests can
// assert BOTH per-page scoping (finding 3) and exact counting past the old 50k cap
// (finding 4). `.gte/.lte` (date range) are no-ops here; every row is in range.

const h = vi.hoisted(() => {
  type Row = {
    client_id: string;
    surface: string;
    step: string;
    meta: Record<string, unknown> | null;
    created_at: string;
    id: string;
  };
  let rows: Row[] = [];
  // Every window the paging loop asked for, in order. The scan's own request
  // shape is the thing ruling W3/32 is about, so it has to be observable.
  const ranges: Array<[number, number]> = [];

  const makeBuilder = () => {
    const eqs: Array<[string, unknown]> = [];
    let head = false;
    let range: [number, number] | null = null;

    const applyFilters = (): Row[] =>
      rows.filter((r) =>
        eqs.every(([col, val]) => {
          switch (col) {
            case "client_id":
              return r.client_id === val;
            case "surface":
              return r.surface === val;
            case "step":
              return r.step === val;
            case "meta->>variant":
              return (r.meta?.variant ?? null) === val;
            case "meta->>landingSlug":
              return (r.meta?.landingSlug ?? null) === val;
            default:
              return true;
          }
        }),
      );

    const b: Record<string, unknown> = {};
    b.select = (_cols: unknown, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) head = true;
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      eqs.push([col, val]);
      return b;
    };
    b.gte = () => b;
    b.lte = () => b;
    b.order = () => b;
    b.range = (from: number, to: number) => {
      range = [from, to];
      ranges.push([from, to]);
      return b;
    };
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const filtered = applyFilters();
      if (head) {
        return Promise.resolve({ count: filtered.length, data: null, error: null }).then(res, rej);
      }
      const slice = range ? filtered.slice(range[0], range[1] + 1) : filtered;
      return Promise.resolve({ data: slice.map((r) => ({ step: r.step })), error: null }).then(res, rej);
    };
    return b;
  };

  return {
    setRows: (r: Row[]) => {
      rows = r;
    },
    ranges,
    clearRanges: () => {
      ranges.length = 0;
    },
    serviceClient: vi.fn(() => ({ from: () => makeBuilder() })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";

import { funnelSummary, funnelVariantSummary } from "./events";

const fromIso = "2026-06-01T00:00:00.000Z";
const toIso = "2026-07-01T00:00:00.000Z";

let seq = 0;
function row(
  client_id: string,
  surface: string,
  step: string,
  meta: Record<string, unknown> | null,
  id?: string,
) {
  return { client_id, surface, step, meta, created_at: "2026-06-15T00:00:00.000Z", id: id ?? `id-${seq++}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  h.setRows([]);
  h.clearRanges();
});

describe("funnelVariantSummary — per-page scoping (finding 3)", () => {
  it("counts a page's own A/B traffic only, never another page's", async () => {
    h.setRows([
      // page-x
      row("vitality", "landing", "viewed", { variant: "a", landingSlug: "page-x" }),
      row("vitality", "landing", "viewed", { variant: "a", landingSlug: "page-x" }),
      row("vitality", "landing", "cta_clicked", { variant: "a", landingSlug: "page-x" }),
      row("vitality", "landing", "viewed", { variant: "b", landingSlug: "page-x" }),
      // page-y (must not leak into page-x)
      row("vitality", "landing", "viewed", { variant: "a", landingSlug: "page-y" }),
      row("vitality", "landing", "viewed", { variant: "a", landingSlug: "page-y" }),
      row("vitality", "landing", "cta_clicked", { variant: "b", landingSlug: "page-y" }),
    ]);

    const x = await funnelVariantSummary({ clientId: "vitality", surface: "landing", fromIso, toIso, landingSlug: "page-x" });
    expect(x.a).toEqual({ views: 2, ctaClicks: 1, leads: 0 });
    expect(x.b).toEqual({ views: 1, ctaClicks: 0, leads: 0 });

    const y = await funnelVariantSummary({ clientId: "vitality", surface: "landing", fromIso, toIso, landingSlug: "page-y" });
    expect(y.a).toEqual({ views: 2, ctaClicks: 0, leads: 0 });
    expect(y.b).toEqual({ views: 0, ctaClicks: 1, leads: 0 });
  });

  it("ignores rows for another client, and rows missing variant/slug", async () => {
    h.setRows([
      row("vitality", "landing", "viewed", { variant: "a", landingSlug: "page-x" }),
      row("other", "landing", "viewed", { variant: "a", landingSlug: "page-x" }), // different client
      row("vitality", "landing", "viewed", { variant: "a" }), // no landingSlug
      row("vitality", "landing", "viewed", { landingSlug: "page-x" }), // no variant
    ]);
    const res = await funnelVariantSummary({ clientId: "vitality", surface: "landing", fromIso, toIso, landingSlug: "page-x" });
    expect(res.a.views).toBe(1);
    expect(res.b.views).toBe(0);
  });
});

describe("funnel aggregation counts correctly past the old 50k cap (finding 4)", () => {
  it("funnelVariantSummary counts a bucket exactly beyond 50k (DB-side head-count)", async () => {
    const N = 51_000; // one past the old .limit(50_000) truncation point
    h.setRows(
      Array.from({ length: N }, (_, i) =>
        row("vitality", "landing", "viewed", { variant: "a", landingSlug: "page-x" }, `x-${i}`),
      ),
    );
    const res = await funnelVariantSummary({ clientId: "vitality", surface: "landing", fromIso, toIso, landingSlug: "page-x" });
    expect(res.a.views).toBe(N); // old fetch-and-tally would have capped this at 50_000
  });

  it("funnelSummary tallies EVERY row past 50k via pagination (no silent truncation)", async () => {
    const N = 51_000;
    h.setRows(
      Array.from({ length: N }, (_, i) =>
        row("vitality", "booking", i % 2 === 0 ? "viewed" : "slot_selected", null, `b-${i}`),
      ),
    );
    const steps = await funnelSummary({ clientId: "vitality", surface: "booking", fromIso, toIso });
    const viewed = steps.find((s) => s.step === "viewed")?.count ?? 0;
    const slot = steps.find((s) => s.step === "slot_selected")?.count ?? 0;
    expect(viewed + slot).toBe(N); // every row counted, not just the first 50_000
    expect(viewed).toBe(N / 2);
    expect(slot).toBe(N / 2);
  });
});

describe("funnelSummary — per-step shape", () => {
  it("returns per-step counts sorted by count descending", async () => {
    h.setRows([
      row("vitality", "assessment", "started", null),
      row("vitality", "assessment", "started", null),
      row("vitality", "assessment", "started", null),
      row("vitality", "assessment", "completed", null),
      row("other", "assessment", "started", null), // different client, excluded
    ]);
    const steps = await funnelSummary({ clientId: "vitality", surface: "assessment", fromIso, toIso });
    expect(steps[0]).toEqual({ step: "started", count: 3 });
    expect(steps[1]).toEqual({ step: "completed", count: 1 });
    expect(steps).toHaveLength(2);
  });

  it("returns an empty array when there are no rows", async () => {
    const steps = await funnelSummary({ clientId: "vitality", surface: "assessment", fromIso, toIso });
    expect(steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE PAGE THE SCAN ASKS FOR, AND WHY ITS WIDTH IS A RULE (programme ruling W3/32).
//
// Supabase clips every REST response at a server-side max-rows ceiling — measured
// on this project at POSTGREST_MAX_ROWS, with no error and no marker on the
// response. A read that asks for EXACTLY the ceiling therefore cannot tell a full
// page from a clipped one: both come back as a thousand rows. This scan does not
// currently rest on that distinction (it is anchored to a head-count and advances
// by rows.length), which is exactly how the constant sat on the ceiling for months
// without a single test noticing — so the property is pinned on the REQUEST, where
// it is observable, rather than on a tally that happens not to need it.
// ---------------------------------------------------------------------------
describe("the paging scan never asks for a page the server could clip (W3/32)", () => {
  // MUTATION: put SUMMARY_PAGE back to 1000 (or above). The tally stays correct
  // and every other test in this file stays green — and the loop has gone back to
  // asking for exactly as many rows as the server is willing to hand back, where
  // "the rows ran out" and "you were cut off" are the same observation.
  it("asks for windows strictly narrower than PostgREST's ceiling", async () => {
    const N = 3_000; // three pages' worth, so the width is asserted more than once
    h.setRows(
      Array.from({ length: N }, (_, i) => row("vitality", "booking", "viewed", null, `w-${i}`)),
    );

    const steps = await funnelSummary({ clientId: "vitality", surface: "booking", fromIso, toIso });
    expect(steps).toEqual([{ step: "viewed", count: N }]);

    expect(h.ranges.length, "the scan did not page at all").toBeGreaterThan(1);
    for (const [from, to] of h.ranges) {
      expect(
        to - from + 1,
        `a page of ${to - from + 1} rows is at or above the ${POSTGREST_MAX_ROWS}-row ceiling, so a clipped page would look like the last one`,
      ).toBeLessThan(POSTGREST_MAX_ROWS);
    }
  });

  // The narrowing on the final page is the other half: a loop that over-asks reads
  // rows it will not count, which is how a scan quietly costs more than its bound.
  it("narrows the last page to the rows still wanted", async () => {
    const N = 1_500;
    h.setRows(
      Array.from({ length: N }, (_, i) => row("vitality", "booking", "viewed", null, `t-${i}`)),
    );
    await funnelSummary({ clientId: "vitality", surface: "booking", fromIso, toIso });
    const last = h.ranges[h.ranges.length - 1];
    expect(last[1], "the last page reached past the rows the head-count promised").toBe(N - 1);
  });
});
