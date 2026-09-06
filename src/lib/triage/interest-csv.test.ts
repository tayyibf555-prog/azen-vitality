import { describe, expect, it } from "vitest";

import {
  INTEREST_EXPORT_COLUMNS,
  interestAudience,
  interestAudienceCell,
  interestAudienceText,
  interestCsvCell,
  interestCsvDocument,
  interestExportFilename,
  interestPeopleLabel,
  type InterestExportRow,
} from "./interest-csv";

// ===========================================================================
// THE ONE FORMATTER FOR THE ONE EXPORT (ruling W3/29).
//
// THE DEFECT this pins: the same interest list left the platform in TWO shapes.
// The pre-visit screen built a CSV in the browser out of the 400 rows it had
// rendered — four columns, three provenance rows, its own completeness sentence —
// while GET /api/previsit/interest/export built a different one out of its own
// read — five columns, one stamp row, a different sentence. Two files, both
// called "the whitening list", and no way for a practice holding one to know
// which it had. W3/29 keeps the route and retires the browser copy, so these
// rules now live in one module and are asserted once.
//
// FOUR OF THEM ARE NOT COSMETIC:
//   1. NOTHING IN A CELL IS EXECUTED. Every value is text somebody else typed.
//   2. A COUNT IS A TOTAL OR IT SAYS IT IS NOT (charter §0/5, ruling W3/11).
//   3. ONE ROW PER PERSON. An audience with a name in it twice is an audience
//      somebody rings twice.
//   4. AN EMPTY LIST IS STILL A FILE. An empty file is indistinguishable from a
//      failed export.
// ===========================================================================

function row(over: Partial<InterestExportRow> = {}): InterestExportRow {
  return {
    patientName: "Alex Berry",
    dentallyPatientId: "dp-1",
    siteName: "N15 Vitality Dental",
    treatmentLabel: "Whitening",
    createdAt: "2026-08-02T10:00:00.000Z",
    ...over,
  };
}

const AT = new Date("2026-09-02T14:22:00.000Z");

function doc(rows: InterestExportRow[], capped = false): string {
  return interestCsvDocument({
    listLabel: "Whitening",
    scopeLabel: "N15 Vitality Dental",
    exportedAt: AT,
    rows,
    capped,
  });
}

/** The document's lines, with the BOM stripped. */
function lines(csv: string): string[] {
  return csv.replace(/^﻿/, "").trimEnd().split("\r\n");
}

describe("nothing a patient or a practice typed is handed to a spreadsheet to RUN", () => {
  it.each([
    ["=HYPERLINK(\"http://x\",\"click\")", "'=HYPERLINK"],
    ["@SUM(1)", "'@SUM(1)"],
    ["-2+3", "'-2+3"],
    ["+44 7700 900000", "'+44 7700 900000"],
  ])("guards a cell starting %s", (value, expected) => {
    expect(interestCsvCell(value)).toContain(expected);
  });

  it("leaves an ordinary name alone", () => {
    expect(interestCsvCell("Alex Berry")).toBe("Alex Berry");
  });

  it("quotes a comma and doubles a quote rather than shifting the columns", () => {
    expect(interestCsvCell('Berry, Alex "AB"')).toBe('"Berry, Alex ""AB"""');
  });

  it("quotes a value carrying a line break, which would otherwise become a row", () => {
    expect(interestCsvCell("Alex\r\nBerry")).toBe('"Alex\r\nBerry"');
  });
});

describe("a count is a total or it says it is not (charter 0/5, W3/11)", () => {
  it("prints a plain figure for a complete read", () => {
    expect(interestPeopleLabel(142, false)).toBe("142");
  });

  it("prints AT LEAST for a capped one, because that is the number a campaign is sized on", () => {
    expect(interestPeopleLabel(20_000, true)).toBe("at least 20,000");
  });
});

