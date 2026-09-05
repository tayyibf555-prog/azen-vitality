// ===========================================================================
// THE INTEREST LISTS ARE TARGETABLE (ruling W3/10).
//
// THE DEFECT this pins: the tick-grid was built so the practice could run the
// whitening campaign, and for two waves the list could only be LOOKED at. No
// export, no copy, no campaign filter — `OutreachFilters` selects on Dentally's
// own patient base and has no interest predicate, and the co-pilot's
// `interest_lists` tool is a read whose own prompt says you cannot send to these
// people from there. Three hundred people who asked to hear about implants, and
// the way out of the platform was to retype names off a 25-row table.
//
// W3/10 sets the floor: "owner+manager CSV export / 'copy as audience' per
// treatment on the interest-lists screen". The Meta half of that ruling does not
// bind — there is no audience builder in src/lib/meta-ads to extend; `audience`
// there is free prose — so this minimum is the whole obligation.
//
// FOUR RULES, and each one is a way the export could be worse than useless:
//   1. It is ON THE SCREEN, per treatment. A helper nothing calls is the state
//      the ruling was written to end.
//   2. ONE ROW PER PERSON. An audience with a name in it twice is an audience
//      somebody rings twice, and the count above the button already counts
//      distinct patients.
//   3. IT SAYS WHAT IT IS NOT. The page reads a bounded number of answers, so a
//      long list exports a SAMPLE — and a CSV silently cut is the defect W3/11
//      has just been spent fixing on screen (charter §0/5).
//   4. NOTHING IN A CELL IS EXECUTED. Every value is text somebody else typed.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { INTEREST_TREATMENTS } from "@/lib/triage/bank";
import {
  InterestPanel,
  audienceRows,
  interestClipboardText,
  interestCsv,
  interestExportFilename,
  type InterestRow,
} from "./previsit-workspace";

function row(over: Partial<InterestRow> = {}): InterestRow {
  return {
    id: "ti-1",
    patientId: "dp-1",
    patientName: "Alex Berry",
    treatment: "whitening",
    createdAt: "2026-08-02T10:00:00.000Z",
    ...over,
  };
}

const LABEL = (key: string) => INTEREST_TREATMENTS.find((t) => t.key === key)?.label ?? key;

function panel(rows: InterestRow[] | null, counts: Record<string, number> | null): string {
  return renderToStaticMarkup(
    createElement(InterestPanel, {
      treatments: [...INTEREST_TREATMENTS],
      rows,
      counts,
      scopeLabel: "N15 Vitality Dental",
    }),
  );
}

describe("a treatment's list can leave the platform without being retyped", () => {
  it("offers a CSV and a copy on every treatment, by name", () => {
    const html = panel([row()], { whitening: 1 });
    for (const t of INTEREST_TREATMENTS) {
      expect(html, `no CSV control for ${t.key}`).toContain(`Download the ${t.label} list as a CSV`);
      expect(html, `no copy control for ${t.key}`).toContain(`Copy the ${t.label} list as an audience`);
    }
  });

  it("offers one export for the whole list as well as one per treatment", () => {
    expect(panel([row()], { whitening: 1 })).toContain("Export everyone");
  });

  it("offers nothing to export when the read FAILED", () => {
    // A failed read is not an empty list, and an export button over it would
    // hand somebody a file that claims nobody is interested.
    const html = panel(null, null);
    expect(html).toContain("That is a failure to read them");
    expect(html).not.toContain("Export everyone");
    expect(html).not.toContain("as a CSV");
  });

  it("says on the button when a treatment's file would be a sample", () => {
    // 1 row on the page, 118 people on the list: the file is a sample and the
    // person exporting it is told BEFORE they open it, not only inside it.
    const html = panel([row()], { whitening: 118 });
    expect(html).toContain("1 of 118");
    expect(html).toContain("the rest are past this page");
  });

  it("totals the whole-list export from the per-treatment counts", () => {
    // A row of the all-treatments file is one person PER TREATMENT, which is
    // exactly what those counts add up to — so the sample sentence is right for
    // the "Export everyone" file as well as for a single treatment's.
    const html = panel([row()], { whitening: 2, implants: 3 });
    expect(html).toContain("Export everyone");
    expect(html).toContain("1 of 2");
  });

  it("says nothing of the sort when the page holds the whole list", () => {
    const html = panel([row()], { whitening: 1 });
    expect(html).not.toContain("the rest are past this page");
  });
});

