// THE AGENT'S HISTORY READ IS BOUNDED, AND BOUNDED AT THE RIGHT END.
//
// An agent_conversation is per (site, patient, channel) and is only replaced once
// it is CLOSED, so a returning patient's thread accumulates for as long as they
// are a patient. The booking agent re-sends that whole thread to Claude on every
// round of every turn, so an unbounded read is an unbounded bill on a table that
// only grows.
//
// The direction of the bound is the part that is not just about money. PostgREST
// enforces its own row ceiling (db-max-rows) on the query AS WRITTEN: an
// ascending, unlimited read that hits a ceiling keeps the OLDEST rows and drops
// the newest, which for this caller means the agent replying to a message it was
// never shown. Reading newest-first and reversing makes any such ceiling
// harmless — the rows it could take are the ones being dropped on purpose.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

interface Row {
  id: string;
  conversation_id: string;
  role: string;
  body: string;
  tool_name: string | null;
  created_at: string;
}

const db = vi.hoisted(() => ({
  /** Every query built this run, in the order the chain was called. */
  queries: [] as Array<{
    table: string;
    orders: Array<{ column: string; ascending: boolean }>;
    limit: number | null;
  }>,
  rows: [] as Row[],
}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q = { table, orders: [] as Array<{ column: string; ascending: boolean }>, limit: null as number | null };
      db.queries.push(q);
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: (column: string, o?: { ascending?: boolean }) => {
          q.orders.push({ column, ascending: o?.ascending !== false });
          return chain;
        },
        limit: (n: number) => {
          q.limit = n;
          return chain;
        },
      };
      return Object.assign(chain, {
        // The real client returns rows in the order the query asked for; model that,
        // or the reverse below would be untested.
        then: (resolve: (v: unknown) => void) => {
          const ordered = [...db.rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
          const desc = q.orders.some((o) => o.column === "created_at" && !o.ascending);
          const rows = desc ? ordered.reverse() : ordered;
          resolve({ data: q.limit ? rows.slice(0, q.limit) : rows, error: null });
        },
      });
    },
  }),
}));

import { listMessages } from "./repository";

function thread(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${String(i).padStart(4, "0")}`,
    conversation_id: "conv-1",
    role: i % 2 === 0 ? "patient" : "agent",
    body: `message ${i}`,
    tool_name: null,
    // One a minute, so ordering is unambiguous.
    created_at: new Date(Date.UTC(2026, 7, 21, 0, i)).toISOString(),
  }));
}

beforeEach(() => {
  db.queries = [];
  db.rows = [];
});

describe("listMessages window", () => {
  it("without a limit, reads the whole thread ascending (the staff inbox, unchanged)", async () => {
    db.rows = thread(5);
    const out = await listMessages("conv-1");
    expect(out.map((m) => m.body)).toEqual([
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "message 4",
    ]);
    expect(db.queries[0].limit).toBeNull();
    expect(db.queries[0].orders).toEqual([{ column: "created_at", ascending: true }]);
  });

  it("with a limit, asks the DATABASE for the newest n — it does not read everything and slice in memory", async () => {
    db.rows = thread(200);
    await listMessages("conv-1", { limit: 60 });
    const q = db.queries[0];
    expect(q.table).toBe("agent_message");
    expect(q.limit).toBe(60);
    // Descending, or the limit would take the wrong end.
    expect(q.orders[0]).toEqual({ column: "created_at", ascending: false });
    // Tie-broken on id: this table ingests several rows inside one millisecond
    // (an inbound and the reply to it), and without this the boundary of the
    // window could fall between two of them differently on each read.
    expect(q.orders[1]).toEqual({ column: "id", ascending: false });
  });

  it("returns the newest n but still OLDEST-FIRST, which is the order the model needs", async () => {
    db.rows = thread(200);
    const out = await listMessages("conv-1", { limit: 60 });
    expect(out).toHaveLength(60);
    expect(out[0].body).toBe("message 140");
    expect(out[59].body).toBe("message 199");
    const times = out.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("ALWAYS includes the most recent message — the one the agent is replying to", async () => {
    for (const n of [1, 2, 59, 60, 61, 500]) {
      db.queries = [];
      db.rows = thread(n);
      const out = await listMessages("conv-1", { limit: 60 });
      expect(out.at(-1)?.body, `thread of ${n}`).toBe(`message ${n - 1}`);
      expect(out.length).toBe(Math.min(n, 60));
    }
  });

  it("is a no-op for any thread shorter than the window (every real conversation)", async () => {
    db.rows = thread(24);
    const windowed = await listMessages("conv-1", { limit: 60 });
    db.queries = [];
    const whole = await listMessages("conv-1");
    expect(windowed).toEqual(whole);
  });

  it("ignores a nonsense limit rather than returning an empty history", async () => {
    // NaN is the real case: the caller reads AGENT_HISTORY_MESSAGES out of the
    // environment with Number(), so a typo in a deployment variable arrives here.
    // Falling back to the whole thread is the safe direction — the agent answers
    // with more context than intended, never with none.
    db.rows = thread(5);
    for (const limit of [0, -1, Number.NaN]) {
      expect((await listMessages("conv-1", { limit })).length, `limit ${limit}`).toBe(5);
    }
  });
});
