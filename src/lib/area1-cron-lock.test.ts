// AREA 1 (outbox/drain review): claim semantics of the cron lease-lock that the
// shared messaging drain relies on to never double-send an outbox row.
//
// The fake Supabase client below reproduces the guarantee the real Postgres row
// gives us: the conditional UPDATE (`... WHERE locked_until < now()`) executes
// atomically per call (Postgres serialises writers on the row lock and
// re-evaluates the WHERE clause after the blocking writer commits), so exactly
// one concurrent caller can win an expired lease.
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake cron_lock table mirroring migration 0022: name pk, locked_until default
// to_timestamp(0) (epoch, NOT NULL — a NULL default would make `lt()` never
// match and the lock unacquirable forever).
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  table: new Map<string, { locked_until: number }>(),
  failUpdate: false,
  failUpsert: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: (tableName: string) => {
      if (tableName !== "cron_lock") throw new Error(`unexpected table ${tableName}`);
      return {
        upsert(row: { name: string }) {
          return Promise.resolve().then(() => {
            if (state.failUpsert) throw new Error("db down");
            // ignoreDuplicates: insert-if-absent with the column default (epoch).
            if (!state.table.has(row.name)) state.table.set(row.name, { locked_until: 0 });
            return { data: null, error: null };
          });
        },
        update(values: { locked_until: string }) {
          const filters: { name?: string; ltIso?: string } = {};
          const exec = (withSelect: boolean) => {
            if (state.failUpdate) return { data: null, error: { message: "db error" } };
            const row = filters.name !== undefined ? state.table.get(filters.name) : undefined;
            if (!row) return { data: withSelect ? [] : null, error: null };
            if (filters.ltIso !== undefined && !(row.locked_until < Date.parse(filters.ltIso))) {
              return { data: withSelect ? [] : null, error: null }; // lease still held: 0 rows
            }
            row.locked_until = Date.parse(values.locked_until);
            return { data: withSelect ? [{ name: filters.name }] : null, error: null };
          };
          const chain = {
            eq(_col: string, v: string) { filters.name = v; return chain; },
            lt(_col: string, v: string) { filters.ltIso = v; return chain; },
            select(_cols: string) {
              // The mutation runs synchronously inside one promise tick = atomic,
              // exactly like the row-locked UPDATE in Postgres.
              return Promise.resolve().then(() => exec(true));
            },
            // releaseCronLock awaits update().eq() directly (no select).
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
              return Promise.resolve().then(() => exec(false)).then(onF, onR);
            },
          };
          return chain;
        },
      };
    },
  }),
}));

import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

beforeEach(() => {
  state.table.clear();
  state.failUpdate = false;
  state.failUpsert = false;
});

describe("acquireCronLock claim semantics", () => {
  it("first caller wins a fresh lock (epoch default is claimable)", async () => {
    await expect(acquireCronLock("drain", 280)).resolves.toBe(true);
    expect(state.table.get("drain")!.locked_until).toBeGreaterThan(Date.now());
  });

  it("a second caller cannot acquire while the lease is active", async () => {
    expect(await acquireCronLock("drain", 280)).toBe(true);
    expect(await acquireCronLock("drain", 280)).toBe(false);
  });

  it("exactly one of two concurrent callers wins (atomic conditional update)", async () => {
    const results = await Promise.all([
      acquireCronLock("drain", 280),
      acquireCronLock("drain", 280),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("locks are independent per name", async () => {
    expect(await acquireCronLock("drain", 280)).toBe(true);
    expect(await acquireCronLock("sweep-recall", 280)).toBe(true);
  });

  it("an expired lease is re-claimable by the next tick (crash self-heal)", async () => {
    expect(await acquireCronLock("drain", 280)).toBe(true);
    // Simulate the lease expiring (crashed run never released).
    state.table.get("drain")!.locked_until = Date.now() - 1000;
    expect(await acquireCronLock("drain", 280)).toBe(true);
  });

  it("release makes the lock immediately re-claimable", async () => {
    expect(await acquireCronLock("drain", 280)).toBe(true);
    await releaseCronLock("drain");
    expect(await acquireCronLock("drain", 280)).toBe(true);
  });

  it("fails safe (returns false, skipping the run) on a DB update error", async () => {
    state.failUpdate = true;
    expect(await acquireCronLock("drain", 280)).toBe(false);
  });

  it("fails safe on a thrown DB error during upsert", async () => {
    state.failUpsert = true;
    expect(await acquireCronLock("drain", 280)).toBe(false);
  });

  it("DOCUMENTS THE OVERLAP HAZARD: a run that outlives its lease can be overlapped, so the lease TTL must exceed the route maxDuration", async () => {
    // Run A acquires with a TTL shorter than how long it actually executes.
    expect(await acquireCronLock("drain", 280)).toBe(true);
    // 281s later run A is STILL executing (maxDuration allows up to 300s)...
    state.table.get("drain")!.locked_until = Date.now() - 1000;
    // ...and run B acquires the lock while A is mid-drain: both now iterate
    // 'queued' rows. The only way to close this window is ttl > maxDuration,
    // which the drain route now uses (see area1-drain-pipeline.test.ts guard).
    expect(await acquireCronLock("drain", 280)).toBe(true);
  });
});
