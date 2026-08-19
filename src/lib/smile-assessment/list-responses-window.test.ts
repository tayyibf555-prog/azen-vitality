import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * listResponses' optional window, which the co-pilot's "who filled this in
 * today" tool depends on. The stub records the filters, because the point of the
 * window is that it is a PREDICATE: applied after the fact it would silently drop
 * the earliest enquiries of a day busier than the row bound.
 */

type Call = [string, ...unknown[]];

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const result = { data: [] as unknown, error: null as unknown };
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "gte", "lt", "not", "order", "limit"]) {
      b[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return b;
      };
    }
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return b;
  };
  return {
    calls,
    reset: () => {
      calls.length = 0;
    },
    serviceClient: vi.fn(() => ({
      from: (t: string) => {
        calls.push(["from", t]);
        return makeBuilder();
      },
    })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { listResponses } from "./repository";

function issued(...call: Call): boolean {
  return h.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));
}

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

it("issues no created_at filter when no window was asked for", async () => {
  // Every pre-existing caller (the module page, the task queue, notifications,
  // the API list route) passes none, and must behave exactly as before.
  await listResponses({ siteIds: ["site-cc"] });
  expect(issued("in", "site_id", ["site-cc"])).toBe(true);
  expect(h.calls.some((c) => c[0] === "gte")).toBe(false);
});

it("pushes the window into the query", async () => {
  await listResponses({ siteIds: ["site-cc"], sinceIso: "2026-08-17T00:00:00.000Z" });
  expect(issued("gte", "created_at", "2026-08-17T00:00:00.000Z")).toBe(true);
});

it("keeps the site scope, the band filter and the bound alongside it", async () => {
  await listResponses({ siteIds: ["site-cc"], bands: ["high"], sinceIso: "2026-08-17T00:00:00.000Z", limit: 100 });
  expect(issued("in", "site_id", ["site-cc"])).toBe(true);
  expect(issued("in", "band", ["high"])).toBe(true);
  expect(issued("limit", 100)).toBe(true);
});

describe("newest first", () => {
  it("orders by created_at descending so a bound trims the OLDEST, not the newest", async () => {
    await listResponses({ siteIds: ["site-cc"], sinceIso: "2026-08-17T00:00:00.000Z" });
    expect(issued("order", "created_at", { ascending: false })).toBe(true);
  });
});
