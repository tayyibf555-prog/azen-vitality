// ===========================================================================
// A CAPPED INTEREST COUNT IS A FLOOR, AND THE SCREEN SAYS "AT LEAST N".
//
// THE DEFECT this pins: the module page called `countInterestByTreatment`, the
// bare wrapper whose return type — `Record<string, number>` — has nowhere to put
// the word "at least". The counts scan is bounded (20,000 interest rows), and on
// a capped scan that wrapper THROWS rather than hand a caller a floor it would
// print as a total. The page's own `.catch(() => null)` then turned the whole
// grid into "The totals could not be read.": a practice past the ceiling would
// lose every headline figure it has, to be protected from a number it could
// simply have been told was a floor.
//
// Charter §0/5 and ruling W3/11 ask for the third option, which the detailed
// variant has carried all along: read `capped` and render "at least 20,000",
// the same sentence Home's Operating system band already prints for a capped
// read. Honest numbers, not no numbers.
//
// THREE SURFACES CARRY THE FIGURE and all three are qualified: the headline
// number, the "N of T — the rest are past this page" line beside the export
// buttons, and the CSV's own completeness row. The last one matters most: a
// spreadsheet of patient names outlives the screen it came off, and "all 20,000
// people on this list" printed into it is a claim nothing can take back.
//
// THE PAGE IS DRIVEN FOR REAL. The repository is mocked rather than seeded,
// because reaching the ceiling honestly needs twenty thousand rows; what the
// mock proves is the seam — the page asks for the DETAILED counts and carries
// `capped` down to the panel. A page that went back to the bare wrapper would
// not find it on the mock at all.
// ===========================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { INTEREST_TREATMENTS } from "@/lib/triage/bank";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/c/vitality",
  useSearchParams: () => new URLSearchParams(),
}));

/** What the counts scan says on this render. Mutated per test. */
const counts: { value: { counts: Record<string, number>; capped: boolean; scanned: number } } = {
  value: { counts: { whitening: 20_000 }, capped: true, scanned: 20_000 },
};

vi.mock("@/lib/triage/repository", () => ({
  // NOTE: the bare `countInterestByTreatment` is deliberately NOT on this mock.
  // A page that goes back to it fails to import rather than quietly losing the
  // word "capped".
  countInterestByTreatmentDetailed: async () => counts.value,
  listInterest: async () => [
    {
      id: "ti-1",
      dentallyPatientId: "dp-1",
      patientName: "Alex Berry",
      treatment: "whitening",
      createdAt: "2026-08-02T10:00:00.000Z",
    },
  ],
}));
vi.mock("@/lib/triage/mining-repository", () => ({
  listCandidates: async () => [],
  listCoverage: async () => [],
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true }));
vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({
    siteIds: ["site-cc"],
    selection: "site-cc",
    isAllSites: false,
    siteName: "N15 Vitality Dental",
    label: "N15 Vitality Dental",
  }),
}));
// A PRACTICE MANAGER, because Tabs mounts only the ACTIVE panel and hers is the
// interest list. An owner's first tab is the question-bank editor.
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => ({
    id: "usr_manager",
    name: "Blerta",
    email: "manager@example.com",
    role: "client_coordinator",
    clientId: "vitality",
    siteIds: ["site-cc"],
  }),
}));

import { PreVisitTriageView } from "./previsit-view";
import { InterestPanel, csvCompleteness, interestCsv } from "./previsit-workspace";

async function page(): Promise<string> {
  return renderToStaticMarkup(await PreVisitTriageView({ clientSlug: "vitality" }));
}

function panel(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(InterestPanel, {
      treatments: [...INTEREST_TREATMENTS],
      rows: [
        {
          id: "ti-1",
          patientId: "dp-1",
          patientName: "Alex Berry",
          treatment: "whitening",
          createdAt: "2026-08-02T10:00:00.000Z",
        },
      ],
      counts: { whitening: 20_000 },
      scopeLabel: "N15 Vitality Dental",
      ...over,
    }),
  );
}

describe("the pre-visit page prints a capped count as a floor, not as a total", () => {
  it("says 'at least N' on the headline figure when the scan hit its ceiling", async () => {
    counts.value = { counts: { whitening: 20_000 }, capped: true, scanned: 20_000 };
    const html = await page();
    expect(html).toContain("at least 20,000");
    // And it still prints the figure. The old behaviour lost it entirely.
    expect(html).not.toContain("The totals could not be read");
  });

  it("prints a plain figure when the scan reached the end of the table", async () => {
    // THE OTHER DIRECTION, and the mutation that matters: a page that always
    // hedged would be as useless as one that never did.
    counts.value = { counts: { whitening: 118 }, capped: false, scanned: 118 };
    const html = await page();
    expect(html).toContain("118");
    expect(html).not.toContain("at least");
  });

  it("keeps a FAILED counts read apart from a capped one", async () => {
    // `null` means we could not look, which is not "there are at least zero".
    counts.value = null as never;
    const html = await page();
    expect(html).toContain("The totals could not be read");
    expect(html).not.toContain("at least");
  });
});

describe("every figure beside a capped count wears the same sign", () => {
  it("qualifies the 'N of T' line under the export buttons", () => {
    const html = panel({ countsCapped: true });
    expect(html).toContain("1 of at least 20,000");
    expect(html).toContain("the rest are past this page");
  });

  it("says the page is short even when it holds as many rows as the floor", () => {
    // A capped grid whose floor happens to equal the rows on the page is still a
    // floor: there ARE more, and "1 of 1" would read as the whole list.
    const html = panel({ counts: { whitening: 1 }, countsCapped: true });
    expect(html).toContain("1 of at least 1");
  });

  it("stays silent about a short page when the counts are true totals", () => {
    expect(panel({ counts: { whitening: 1 } })).not.toContain("the rest are past this page");
  });
});

describe("the exported file never claims completeness off a floor", () => {
  it("withholds a capped figure and says the file is a sample instead", () => {
    const claim = csvCompleteness(20_000, true, false);
    expect(claim.total, "a floor was handed to the file as a total").toBeUndefined();
    expect(claim.pageCut).toBe(true);
    const csv = interestCsv({
      rows: [],
      labelFor: (k) => k,
      heading: "Whitening",
      takenAt: "2 Sep 2026",
      ...claim,
    });
    expect(csv).toContain("this file is a sample and not the whole list");
    expect(csv).not.toContain("all 0 people");
  });

  it("passes a true total through untouched", () => {
    expect(csvCompleteness(118, false, false)).toEqual({ total: 118, pageCut: false });
    expect(csvCompleteness(118, false, true)).toEqual({ total: 118, pageCut: true });
  });

  it("is what the download actually uses, not a rule beside it", () => {
    // The click cannot be driven in this renderer, so the panel is asserted to
    // delegate to the rule rather than to hold a second copy of it.
    const src = readFileSync(
      join(process.cwd(), "src/components/client/previsit/previsit-workspace.tsx"),
      "utf8",
    );
    expect(src).toContain("csvCompleteness(total, countsCapped, more)");
    expect(src).toContain("total: claim.total");
    expect(src).toContain("pageCut: claim.pageCut");
  });
});
