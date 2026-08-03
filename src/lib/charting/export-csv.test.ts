import { describe, it, expect } from "vitest";
import { exportFilename, toCsv } from "./export-csv";
import type { HistoryLine } from "./history";

function line(over: Partial<HistoryLine> = {}): HistoryLine {
  return {
    itemId: "i1",
    toothLabel: "UR6",
    fdi: 16,
    fdiLabel: "16",
    rawTeeth: "16",
    surfaces: "MO",
    surfaceIndices: [],
    surfaceIndexText: "",
    unrecognisedSurfaces: [],
    wholeTooth: false,
    baseChart: false,
    nomenclature: "Filling",
    price: 25.8,
    completed: true,
    planId: "p1",
    planLabel: "Plan 1",
    planStatus: "accepted",
    date: "2026-02-01T09:00:00Z",
    ...over,
  };
}

/** A deliberately strict RFC4180 reader, so the escaping is proved rather than
 *  eyeballed against a regex that shares the writer's assumptions. */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = csv.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // consumed with the \n
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("toCsv", () => {
  it("opens with the as-of stamp, so an exported chart carries its own age", () => {
    const rows = parseCsv(toCsv([line()], "2026-08-01T14:22:00Z"));
    expect(rows[0][0].toLowerCase()).toContain("as of");
    expect(rows[0][1]).toBe("2026-08-01T14:22:00Z");
  });

  it("starts with a UTF-8 BOM, because Excel otherwise mangles the accented names", () => {
    expect(toCsv([], "")).toMatch(/^﻿/);
  });

  // An empty file is indistinguishable from a failed export, and a chart with
  // no header could be read as a chart with no findings.
  it("still writes the header rows for an empty history, rather than an empty file", () => {
    const rows = parseCsv(toCsv([], "2026-08-01T14:22:00Z"));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("Tooth");
  });

  it("round-trips a nomenclature containing a comma, a quote and a newline", () => {
    const nasty = 'Filling, "MOD", upper\nright six';
    const rows = parseCsv(toCsv([line({ nomenclature: nasty })], ""));
    const header = rows[1];
    const data = rows[2];
    expect(data[header.indexOf("Treatment")]).toBe(nasty);
  });

  it("writes every column of the line, so an export is not a narrower record than the screen", () => {
    const rows = parseCsv(toCsv([line({ unrecognisedSurfaces: ["X"], wholeTooth: true })], ""));
    const header = rows[1];
    const data = rows[2];
    const cell = (name: string) => data[header.indexOf(name)];
    expect(cell("Tooth")).toBe("UR6");
    expect(cell("FDI")).toBe("16");
    expect(cell("Surfaces")).toBe("MO");
    expect(cell("Unrecognised surfaces")).toBe("X");
    expect(cell("Whole tooth")).toBe("yes");
    expect(cell("Completed")).toBe("yes");
    expect(cell("Plan")).toBe("Plan 1");
    expect(cell("Plan status")).toBe("accepted");
    expect(cell("Price")).toBe("25.80");
  });

  // EVERY line historyLines builds carries fdi: null, because a line is about an
  // ITEM and an item may name several teeth. Reading `fdi` therefore blanked the
  // FDI column on every single exported row, which is the one column that exists
  // so an export can be reconciled against Dentally.
  it("writes the FDI numbers History actually holds, not the single-tooth field", () => {
    const rows = parseCsv(
      toCsv([line({ fdi: null, fdiLabel: "16, 26", toothLabel: "UR6, UL6" })], ""),
    );
    const header = rows[1];
    expect(rows[2][header.indexOf("FDI")]).toBe("16, 26");
  });

  it("writes the raw teeth value for an unplaced line, so the export shows what Dentally actually said", () => {
    const rows = parseCsv(toCsv([line({ toothLabel: "", fdi: null, rawTeeth: "whole mouth" })], ""));
    const header = rows[1];
    expect(rows[2][header.indexOf("Teeth as sent")]).toBe("whole mouth");
  });
});

describe("exportFilename", () => {
  it("names the patient and the read time, and is safe on every filesystem", () => {
    const name = exportFilename("pat-001", "2026-08-01T14:22:00Z");
    expect(name).toBe("chart-pat-001-20260801-1422.csv");
    expect(name).not.toMatch(/[^a-zA-Z0-9._-]/);
  });

  it("still produces a usable name when the stamp is missing or unreadable", () => {
    expect(exportFilename("pat-001", "")).toBe("chart-pat-001.csv");
    expect(exportFilename("pat/001", "nonsense")).toBe("chart-pat-001.csv");
  });
});

/**
 * The export is what goes into a complaint file, so a column that is blank on
 * every row of a real patient is worse than no column. `surfaces` holds a LETTER
 * code and live Dentally sends only numbers, so before this the "where on the
 * tooth" half of an exported chart was empty for every real restoration.
 */
describe("toCsv and Dentally's surface numbers", () => {
  it("exports the surface numbers in a column of their own, verbatim", () => {
    const rows = parseCsv(
      toCsv([line({ surfaces: "", surfaceIndices: [3, 8], surfaceIndexText: "surfaces 3, 8" })]),
    );
    const header = rows[1];
    const body = rows[2];
    const at = header.indexOf("Surface numbers");
    expect(at).toBeGreaterThan(-1);
    expect(body[at]).toBe("3 8");
    // NOT translated into a surface name: which anatomical surface an index is
    // depends on how Dentally orients the quadrant, and nothing public says.
    expect(body[at]).not.toMatch(/mesial|distal|buccal|lingual|occlusal/i);
    // And the letter column is untouched, so the two vocabularies stay apart.
    expect(body[header.indexOf("Surfaces")]).toBe("");
  });
});
