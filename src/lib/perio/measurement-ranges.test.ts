import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  MAX_PROBING_DEPTH_MM,
  MAX_RECESSION_MM,
  MIN_RECESSION_MM,
  validatePocketChart,
} from "./pocket-chart";
import type { PerioAttribution } from "./types";

// ===========================================================================
// ONE MEASUREMENT, ONE RANGE.
//
// WHY THIS FILE EXISTS. A probing depth and a recession each had their range
// written down three times: in the engine, again in the entry grid's own
// constants, and a third time — DIFFERENTLY — in the database. 0066_perio.sql
// allowed a recession of -10 to 20 while pocket-chart.ts allowed -5 to 15.
//
// Nothing bad could reach the table through the app, because the app was the
// stricter of the two. That is exactly what made it easy to leave: a divergence
// with no symptom. But a check constraint is the last line if anything ever
// writes directly (a backfill, a support query, a future route), and a
// measurement with two definitions has already started drifting.
//
// So the engine owns the numbers, the grid imports them, and this file reads the
// SQL and fails if the constraint and the constant ever stop agreeing. A test
// that merely asserted "-5" twice would pass while the database said -10; the
// only honest check is to read the other file.
// ===========================================================================

const REPO = new URL("../../../", import.meta.url);
const SQL = readFileSync(fileURLToPath(new URL("supabase/migrations/0066_perio.sql", REPO)), "utf8");
const ENTRY_GRID = readFileSync(
  fileURLToPath(new URL("src/components/client/patients/record/perio/pocket-chart.tsx", REPO)),
  "utf8",
);

/** The `between X and Y` of one column's check constraint. */
function sqlRange(column: string): { min: number; max: number } {
  const found = new RegExp(`check\\s*\\(${column}\\s+between\\s+(-?\\d+)\\s+and\\s+(-?\\d+)\\)`).exec(
    SQL,
  );
  if (!found) throw new Error(`0066_perio.sql has no range check on ${column}`);
  return { min: Number(found[1]), max: Number(found[2]) };
}

describe("the database and the engine agree about what a measurement can be", () => {
  it("bounds a probing depth identically in both", () => {
    expect(sqlRange("probing_depth_mm")).toEqual({ min: 0, max: MAX_PROBING_DEPTH_MM });
  });

  it("bounds a recession identically in both, including the negative end", () => {
    // The one that was actually wrong. -10/20 in SQL against -5/15 in the engine.
    expect(sqlRange("recession_mm")).toEqual({ min: MIN_RECESSION_MM, max: MAX_RECESSION_MM });
  });

  it("keeps recession signed, because a margin can sit coronal to the CEJ", () => {
    // A future "tidy-up" that clamps the floor at 0 would inflate every CAL
    // computed from an unrecessed deep pocket.
    expect(MIN_RECESSION_MM).toBeLessThan(0);
    expect(sqlRange("recession_mm").min).toBeLessThan(0);
  });

  it("keeps the generated CAL inside a smallint at both extremes", () => {
    // cal_mm is `generated always as ((probing_depth_mm + recession_mm)::smallint)`.
    // A range widened without thinking is how that cast starts overflowing.
    expect(MAX_PROBING_DEPTH_MM + MAX_RECESSION_MM).toBeLessThanOrEqual(32767);
    expect(0 + MIN_RECESSION_MM).toBeGreaterThanOrEqual(-32768);
  });
});

describe("the entry grid does not keep a second copy of the ranges", () => {
  it("imports them from the engine rather than declaring its own", () => {
    // The grid used to declare MAX_DEPTH_MM / MAX_RECESSION_MM / MIN_RECESSION_MM
    // of its own, "mirroring" the engine's. Two hand-written copies of one number
    // is how the third copy in SQL went unnoticed for as long as it did.
    expect(ENTRY_GRID).not.toMatch(/^\s*const\s+(MAX_DEPTH_MM|MAX_RECESSION_MM|MIN_RECESSION_MM)\s*=/m);
    expect(ENTRY_GRID).toMatch(/MAX_PROBING_DEPTH_MM/);
    expect(ENTRY_GRID).toMatch(/from "@\/lib\/perio\/pocket-chart"/);
  });
});

// ---------------------------------------------------------------------------
// And the engine still enforces them, so the constants are not decoration.
// ---------------------------------------------------------------------------

const RECORDED: PerioAttribution = {
  clinician: { id: "u1", name: "Blerta Hoxha", gdcNumber: null },
  at: "2026-08-02T09:00:00.000Z",
};

function chartWith(recession: number) {
  return {
    sextants: ["UR"] as const,
    teeth: [
      {
        tooth: 16,
        mobility: null,
        furcation: null,
        sites: [
          { site: "mb" as const, probingDepth: 4, recession, bleeding: false, suppuration: false, plaque: false },
        ],
      },
    ],
    recorded: RECORDED,
  };
}

describe("the engine refuses a recession outside the agreed range", () => {
  it("accepts the extremes", () => {
    expect(validatePocketChart(chartWith(MIN_RECESSION_MM))).toEqual([]);
    expect(validatePocketChart(chartWith(MAX_RECESSION_MM))).toEqual([]);
  });

  it("refuses one millimetre past either end, in words", () => {
    expect(validatePocketChart(chartWith(MIN_RECESSION_MM - 1)).join(" ")).toMatch(/recession of/);
    expect(validatePocketChart(chartWith(MAX_RECESSION_MM + 1)).join(" ")).toMatch(/recession of/);
  });
});
