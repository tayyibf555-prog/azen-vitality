import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, vi } from "vitest";
import { canSaveChartDraft, canWriteChartToDentally, isChartDraftEnabled } from "./write-gate";

describe("canWriteChartToDentally", () => {
  afterEach(() => vi.unstubAllEnvs());

  // Dentally publishes no create route on ANY charting resource: POST 404s on
  // all five. No configuration can make a route exist, so no environment
  // variable may turn this on.
  it("is false with no environment at all", () => {
    expect(canWriteChartToDentally()).toBe(false);
  });

  it("stays false even with the appointment write path fully configured", () => {
    vi.stubEnv("DENTALLY_WRITE_ENABLED", "true");
    vi.stubEnv("DENTALLY_WRITE_API_KEY", "k");
    vi.stubEnv("DENTALLY_WRITE_BASE_URL", "https://sandbox.dentally.co");
    vi.stubEnv("CHART_DRAFT_ENABLED", "true");
    expect(canWriteChartToDentally()).toBe(false);
  });
});

describe("isChartDraftEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The brief authorises a read-only mirror. Planning stored in our own table
  // is a second clinical record, and that is the practice manager's decision.
  it("defaults to false, so the shipped screen is a pure mirror", () => {
    expect(isChartDraftEnabled()).toBe(false);
    expect(canSaveChartDraft()).toBe(false);
  });

  it("turns on only for the exact string true, never for a truthy near miss", () => {
    for (const value of ["1", "TRUE", "yes", "on", " true", ""]) {
      vi.stubEnv("CHART_DRAFT_ENABLED", value);
      expect(isChartDraftEnabled()).toBe(false);
    }
    vi.stubEnv("CHART_DRAFT_ENABLED", "true");
    expect(isChartDraftEnabled()).toBe(true);
    expect(canSaveChartDraft()).toBe(true);
  });
});

/**
 * The guard that actually catches a control wired to the wrong gate.
 *
 * Comparing the two functions as references would be a tautology that passes
 * forever, so this reads the source instead. Scoped through import.meta.url the
 * way colours.test.ts does, so it never walks .claude/worktrees, which are full
 * repo copies.
 */
const CHART_UI_DIR = fileURLToPath(
  new URL("../../components/client/patients/record/chart/", import.meta.url),
);

/** Labels that only ever appear on a control which would WRITE to Dentally. */
const WRITE_CONTROL_LABELS = ["New treatment plan", "Select template", "Record New BPE"];

function chartUiFiles(): { name: string; source: string }[] {
  if (!existsSync(CHART_UI_DIR)) return [];
  return readdirSync(CHART_UI_DIR)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((name) => ({ name, source: readFileSync(`${CHART_UI_DIR}${name}`, "utf8") }));
}

describe("the two gates cannot be confused", () => {
  it("puts every Dentally-write control behind canWriteChartToDentally", () => {
    for (const { name, source } of chartUiFiles()) {
      const rendersWriteControl = WRITE_CONTROL_LABELS.some((label) => source.includes(label));
      if (!rendersWriteControl) continue;
      expect(source, `${name} renders a Dentally write control`).toContain(
        "canWriteChartToDentally",
      );
    }
  });

  it("keeps the draft flag in the workspace alone, so no leaf decides for itself whether planning is on", () => {
    for (const { name, source } of chartUiFiles()) {
      if (name === "chart-workspace.tsx") continue;
      expect(source, `${name} must not read the draft flag`).not.toContain("isChartDraftEnabled");
    }
  });

  it("never lets a chart file reach Dentally's write client", () => {
    for (const { name, source } of chartUiFiles()) {
      expect(source, `${name} must not import the Dentally write path`).not.toMatch(
        /from\s+"@\/lib\/dentally\/write"/,
      );
    }
  });
});