describe("an audience is people, not answers", () => {
  it("keeps one row per patient per treatment, the most recent first", () => {
    const rows = [
      row({ id: "a", patientId: "dp-1", createdAt: "2026-08-09T10:00:00.000Z" }),
      row({ id: "b", patientId: "dp-1", createdAt: "2026-06-01T10:00:00.000Z" }),
      row({ id: "c", patientId: "dp-2" }),
    ];
    const out = audienceRows(rows, "whitening");
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("keeps the same person once per treatment, not once overall", () => {
    // Somebody interested in two things belongs on two lists.
    const rows = [row({ id: "a" }), row({ id: "b", treatment: "implants" })];
    expect(audienceRows(rows, null).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("filters to the treatment asked for", () => {
    const rows = [row({ id: "a" }), row({ id: "b", treatment: "implants", patientId: "dp-9" })];
    expect(audienceRows(rows, "implants").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("the file says what it is before it says who is in it", () => {
  const csv = (rows: InterestRow[], total?: number) =>
    interestCsv({
      rows,
      labelFor: LABEL,
      heading: "Whitening",
      takenAt: "2 September 2026",
      scopeLabel: "N15 Vitality Dental",
      total,
    });

  it("names the list, when it was taken and which sites it covers", () => {
    const out = csv([row()]);
    expect(out).toContain("Interest list,Whitening");
    expect(out).toContain("Taken from the platform on,2 September 2026,Sites: N15 Vitality Dental");
  });

  it("states that it holds the whole list when it does", () => {
    expect(csv([row()], 1)).toContain("all 1 person on this list");
  });

  it("states that it is a SAMPLE when the page could not reach the whole list", () => {
    const out = csv([row()], 118);
    expect(out).toContain("1 person of the 118 on this list");
    expect(out).toContain("this file is a sample and not the whole list");
  });

  it("carries the patient's Dentally number, which is what makes it targetable", () => {
    const out = csv([row()]);
    expect(out).toContain("Dentally patient ID");
    expect(out).toContain("Alex Berry,dp-1,Whitening,");
  });

  it("opens with a BOM and CRLF line endings, so Excel reads it", () => {
    const out = csv([row()]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toContain("\r\n");
  });

  it("quotes a comma and doubles a quote rather than shifting the columns", () => {
    const out = csv([row({ patientName: 'Berry, Alex "AB"' })]);
    expect(out).toContain('"Berry, Alex ""AB""",dp-1');
  });

  it("never hands a spreadsheet a formula to run", () => {
    // A patient name comes off the Dentally record. A cell starting with = is a
    // formula to Excel, Numbers and Sheets alike.
    const out = csv([row({ patientName: "=1+1" })]);
    expect(out).not.toContain("\r\n=1+1,");
    expect(out).toContain("'=1+1,dp-1");
  });

  it("says a whole-list export is a sample when the page itself was cut", () => {
    // The totals could not be read, so there is no figure to compare against —
    // but the page KNOWS its own read was cut, and "all 400 people" would be the
    // false-completeness failure the rest of this file exists to prevent.
    const out = interestCsv({
      rows: [row()],
      labelFor: LABEL,
      heading: "Everyone who asked to hear more",
      takenAt: "2 September 2026",
      pageCut: true,
    });
    expect(out).toContain("this page could read");
    expect(out).toContain("this file is a sample and not the whole list");
    expect(out).not.toContain("all 1 person on this list");
  });

  it("still produces its header rows for an empty list", () => {
    // An empty FILE is indistinguishable from a failed export.
    const out = csv([]);
    expect(out).toContain("Interest list,Whitening");
    expect(out).toContain("Patient,Dentally patient ID");
  });
});

describe("the clipboard form is the one somebody pastes into another tool", () => {
  it("is the Dentally id and the name, tab separated, no header", () => {
    expect(interestClipboardText([row(), row({ patientId: "dp-2", patientName: "Sam Okafor" })])).toBe(
      "dp-1\tAlex Berry\ndp-2\tSam Okafor",
    );
  });

  it("is empty for an empty audience rather than a stray header", () => {
    expect(interestClipboardText([])).toBe("");
  });
});

describe("two exports of the same list are told apart", () => {
  it("names the treatment and stamps the minute", () => {
    const name = interestExportFilename("whitening", new Date("2026-09-02T14:22:00.000Z"));
    expect(name).toBe("interest-whitening-20260902-1422.csv");
  });

  it("calls the whole list 'all'", () => {
    expect(interestExportFilename(null, new Date("2026-09-02T14:22:00.000Z"))).toBe(
      "interest-all-20260902-1422.csv",
    );
  });
});

