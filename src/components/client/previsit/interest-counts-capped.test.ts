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
// THE FIGURE IS QUALIFIED WHEREVER IT IS PRINTED. On this screen that is the
// headline number. The file's own completeness row is now the ROUTE's to write
// (ruling W3/29): the export walks the table itself, so the page's 400-row read
// no longer decides what a spreadsheet may claim, and the two sentences cannot
// drift apart because there is only one of them
// (src/lib/triage/interest-csv.ts, pinned in its own suite).
//
// THE PAGE IS DRIVEN FOR REAL. The repository is mocked rather than seeded,
// because reaching the ceiling honestly needs twenty thousand rows; what the
// mock proves is the seam — the page asks for the DETAILED counts and carries
// `capped` down to the panel. A page that went back to the bare wrapper would
// not find it on the mock at all.
// ===========================================================================
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
import { InterestPanel } from "./previsit-workspace";

async function page(): Promise<string> {
  return renderToStaticMarkup(await PreVisitTriageView({ clientSlug: "vitality" }));
}

function panel(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(InterestPanel, {
      clientSlug: "vitality",
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

describe("a capped grid is still a grid somebody can act on", () => {
  it("prints the floor beside every control rather than collapsing the panel", () => {
    const html = panel({ countsCapped: true });
    expect(html).toContain("at least 20,000");
    expect(html).toContain("Download the Whitening list as a CSV");
  });

  it("makes no claim about what the FILE holds off this page's rows (W3/29)", () => {
    // THE DEFECT this pins: the panel used to print "1 of at least 20,000 — the
    // rest are past this page" beside the export controls, because the file was
    // built from the rows this page had rendered. The export is the route's now
    // and walks the table itself, so that sentence would be false about the file
    // and is gone; the honest count arrives from the route after the click, in
    // the same words the file's first row uses.
    const html = panel({ countsCapped: true });
    expect(html).not.toContain("the rest are past this page");
    expect(html).not.toContain("1 of at least");
  });

  it("still says the TABLE below is cut, which is a claim about the page", () => {
    // The other half of the same distinction: the list on screen IS bounded, and
    // that sentence is true and stays.
    const html = panel({ more: true, pageSize: 400 });
    expect(html).toContain("This list is cut at 400 patients");
  });

  it("offers the export for a treatment the page shows none of", () => {
    // The counts say 20,000 people; this page happens to hold none of their rows
    // because they are older than its 400. The file is the server's, so the
    // control is offered — the old page-derived rule disabled it.
    const html = panel({ rows: [], counts: { whitening: 20_000 }, countsCapped: true });
    expect(html).toContain("Download the Whitening list as a CSV");
  });
});

/** The opening tag of one treatment's control, and nothing else. */
function control(html: string, label: string, kind: "Download" | "Copy"): string {
  const needle =
    kind === "Download" ? `Download the ${label} list as a CSV` : `Copy the ${label} list as an audience`;
  const at = html.indexOf(needle);
  expect(at, `no ${kind} control for ${label}`).toBeGreaterThan(0);
  return html.slice(at - 120, at);
}

// ===========================================================================
// A CAPPED ZERO IS NOT A ZERO (ruling W3/11, charter §0/5).
//
// THE DEFECT this pins: `nothingToExport` read `counts[treatment] ?? 0 === 0`
// as proof there is nobody, WITHOUT asking whether the count had finished. On
// the fallback keyset walk a treatment whose people all sit past the ceiling
// comes back as an absent key, so the card printed "at least 0" — a figure that
// admits it proved nothing — directly above a Download and a Copy that were
// both greyed out. Since W3/29 the server route is the ONE way a list leaves
// the platform, so that closed the only door, on exactly the practice whose
// list is too long to count. The route has no ceiling: it walks the table to
// its end and can reach the people this scan did not.
//
// Home's Operating system band already rules this way for its own bound
// (src/lib/home/os-band.ts, "A ZERO OFF A CAPPED READ IS NOT A ZERO"); this is
// the same rule on the screen the campaign is actually run from.
// ===========================================================================
describe("a capped zero closes no door and prints no figure", () => {
  it("keeps BOTH export controls live for a treatment a capped scan never reached", () => {
    // Whitening is at its ceiling; nobody asking about veneers was in the part
    // of the table the scan read. React omits `disabled` entirely when false.
    const html = panel({ counts: { whitening: 20_000 }, countsCapped: true });
    expect(control(html, "Veneers and bonding", "Download")).not.toContain("disabled=");
    expect(control(html, "Veneers and bonding", "Copy")).not.toContain("disabled=");
  });

  it("prints 'Not counted' rather than the nonsense floor 'at least 0'", () => {
    const html = panel({ counts: { whitening: 20_000 }, countsCapped: true });
    expect(html).not.toContain("at least 0");
    expect(html).toContain("Not counted");
    expect(html).toContain("this is not a zero");
  });

  it("still offers the whole-list export when every figure is an uncounted zero", () => {
    // `{}` off a capped scan is "we read none of it", not "there is nobody".
    const html = panel({ counts: {}, countsCapped: true });
    expect(html).toContain("Export everyone");
  });

  it("STILL disables a control when a COMPLETED count proves there is nobody", () => {
    // The other direction, and the mutation that matters: a panel that never
    // disabled anything would be as wrong as one that always did. An uncapped
    // zero is a real finding and keeps its bare figure.
    const html = panel({ counts: { whitening: 118, implants: 0 }, countsCapped: false });
    expect(control(html, "Implants", "Download")).toContain("disabled=");
    expect(control(html, "Implants", "Copy")).toContain("disabled=");
    expect(html).not.toContain("Not counted");
  });

  it("still hides the whole-list export when a COMPLETED count found nobody at all", () => {
    const html = panel({ counts: { whitening: 0 }, countsCapped: false });
    expect(html).not.toContain("Export everyone");
  });
});
