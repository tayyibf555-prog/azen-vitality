import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isMedicalHistoryEnabled,
  canCaptureMedicalHistory,
  MEDICAL_COPY,
  MEDICAL_HISTORY_ENV_FLAG,
} from "./gate";

describe("isMedicalHistoryEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  /**
   * The shipped state. Dentally's /v1/medical_histories is permanently empty for
   * this practice, so switching this on makes this platform the system of record
   * for a patient's medical history while Dentally's own record still exists. A
   * default of false is what makes "we built it and left it off" true.
   */
  it("defaults to false when the variable is not set at all", () => {
    const saved = process.env.MEDICAL_HISTORY_ENABLED;
    delete process.env.MEDICAL_HISTORY_ENABLED;
    try {
      expect(isMedicalHistoryEnabled()).toBe(false);
      expect(canCaptureMedicalHistory()).toBe(false);
    } finally {
      if (saved !== undefined) process.env.MEDICAL_HISTORY_ENABLED = saved;
    }
  });

  it("is false for the literal string false", () => {
    vi.stubEnv("MEDICAL_HISTORY_ENABLED", "false");
    expect(isMedicalHistoryEnabled()).toBe(false);
    expect(canCaptureMedicalHistory()).toBe(false);
  });

  it("turns on only for the exact string true, never for a truthy near miss", () => {
    for (const value of ["1", "TRUE", "True", "yes", "on", " true", "true ", ""]) {
      vi.stubEnv("MEDICAL_HISTORY_ENABLED", value);
      expect(isMedicalHistoryEnabled(), `"${value}" must not enable medical history`).toBe(false);
      expect(canCaptureMedicalHistory(), `"${value}" must not enable capture`).toBe(false);
    }
    vi.stubEnv("MEDICAL_HISTORY_ENABLED", "true");
    expect(isMedicalHistoryEnabled()).toBe(true);
    expect(canCaptureMedicalHistory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The flag is a SERVER flag. A client component reading it would inline `false`
// into the bundle at build time and then disagree with the server the moment the
// practice switches capture on. These tests make that a fact rather than a comment.
// ---------------------------------------------------------------------------

const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));
const GATE = fileURLToPath(new URL("./gate.ts", import.meta.url));

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

describe("the medical-history flag never reaches a browser", () => {
  it("is read in exactly one module in the whole of src/", () => {
    const readers = sourceFiles(SRC_DIR)
      .filter(({ source }) => source.includes("process.env.MEDICAL_HISTORY_ENABLED"))
      .map(({ path }) => path);
    expect(readers).toEqual([GATE]);
  });

  it("is never exposed under a NEXT_PUBLIC_ name anywhere", () => {
    for (const { path, source } of sourceFiles(SRC_DIR)) {
      expect(source, `${path} exposes the medical-history flag to the client`).not.toContain(
        "NEXT_PUBLIC_MEDICAL_HISTORY",
      );
    }
  });

  it("keeps the server-only import that makes a client import a build error", () => {
    expect(readFileSync(GATE, "utf8")).toContain('import "server-only"');
  });
});

// ---------------------------------------------------------------------------
// The copy. These sentences are the entire user-visible behaviour of a switched
// off feature and the honesty guarantees of an enabled one.
// ---------------------------------------------------------------------------

describe("MEDICAL_COPY", () => {
  it("names the environment variable, so a 503 is actionable rather than mysterious", () => {
    expect(MEDICAL_HISTORY_ENV_FLAG).toBe("MEDICAL_HISTORY_ENABLED");
    expect(MEDICAL_COPY.disabled).toContain(MEDICAL_HISTORY_ENV_FLAG);
  });

  it("sends the reader to Dentally rather than implying the patient has no medical history", () => {
    expect(MEDICAL_COPY.disabled).toContain("Dentally");
    expect(MEDICAL_COPY.disabled).toMatch(/not a statement about this patient/i);
  });

  it("distinguishes 'not captured here' from an absence of medical history", () => {
    expect(MEDICAL_COPY.notCaptured).toMatch(/not a finding that they have none/i);
    expect(MEDICAL_COPY.notCaptured).toContain("Dentally");
  });

  it("distinguishes a failed read from an absence of a record", () => {
    expect(MEDICAL_COPY.readFailed).toMatch(/not a finding that there is none/i);
  });

  it("states that the questionnaire here and Dentally's own record are two different facts", () => {
    expect(MEDICAL_COPY.twoRecords).toContain("Dentally");
    expect(MEDICAL_COPY.twoRecords).toMatch(/check both before treating/i);
  });

  it("explains a refused review rather than inventing an author (GDC 4.1.4)", () => {
    expect(MEDICAL_COPY.noAuthor).toMatch(/clinician/i);
    expect(MEDICAL_COPY.noAuthor).toMatch(/nothing was saved/i);
  });
});
