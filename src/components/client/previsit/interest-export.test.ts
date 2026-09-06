// ===========================================================================
// THE INTEREST LISTS ARE TARGETABLE, THROUGH ONE DOOR (rulings W3/10, W3/29).
//
// THE FIRST DEFECT this pins: the tick-grid was built so the practice could run
// the whitening campaign, and for two waves the list could only be LOOKED at. No
// export, no copy, no campaign filter — `OutreachFilters` selects on Dentally's
// own patient base and has no interest predicate, and the co-pilot's
// `interest_lists` tool is a read whose own prompt says you cannot send to these
// people from there. Three hundred people who asked to hear about implants, and
// the way out of the platform was to retype names off a 25-row table.
//
// THE SECOND, which W3/29 settles: the controls that answered it built their own
// CSV in the browser, out of the rows this page had rendered, WHILE a guarded
// server route built a different one out of its own read. Two shapes of the same
// list, and two ways to be wrong about it:
//
//   THE FILE WAS A SAMPLE OF A SAMPLE. The page reads 400 interest rows. A
//   treatment whose yeses are older than those 400 exported NOBODY — and its
//   button was DISABLED, because the disabled rule counted rows on the page. The
//   practice with the most people to ring was the one offered least.
//
//   AND IT LEFT WITHOUT A GUARD. A file of named patients was assembled in the
//   browser from a page read, so no route logged it, no switch stopped it and no
//   second role check stood between it and the clipboard.
//
// So both controls now fetch GET /api/previsit/interest/export, which walks the
// table to its end, de-duplicates to one person per treatment, refuses when the
// module is switched off, and answers with its own honest count. What is pinned
// here is the WIRING — the url, the three answer shapes, what the reader is told
// — because the formatting is pinned once, in src/lib/triage/interest-csv.test.ts.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { INTEREST_TREATMENTS } from "@/lib/triage/bank";
import {
  InterestPanel,
  interestDownloadFilename,
  interestExportNotice,
  interestExportRefusal,
  interestExportUrl,
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

function panel(rows: InterestRow[] | null, counts: Record<string, number> | null): string {
  return renderToStaticMarkup(
    createElement(InterestPanel, { clientSlug: "vitality", treatments: [...INTEREST_TREATMENTS], rows, counts }),
  );
}

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/client/previsit/previsit-workspace.tsx"),
  "utf8",
);

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
});

describe("both controls call the SERVER, not this page's rows (W3/29)", () => {
  it("asks the guarded route for one treatment, and for everybody", () => {
    expect(interestExportUrl("vitality", "whitening", "csv")).toBe(
      "/api/previsit/interest/export?client=vitality&treatment=whitening",
    );
    expect(interestExportUrl("vitality", null, "csv")).toBe(
      "/api/previsit/interest/export?client=vitality",
    );
  });

  it("asks for the audience shape when the control is Copy", () => {
    expect(interestExportUrl("vitality", "implants", "audience")).toBe(
      "/api/previsit/interest/export?client=vitality&treatment=implants&format=audience",
    );
  });

  it("encodes a practice slug rather than pasting it into the query", () => {
    expect(interestExportUrl("a b&c", null, "csv")).toContain("client=a+b%26c");
  });

  it("is what the panel actually calls, and it holds no CSV builder of its own", () => {
    // The click cannot be driven in this renderer, so the panel is asserted to
    // delegate to the url rule rather than hold a second copy of it — and the
    // retired browser-side formatter is asserted to be GONE, because two
    // formatters over one list is the defect W3/29 named.
    expect(SOURCE).toContain("interestExportUrl(clientSlug, treatment, mode === \"copy\" ? \"audience\" : \"csv\")");
    expect(SOURCE, "the browser is building a CSV again").not.toContain("function interestCsv");
    expect(SOURCE, "a second cell-quoting rule came back").not.toContain("function csvCell");
  });

  it("keeps a failed CLIPBOARD apart from a failed export", () => {
    // Two different facts. The list was read fine and only the paste failed, so
    // "nothing has left the platform" would send somebody after the wrong
    // problem — and saying nothing at all would leave them pasting whatever they
    // copied last into a campaign.
    expect(SOURCE).toContain("That list could not be copied. Download it instead.");
    expect(SOURCE).toContain("await navigator.clipboard.writeText(text);");
  });

  it("saves through a Blob, never a plain link, so a refusal cannot be saved as a .csv", () => {
    // The route answers an off module with HTTP 200 and a JSON body. An <a href>
    // download would write `{"ok":false,…}` into a file called interest-*.csv.
    expect(SOURCE).toContain("const blob = await res.blob()");
    expect(SOURCE).toContain('type.includes("application/json")');
  });
});

