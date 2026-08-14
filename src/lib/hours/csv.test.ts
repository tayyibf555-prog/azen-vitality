import { describe, it, expect } from "vitest";
import { decimalHours, hoursExportFilename, penceCell, statusLine, toHoursCsv } from "./csv";
import type { MonthReport, StaffMonthRow } from "./types";

function row(over: Partial<StaffMonthRow> = {}): StaffMonthRow {
  return {
    staffId: "s1",
    name: "Amina Rahman",
    role: "nurse",
    siteId: "site-cc",
    sessions: 2,
    closedMinutes: 960,
    openOrUnresolvedCount: 0,
    daysWorked: 2,
    ...over,
  };
}

function report(over: Partial<MonthReport> = {}): MonthReport {
  return {
    month: "2026-06",
    from: "2026-06-01",
    to: "2026-06-30",
    rows: [row()],
    totals: { staff: 1, closedMinutes: 960, openOrUnresolvedCount: 0 },
    unresolved: [],
    finalisable: true,
    blockers: [],
    ready: true,
    truncated: false,
    includesCost: false,
    ...over,
  };
}

/** Split a CSV body into lines, dropping the BOM. */
function lines(csv: string): string[] {
  return csv.replace(/^﻿/, "").trimEnd().split("\r\n");
}

describe("toHoursCsv", () => {
  it("opens with a BOM and CRLF line endings, like the charting export", () => {
    const csv = toHoursCsv(report(), "2026-07-02T10:00:00.000Z");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("stamps the month and the read time in the header block", () => {
    const out = lines(toHoursCsv(report(), "2026-07-02T10:00:00.000Z"));
    expect(out[0]).toBe("Hours for the month,2026-06");
    expect(out[1]).toBe("Read as of,2026-07-02T10:00:00.000Z");
  });

  it("states the payroll boundary in the file itself, not only on the screen", () => {
    expect(toHoursCsv(report())).toContain("Not payroll");
  });

  it("ROUND-TRIPS A NAME CONTAINING A COMMA", () => {
    // "Rahman, Amina" unquoted would shift every following column by one and
    // silently move somebody's hours into the Role column.
    const csv = toHoursCsv(report({ rows: [row({ name: "Rahman, Amina" })] }));
    expect(csv).toContain('"Rahman, Amina",nurse');
    const data = lines(csv).at(-1)!;
    expect(data.startsWith('"Rahman, Amina",')).toBe(true);
  });

  it("doubles an inner quote rather than breaking the field", () => {
    const csv = toHoursCsv(report({ rows: [row({ name: 'Amina "Minnie" Rahman' })] }));
    expect(csv).toContain('"Amina ""Minnie"" Rahman"');
  });

  it("quotes a name containing a newline", () => {
    const csv = toHoursCsv(report({ rows: [row({ name: "Amina\nRahman" })] }));
    expect(csv).toContain('"Amina\nRahman"');
  });

  it("OMITS THE COST COLUMNS ENTIRELY without pay access", () => {
    const out = lines(toHoursCsv(report()));
    const header = out.find((l) => l.startsWith("Name,"))!;
    expect(header).not.toContain("Cost");
    expect(header).not.toContain("Rate");
    expect(header.split(",")).toHaveLength(8);
  });

  it("includes them, as plain decimals, when it may", () => {
    const csv = toHoursCsv(
      report({
        includesCost: true,
        rows: [row({ ratePence: 1250, costPence: 20_000 })],
        totals: { staff: 1, closedMinutes: 960, openOrUnresolvedCount: 0, costPence: 20_000 },
      }),
    );
    const out = lines(csv);
    expect(out.find((l) => l.startsWith("Name,"))!).toContain("Cost (£)");
    // Plain decimals, so a spreadsheet can sum the column.
    expect(out.at(-1)!).toContain(",12.50,200.00");
  });

  it("an unpriced person is an EMPTY cost cell, never a zero", () => {
    const csv = toHoursCsv(
      report({ includesCost: true, rows: [row({ ratePence: null, costPence: null })] }),
    );
    expect(lines(csv).at(-1)!.endsWith(",,")).toBe(true);
  });

  it("an empty month still produces the header block and the column row", () => {
    // An empty file is indistinguishable from a failed export.
    const out = lines(toHoursCsv(report({ rows: [] })));
    expect(out).toHaveLength(5);
    expect(out.at(-1)!.startsWith("Name,")).toBe(true);
  });
});

describe("statusLine", () => {
  it("says complete when nothing is outstanding", () => {
    expect(statusLine(report())).toContain("Complete");
  });

  it("SAYS PROVISIONAL, WITH THE REASON, when the month is not settled", () => {
    const line = statusLine(
      report({ finalisable: false, blockers: ["2 entries need a decision before the month can be marked final."] }),
    );
    expect(line).toContain("Provisional");
    expect(line).toContain("2 entries need a decision");
  });

  it("says so plainly when the month could not be read at all", () => {
    expect(statusLine(report({ ready: false, finalisable: false }))).toContain("Could not be read");
  });
});

describe("number formatting", () => {
  it("decimal hours are exact where they can be", () => {
    expect(decimalHours(960)).toBe("16.00");
    expect(decimalHours(480)).toBe("8.00");
    expect(decimalHours(450)).toBe("7.50");
    expect(decimalHours(465)).toBe("7.75");
  });

  it("decimal hours never print a bare integer or a float artefact", () => {
    expect(decimalHours(0)).toBe("0.00");
    expect(decimalHours(1)).toBe("0.02");
    expect(decimalHours(-5)).toBe("0.00");
  });

  it("pence become plain decimals, and null becomes an empty cell", () => {
    expect(penceCell(1250)).toBe("12.50");
    expect(penceCell(5)).toBe("0.05");
    expect(penceCell(0)).toBe("0.00");
    expect(penceCell(null)).toBe("");
    expect(penceCell(undefined)).toBe("");
  });
});

describe("hoursExportFilename", () => {
  it("carries the client, the month and the read time", () => {
    expect(hoursExportFilename("vitality", "2026-06", "2026-07-02T10:05:00.000Z")).toBe(
      "hours-vitality-2026-06-20260702-1005.csv",
    );
  });

  it("is safe on every filesystem even from hostile input", () => {
    const name = hoursExportFilename("../../etc", "2026/06", "not a date");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.endsWith(".csv")).toBe(true);
  });
});
