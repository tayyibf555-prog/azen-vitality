import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 10 (speed-to-lead): the CLAIM RACE.
//
// Core correctness property: two workers/ticks cannot both claim + first-contact
// the SAME lead. The claim is a single conditional UPDATE:
//   UPDATE speed_to_lead_lead SET stage='contacting'
//   WHERE id=$1 AND stage='new' RETURNING id
// Exactly one caller can flip 'new' -> 'contacting'; the loser's WHERE matches no
// row (stage is already 'contacting'), so it returns 0 rows -> false.
//
// We model the conditional UPDATE with a single-row store whose update honours
// BOTH the id and the stage predicate, and only returns the row when it actually
// flipped. This is exactly the semantics a real Postgres UPDATE...WHERE gives, so
// proving the invariant here proves it against the DB contract the code relies on.

// A minimal in-memory row + a query builder that mimics the supabase-js chain the
// repository uses: .from().update().eq().eq().select() resolving to { data }.
interface Row {
  id: string;
  stage: string;
  first_response_at: string | null;
  updated_at: string;
}

function makeStore(initial: Row) {
  const row = { ...initial };
  // Serialise updates so we model an atomic conditional UPDATE (Postgres row lock):
  // one statement at a time sees-and-flips. Concurrency at the JS layer is
  // interleaved by the event loop, but each update() below is synchronous over the
  // shared `row`, matching the DB's per-row atomicity.
  function update(patch: Record<string, unknown>) {
    const preds: Array<[string, unknown]> = [];
    const builder = {
      eq(col: string, val: unknown) {
        preds.push([col, val]);
        return builder;
      },
      select() {
        // Apply only if EVERY predicate currently holds.
        const matches = preds.every(([col, val]) => (row as Record<string, unknown>)[col] === val);
        if (matches) {
          Object.assign(row, patch);
          return Promise.resolve({ data: [{ id: row.id }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
    };
    return builder;
  }
  const db = {
    from() {
      return { update };
    },
    _row: () => row,
  };
  return db;
}

let store: ReturnType<typeof makeStore>;
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => store }));

import { claimLeadForContact } from "./repository";

beforeEach(() => {
  store = makeStore({
    id: "lead-1",
    stage: "new",
    first_response_at: null,
    updated_at: "2026-07-01T09:00:00Z",
  });
});

describe("claimLeadForContact atomic claim", () => {
  it("returns true exactly once when two callers race the same 'new' lead", async () => {
    // Fire both claims "concurrently" (both start before either resolves).
    const [a, b] = await Promise.all([
      claimLeadForContact("lead-1"),
      claimLeadForContact("lead-1"),
    ]);
    const winners = [a, b].filter(Boolean).length;
    expect(winners).toBe(1);
    // The lead is left claimed exactly once.
    expect(store._row().stage).toBe("contacting");
  });

  it("a third claim after a win loses (stage no longer 'new')", async () => {
    expect(await claimLeadForContact("lead-1")).toBe(true);
    expect(await claimLeadForContact("lead-1")).toBe(false);
    expect(await claimLeadForContact("lead-1")).toBe(false);
  });

  it("does not claim a lead already past 'new' (intake won the flip first)", async () => {
    // Intake already advanced the lead to 'contacted'; the sweep must skip it.
    (store._row() as Row).stage = "contacted";
    expect(await claimLeadForContact("lead-1")).toBe(false);
    expect(store._row().stage).toBe("contacted");
  });

  it("N concurrent sweeps still yield exactly one winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => claimLeadForContact("lead-1")),
    );
    expect(results.filter(Boolean).length).toBe(1);
  });
});
