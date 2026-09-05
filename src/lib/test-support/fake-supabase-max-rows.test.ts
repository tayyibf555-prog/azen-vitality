// ===========================================================================
// THE FAKE CLIPS AT A THOUSAND ROWS, BECAUSE THE REAL DATABASE DOES.
//
// WHAT THIS PINS, and why it is a test about a TEST TOOL. Supabase applies a
// server-side max-rows ceiling to every REST request — measured on this project
// at 1,000 with the service-role key: `limit=1500` and `limit=2001` both returned
// exactly a thousand rows, `content-range: 0-999/*`, no error. A clipped response
// is indistinguishable from a short one, so a read that never asked for a page
// gets a thousand rows and no hint that there were more.
//
// This tree has found and fixed that same defect four separate times — a
// `select()` with no `.limit()`/`.range()` whose row count was then printed as a
// total: task-queue/repository.ts, coordinator/repository.ts, telemetry.ts and
// triage/repository.ts. Every one of them was green against this fake, because
// the fake handed back every row it was holding. A mock more generous than live
// does not merely fail to catch the bug; it certifies it.
//
// So the rule (charter §0/11, "the mock must be at least as strict as live") is
// that the ceiling is modelled, and these tests are what make it a rule rather
// than a line of code someone can delete without anything going red. They are
// deliberately about the SEAM the defect lives on: how many rows come back, and
// what `count` says while they do.
//
// THE ASYMMETRY IN THE LAST BLOCK IS THE POINT. PostgREST reports the true total
// in `content-range` even when it clipped the body, which is precisely why
// charter §0/5 prefers a `count: 'exact', head: true` read for a figure that
// reaches a screen. A fake that clipped the count as well would hide the one
// property that makes an honest total cheap.
// ===========================================================================
import { describe, it, expect, beforeEach } from "vitest";

import { createFakeSupabase, POSTGREST_MAX_ROWS } from "@/lib/test-support/fake-supabase";

const world = createFakeSupabase();

// A real table with a real migration, so the fake's own "no create table" guard
// is satisfied and the shape under test is a shape the platform actually holds.
const TABLE = "dentally_write_intent";

/** Seed n rows whose `id` carries their seeded position, so order is checkable. */
function seedRows(n: number): void {
  world.seed(
    TABLE,
    ...Array.from({ length: n }, (_, i) => ({
      id: `intent-${String(i).padStart(5, "0")}`,
      client_id: "vitality",
      site_id: "site-cc",
      kind: "appointment.create",
      source: "recall",
      target: "api.dentally.co",
      payload_summary: {},
      status: "blocked",
    })),
  );
}

beforeEach(() => {
  world.reset();
});

describe("the fake models PostgREST's max-rows ceiling", () => {
  it("clips an unranged select at a thousand rows, exactly as live does", async () => {
    seedRows(POSTGREST_MAX_ROWS + 1);
    const { data, error } = await world.client.from(TABLE).select("*");
    // No error, same as live — this is the whole hazard. A truncated read that
    // announced itself would never have cost this tree four defects.
    expect(error).toBeNull();
    expect((data as unknown[]).length).toBe(POSTGREST_MAX_ROWS);
  });

  it("a .limit() above the ceiling does not lift it — limit(2001) still returns a thousand", async () => {
    seedRows(1500);
    const { data } = await world.client.from(TABLE).select("*").limit(2001);
    expect((data as unknown[]).length).toBe(POSTGREST_MAX_ROWS);
  });

  it("a .range() wider than the ceiling is clipped too, and the offset still lands first", async () => {
    seedRows(1200);
    const { data } = await world.client.from(TABLE).select("*").range(5, 1204);
    const rows = data as Array<{ id: string }>;
    expect(rows.length).toBe(POSTGREST_MAX_ROWS);
    // The window is applied before the ceiling, so row 5 is still where the page
    // starts — a ceiling that replaced the range would silently re-read page one.
    expect(rows[0].id).toBe("intent-00005");
  });

  it("does not clip a read that stayed under the ceiling", async () => {
    seedRows(POSTGREST_MAX_ROWS + 1);
    const { data } = await world.client.from(TABLE).select("*").limit(3);
    expect((data as unknown[]).length).toBe(3);
  });

  it("a table smaller than the ceiling comes back whole, and exactly at it nothing is lost", async () => {
    seedRows(7);
    const small = await world.client.from(TABLE).select("*");
    expect((small.data as unknown[]).length).toBe(7);

    world.reset();
    seedRows(POSTGREST_MAX_ROWS);
    const exact = await world.client.from(TABLE).select("*");
    expect((exact.data as unknown[]).length).toBe(POSTGREST_MAX_ROWS);
  });

  it("reports the TRUE total on a clipped read, so an honest count is still reachable", async () => {
    seedRows(POSTGREST_MAX_ROWS + 234);
    const { data, count } = await world.client.from(TABLE).select("id", { count: "exact" });
    // The body is clipped...
    expect((data as unknown[]).length).toBe(POSTGREST_MAX_ROWS);
    // ...and the count is not. This is the asymmetry charter §0/5 leans on.
    expect(count).toBe(POSTGREST_MAX_ROWS + 234);
  });

  it("the ceiling can be LOWERED for a test, so truncation is provable without seeding a thousand rows", async () => {
    const tiny = createFakeSupabase({ maxRows: 3 });
    tiny.seed(
      TABLE,
      ...Array.from({ length: 4 }, (_, i) => ({ id: `x-${i}`, client_id: "vitality", status: "blocked" })),
    );
    const { data, count } = await tiny.client.from(TABLE).select("id", { count: "exact" });
    expect((data as unknown[]).length).toBe(3);
    // Still the true total, so the "at least" sentence has something to be about.
    expect(count).toBe(4);
  });

  it("the ceiling can NEVER be raised above the measured one, whatever a test asks for", async () => {
    // The option exists to make a scenario STRICTER. If it could also loosen, the
    // very defect class this models would come back through the door marked exit.
    const greedy = createFakeSupabase({ maxRows: 50_000 });
    expect(greedy.db.maxRows).toBe(POSTGREST_MAX_ROWS);
    greedy.seed(
      TABLE,
      ...Array.from({ length: POSTGREST_MAX_ROWS + 1 }, (_, i) => ({ id: `y-${i}`, client_id: "vitality" })),
    );
    const { data } = await greedy.client.from(TABLE).select("*").limit(50_000);
    expect((data as unknown[]).length).toBe(POSTGREST_MAX_ROWS);
  });

  it("the ceiling is the measured one, not a round number someone liked", () => {
    // limit=1500 and limit=2001 both returned exactly 1,000 rows with
    // `content-range: 0-999/*` against this project's Supabase. Raising this
    // constant makes the fake more generous than the database it stands in for.
    expect(POSTGREST_MAX_ROWS).toBe(1000);
  });
});
