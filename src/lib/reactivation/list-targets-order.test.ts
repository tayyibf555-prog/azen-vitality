// With the one year cap removed the addressable pool grows about sevenfold, so the
// ORDER of the worklist stops being cosmetic: ranked purely by recoverable value, a
// patient lapsed thirteen months sits behind one lapsed eight years. The worklist is
// therefore ordered most-recently-lapsed FIRST, with value as the tie break, and the
// enrolment pass reads a bounded window of it rather than the whole book.
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Call {
  method: string;
  args: unknown[];
}

const store = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/server", () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "in", "eq", "order", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      store.calls.push({ method, args });
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: store.rows, error: null });
  return { serviceClient: () => ({ from: (table: string) => { store.calls.push({ method: "from", args: [table] }); return chain; } }) };
});

import { listTargets } from "./repository";

function orderCalls(): Call[] {
  return store.calls.filter((c) => c.method === "order");
}

beforeEach(() => {
  store.calls = [];
  store.rows = [];
});

describe("listTargets ordering", () => {
  it("orders the most recently lapsed first, then by recoverable value", async () => {
    await listTargets({ siteIds: ["site-cc"] });

    const orders = orderCalls();
    expect(orders[0].args[0]).toBe("last_visit_at");
    expect(orders[0].args[1]).toMatchObject({ ascending: false, nullsFirst: false });
    // Value still breaks ties between patients who lapsed at the same moment.
    expect(orders[1].args[0]).toBe("reactivation_score");
    expect(orders[1].args[1]).toMatchObject({ ascending: false });
  });

  it("takes no row limit unless one is asked for", async () => {
    await listTargets({ siteIds: ["site-cc"] });
    expect(store.calls.some((c) => c.method === "limit")).toBe(false);
  });

  it("bounds the read when the caller asks for a window", async () => {
    await listTargets({ siteIds: ["site-cc"], statuses: ["dormant"], limit: 1000 });
    expect(store.calls.find((c) => c.method === "limit")?.args).toEqual([1000]);
  });

  it("ignores a nonsense limit rather than fetching one row or none", async () => {
    await listTargets({ siteIds: ["site-cc"], limit: 0 });
    expect(store.calls.some((c) => c.method === "limit")).toBe(false);
  });
});