describe("what the reader is told when no file arrived", () => {
  it("prints the route's OWN sentence for a switched-off module", () => {
    const message = "Pre-visit questions is switched off, so these lists cannot be exported.";
    expect(interestExportRefusal({ status: 200 }, { ok: false, skipped: "system off", message })).toBe(message);
  });

  it("prints the route's error when it wrote one", () => {
    expect(interestExportRefusal({ status: 500 }, { ok: false, error: "This list could not be read just now." })).toBe(
      "This list could not be read just now.",
    );
  });

  it("names the status only when the route wrote nothing — a 403, a 404, a proxy", () => {
    expect(interestExportRefusal({ status: 403 }, {})).toBe(
      "That list could not be exported just now (403).",
    );
  });
});

describe("the count beside the button is the ROUTE'S count, in the route's words", () => {
  it("prints what the file's own first row prints", () => {
    expect(interestExportNotice("Whitening", "142", "downloaded")).toBe("Whitening: 142 people downloaded.");
  });

  it("carries an AT LEAST through untouched, rather than rounding it into a figure", () => {
    expect(interestExportNotice("Whitening", "at least 20,000", "copied")).toBe(
      "Whitening: at least 20,000 people copied. Paste into your campaign or a spreadsheet.",
    );
  });

  it("says person, not people, for one", () => {
    expect(interestExportNotice("Implants", "1", "downloaded")).toBe("Implants: 1 person downloaded.");
  });

  it("drops the figure rather than inventing one when the header is missing", () => {
    // A proxy stripped the header. The file is still fine; the sentence simply
    // does not claim a number it does not have.
    expect(interestExportNotice("Implants", null, "downloaded")).toBe("Implants: downloaded.");
  });
});

describe("the browser saves the file under the name the route chose", () => {
  it("takes the filename out of the route's own content-disposition", () => {
    expect(
      interestDownloadFilename('attachment; filename="interest-whitening-20260902-1422.csv"', "whitening"),
    ).toBe("interest-whitening-20260902-1422.csv");
  });

  it("falls back to the shared builder when the header did not survive", () => {
    expect(interestDownloadFilename(null, "whitening")).toMatch(
      /^interest-whitening-\d{8}-\d{4}\.csv$/,
    );
  });
});

/** The opening tag of one treatment's Download control, and nothing else. */
function control(html: string, label: string): string {
  const at = html.indexOf(`Download the ${label} list as a CSV`);
  expect(at, `no control for ${label}`).toBeGreaterThan(0);
  return html.slice(at - 120, at);
}

describe("a control is disabled only when there is provably nobody to export", () => {
  it("is OFFERED for a treatment whose people are all older than this page", () => {
    // THE DEFECT this pins: the old rule counted rows on the 400-row page, so the
    // practice whose whitening yeses are a year old — the one that most needs the
    // file — was shown a disabled button over a headline figure of 118.
    const html = panel([row({ treatment: "implants", patientId: "dp-9" })], { whitening: 118, implants: 1 });
    expect(html).toContain("Download the Whitening list as a CSV");
    // Rendered enabled: React omits the attribute entirely when it is false. The
    // window is the button's own opening tag (~95 characters), so it cannot reach
    // back into the previous treatment's controls and read their state instead.
    expect(control(html, "Whitening"), "the control for a real list was disabled").not.toContain("disabled=");
  });

  it("is disabled for a treatment nobody has asked about", () => {
    const html = panel([row()], { whitening: 1, implants: 0 });
    expect(control(html, "Implants")).toContain("disabled=");
  });
});
