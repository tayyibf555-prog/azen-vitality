import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isPerioEnabled, canSavePerio, PERIO_COPY, PERIO_ENV_FLAG } from "./gate";

describe("isPerioEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  /**
   * The shipped state.
   *
   * Dentally's API exposes no periodontal resource, so nothing here mirrors
   * anything: switching this on makes this platform the system of record for a
   * patient's periodontal findings while Dentally's own Perio tab still exists.
   * That is the practice's decision, in writing. A default of false is what makes
   * "we built it and left it off" true rather than aspirational.
   */
  it("defaults to false when the variable is not set at all", () => {
    const saved = process.env.PERIO_ENABLED;
    delete process.env.PERIO_ENABLED;
    try {
      expect(isPerioEnabled()).toBe(false);
      expect(canSavePerio()).toBe(false);
    } finally {
      if (saved !== undefined) process.env.PERIO_ENABLED = saved;
    }
  });

  it("is false for the literal string false", () => {
    vi.stubEnv("PERIO_ENABLED", "false");
    expect(isPerioEnabled()).toBe(false);
    expect(canSavePerio()).toBe(false);
  });

  /**
   * A near miss must not switch on a second clinical record. "1" and "TRUE" are
   * the two a hurried deploy actually types, and " true" is what a copy-paste
   * out of a spreadsheet produces.
   */
  it("turns on only for the exact string true, never for a truthy near miss", () => {
    for (const value of ["1", "TRUE", "True", "yes", "on", " true", "true ", ""]) {
      vi.stubEnv("PERIO_ENABLED", value);
      expect(isPerioEnabled(), `"${value}" must not enable perio`).toBe(false);
      expect(canSavePerio(), `"${value}" must not enable perio writes`).toBe(false);
    }
    vi.stubEnv("PERIO_ENABLED", "true");
    expect(isPerioEnabled()).toBe(true);
    expect(canSavePerio()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The flag is a SERVER flag. These tests are what makes that a fact rather than
// a comment: a client component reading process.env.PERIO_ENABLED would inline
// `false` into the bundle at build time and then disagree with the server the
// moment the practice switches perio on.
// ---------------------------------------------------------------------------

const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));
const GATE = fileURLToPath(new URL("./gate.ts", import.meta.url));

/** Every shipped .ts/.tsx under src/, read once. Scoped through import.meta.url
 *  so it never walks .claude/worktrees, which are full copies of this repository.
 *  Tests are excluded because a test that stubs the variable is not a shipped
 *  reader of it -- and this file is one. */
function sourceFiles(dir: string, out: { path: string; source: string }[] = []) {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) {
      sourceFiles(`${path}/`, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push({ path, source: readFileSync(path, "utf8") });
    }
  }
  return out;
}

describe("the perio flag never reaches a browser", () => {
  it("is read in exactly one module in the whole of src/", () => {
    const readers = sourceFiles(SRC_DIR)
      .filter(({ source }) => source.includes("process.env.PERIO_ENABLED"))
      .map(({ path }) => path);
    expect(readers).toEqual([GATE]);
  });

  it("is never exposed under a NEXT_PUBLIC_ name anywhere", () => {
    for (const { path, source } of sourceFiles(SRC_DIR)) {
      expect(source, `${path} exposes the perio flag to the client`).not.toContain(
        "NEXT_PUBLIC_PERIO",
      );
    }
  });

  it("keeps the server-only import that makes a client import a build error", () => {
    expect(readFileSync(GATE, "utf8")).toContain('import "server-only"');
  });
});

// ---------------------------------------------------------------------------
// The copy. These sentences are the entire user-visible behaviour of a switched
// off feature, so they are tested like any other clinical-honesty claim.
// ---------------------------------------------------------------------------

describe("PERIO_COPY", () => {
  it("names the environment variable, so a 503 is actionable rather than mysterious", () => {
    expect(PERIO_ENV_FLAG).toBe("PERIO_ENABLED");
    expect(PERIO_COPY.disabled).toContain(PERIO_ENV_FLAG);
  });

  /**
   * CHARTING.md 6.3: the failure mode is not missing data, it is FALSE
   * COMPLETENESS. A dentist with twenty seconds reads an empty periodontal
   * section as "no periodontal problems", which is indistinguishable from a
   * genuine BPE 0. The disabled sentence has to say where the data actually is.
   */
  it("sends the reader to Dentally rather than implying the patient is clean", () => {
    expect(PERIO_COPY.disabled).toContain("Dentally");
    expect(PERIO_COPY.disabled).toMatch(/not a statement about this patient/i);
  });

  /**
   * BPE has been a mandatory FP17 field since 1 October 2022. Recording it here
   * while claims go out of Dentally is double entry on a mandatory claim field.
   * The code is not allowed to pretend otherwise.
   */
  it("states the FP17 double-entry consequence out loud", () => {
    expect(PERIO_COPY.doubleEntry).toContain("FP17");
    expect(PERIO_COPY.doubleEntry).toMatch(/mandatory/i);
    expect(PERIO_COPY.doubleEntry).toMatch(/disagree|twice|also be entered/i);
  });

  it("distinguishes a failed read from an absence of findings", () => {
    expect(PERIO_COPY.readFailed).toMatch(/not a finding that there are none/i);
  });

  /** GDC 4.1.4: the treating clinician is on the record. No shared identity. */
  it("explains a refused write rather than inventing an author", () => {
    expect(PERIO_COPY.noAuthor).toMatch(/clinician/i);
    expect(PERIO_COPY.noAuthor).toMatch(/nothing was saved/i);
  });
});