describe("the file says what it is before it says who is in it", () => {
  it("names the list, the sites, the moment and the count", () => {
    const out = lines(doc([row()]));
    expect(out[0]).toContain("Interest list,Whitening");
    expect(out[0]).toContain("Sites,N15 Vitality Dental");
    expect(out[0]).toContain("Exported,2026-09-02T14:22:00.000Z");
    expect(out[0]).toContain("People,1");
    expect(out[0]).toContain("This is the whole list.");
  });

  it("says the file is a sample when the read stopped at its ceiling", () => {
    const out = lines(doc([row()], true));
    expect(out[0]).toContain("People,at least 1");
    expect(out[0]).toContain("there are more behind them");
    expect(out[0], "a capped file claimed completeness").not.toContain("This is the whole list.");
  });

  it("carries the patient's Dentally number, which is what makes it targetable", () => {
    const out = lines(doc([row()]));
    expect(out[1]).toBe(INTEREST_EXPORT_COLUMNS.join(","));
    expect(out[2]).toBe("Alex Berry,dp-1,N15 Vitality Dental,Whitening,2026-08-02T10:00:00.000Z");
  });

  it("opens with a BOM and CRLF endings, so Excel reads an accented name", () => {
    const csv = doc([row({ patientName: "Zoë Ó Súilleabháin" })]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
  });

  it("still produces both header rows for an empty list", () => {
    // An empty FILE is indistinguishable from a failed export.
    const out = lines(doc([]));
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("People,0");
  });
});

describe("an audience is people, not answers", () => {
  it("keeps one row per patient per treatment, the most recent first", () => {
    // The rows arrive newest first, so the first sighting of a patient is their
    // most recent answer and the rest are the same person asking again.
    const out = interestAudience([
      row({ createdAt: "2026-08-09T10:00:00.000Z" }),
      row({ createdAt: "2026-06-01T10:00:00.000Z" }),
      row({ dentallyPatientId: "dp-2" }),
    ]);
    expect(out.map((r) => [r.dentallyPatientId, r.createdAt])).toEqual([
      ["dp-1", "2026-08-09T10:00:00.000Z"],
      ["dp-2", "2026-08-02T10:00:00.000Z"],
    ]);
  });

  it("keeps the same person once PER TREATMENT, not once overall", () => {
    // Somebody interested in two things belongs on two lists.
    const out = interestAudience([row(), row({ treatmentLabel: "Implants" })]);
    expect(out).toHaveLength(2);
  });
});

describe("the clipboard form is the one somebody pastes into another tool", () => {
  it("is the Dentally id and the name, tab separated, no header", () => {
    expect(
      interestAudienceText([row(), row({ dentallyPatientId: "dp-2", patientName: "Sam Okafor" })]),
    ).toBe("dp-1\tAlex Berry\ndp-2\tSam Okafor");
  });

  it("is empty for an empty audience rather than a stray header", () => {
    // A provenance row at the top of a paste becomes a row in somebody's campaign.
    expect(interestAudienceText([])).toBe("");
  });

  // -------------------------------------------------------------------------
  // THE HOSTILE-VALUE FIXTURES, WHICH USED TO EXIST ONLY FOR THE CSV HALF.
  //
  // Both halves of this module serve the SAME rows over the SAME route, and the
  // patient name is unedited Dentally free text either way (charter §0/8). The
  // CSV cell guarded it; the clipboard cell did not exist. A tab-separated,
  // unquoted, one-line-per-person paste has no RFC4180 escape to fall back on,
  // so a separator inside a value silently changes the SHAPE of the audience the
  // practice uploads — and the count printed beside the button no longer agrees
  // with the rows in the paste.
  // -------------------------------------------------------------------------
  it("a name with a NEWLINE in it stays one row, so the paste agrees with the count on screen", () => {
    const people = [row({ patientName: "Alex\nBerry" }), row({ dentallyPatientId: "dp-2", patientName: "Sam Okafor" })];
    const text = interestAudienceText(people);
    expect(text.split("\n")).toHaveLength(people.length);
    expect(text).toBe("dp-1\tAlex Berry\ndp-2\tSam Okafor");
    // Every line is still exactly two columns, the first of them a Dentally id.
    for (const line of text.split("\n")) expect(line.split("\t")).toHaveLength(2);
  });

  it("a name with a TAB in it stays two columns", () => {
    const text = interestAudienceText([row({ patientName: "Alex\tBerry" })]);
    expect(text.split("\t")).toHaveLength(2);
    expect(text).toBe("dp-1\tAlex Berry");
  });

  it("carriage returns and stray control characters cannot introduce structure", () => {
    for (const hostile of ["Alex\r\nBerry", "Alex\u2028Berry", "Alex\u0000Berry", "Alex\u0085Berry"]) {
      const text = interestAudienceText([row({ patientName: hostile })]);
      expect(text.split("\n"), `"${JSON.stringify(hostile)}" split the paste`).toHaveLength(1);
      expect(text.split("\t")).toHaveLength(2);
    }
  });

  it("guards a leading formula character exactly as the CSV cell does", () => {
    // The function's own header names a spreadsheet as a paste target, so the
    // two halves of this module must not disagree about what a formula is.
    for (const hostile of ["=cmd|' /c calc'!A1", "+1+1", "-1+1", "@SUM(A1)"]) {
      expect(interestAudienceCell(hostile), `"${hostile}" reached the clipboard raw`).toBe(`'${hostile}`);
      expect(interestCsvCell(hostile).startsWith("'") || interestCsvCell(hostile).startsWith('"')).toBe(true);
    }
    expect(interestAudienceText([row({ patientName: "=1+1" })])).toBe("dp-1\t'=1+1");
  });

  it("leaves an ordinary name completely alone", () => {
    // A guard that touched ordinary values would be a guard that corrupted the
    // audience it was protecting.
    for (const ordinary of ["Alex Berry", "Sian O'Neill", "Jean-Luc", "Nguyen Van A"]) {
      expect(interestAudienceCell(ordinary)).toBe(ordinary);
    }
  });

  it("guards the id column too, not just the name", () => {
    // A formatter that trusted one of its two inputs is a formatter somebody has
    // to re-check the day the id stops being a number.
    expect(interestAudienceText([row({ dentallyPatientId: "=1+1\tx" })])).toBe("'=1+1 x\tAlex Berry");
  });
});

describe("two exports of the same list are told apart", () => {
  it("names the treatment and stamps the minute", () => {
    expect(interestExportFilename("whitening", AT)).toBe("interest-whitening-20260902-1422.csv");
  });

  it("calls the whole list 'all'", () => {
    expect(interestExportFilename(null, AT)).toBe("interest-all-20260902-1422.csv");
  });

  it("cannot be talked into a path", () => {
    // The treatment reaches this from a query string. Every character outside
    // [A-Za-z0-9._-] is replaced, so the name a browser saves can never carry a
    // separator, whatever the caller asked for.
    const name = interestExportFilename("../../etc/passwd", AT);
    expect(name).not.toContain("/");
    expect(name).toBe("interest-..-..-etc-passwd-20260902-1422.csv");
  });
});
