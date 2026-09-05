// ===========================================================================
// THE PRE-VISIT LISTS ARE BOUNDED, AND THE SCREEN SAYS SO WHEN THE BOUND BITES.
//
// THE DEFECT this pins: the page read the interest list with `limit: 400` and
// the implant-candidate list with `limit: 300`, and neither repository function
// returns a "there is more" flag. So a list cut at its bound was
// indistinguishable from a list that had ended — and every count on the screen
// was the BOUND printed as a total: the tab badge (`rows.length`), the table's
// own "Showing 25 of 400" footer, and, on the mining tab, a SectionCard
// description about the SCAN WINDOW ("that is as far back as this list goes")
// sitting where a reader takes it for a statement about the list.
//
// The consequence is a coordinator working an outreach list to "completion"
// while the patients past the bound are invisible. Charter §0/5 — a truncated
// read never wears a complete number's clothes — and ruling W3/11.
//
// THE FIX, and what these tests hold: the page asks for ONE ROW MORE than it
// shows, so truncation is PROVEN rather than guessed (the same trick the
// Dentally sync ledger uses), and the extra row is dropped before rendering.
//
// TWO LEVELS, deliberately. The first block drives the REAL SERVER COMPONENT
// against an in-memory database, so the over-fetch itself is exercised: a test
// that only checked the panels would stay green if the view went back to asking
// for exactly 400. The second block renders the panels directly, because the
// Tabs primitive mounts only the active panel and the mining list can never be
// reached through the workspace.
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

const world = createFakeSupabase();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.client }));
// The site switcher's cookie and the session both need a request scope. Neither
// is what this file is about, and both are pinned by their own suites.
vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({
    siteIds: ["site-cc"],
    selection: "site-cc",
    isAllSites: false,
    siteName: "N15 Vitality Dental",
    label: "N15 Vitality Dental",
  }),
}));
// A PRACTICE MANAGER, not the owner — deliberately. The Tabs primitive mounts
// only the ACTIVE panel, and an owner's first tab is the question-bank editor,
// so the interest list an owner sees is never in the markup. The manager's first
// tab is the interest list itself, which is the panel these assertions are
// about; the mining panel is asserted directly below, for the same reason.
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
import { MiningPanel, PreVisitWorkspace } from "./previsit-workspace";

/** The bounds the page renders. One more than each is what it asks for. */
const INTEREST_PAGE = 400;
const MINING_PAGE = 300;

beforeEach(() => {
  world.reset();
});

function seedInterest(n: number): void {
  for (let i = 0; i < n; i += 1) {
    world.seed("treatment_interest", {
      id: `ti-${i}`,
      site_id: "site-cc",
      dentally_patient_id: `dp-${i}`,
      patient_name: `Patient ${i}`,
      treatment: "whitening",
      answer: "yes",
      response_id: `r-${i}`,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }
}

function seedCandidates(n: number): void {
  for (let i = 0; i < n; i += 1) {
    world.seed("previsit_mining_candidate", {
      id: `mc-${i}`,
      site_id: "site-cc",
      dentally_patient_id: `dp-${i}`,
      patient_name: `Candidate ${i}`,
      age: 40,
      last_extraction_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      matched_text: "Extraction UR6",
    });
  }
}

async function renderPage(): Promise<string> {
  const el = await PreVisitTriageView({ clientSlug: "vitality" });
  return renderToStaticMarkup(el);
}

describe("the pre-visit page proves truncation instead of guessing it", () => {
  it("says the interest list is cut when there is one row more than it shows", async () => {
    seedInterest(INTEREST_PAGE + 1);
    const html = await renderPage();
    expect(html).toContain(`This list is cut at ${INTEREST_PAGE.toLocaleString("en-GB")} patients`);
    // The tab badge wears its sign too: "400" reads as "there are four hundred".
    expect(html).toContain(`${INTEREST_PAGE}+`);
  });

  it("says NOTHING about a cut when the list ends exactly on the bound", async () => {
    // THE MUTATION THAT MATTERS. If the view asked for `limit: 400` instead of
    // 401, a full page and a full page plus one would look identical and the
    // sentence above would never appear; if it inferred `more` from a full page
    // instead, this case would wrongly claim a cut. Both directions are here.
    seedInterest(INTEREST_PAGE);
    const html = await renderPage();
    expect(html).not.toContain("This list is cut at");
    expect(html).not.toContain(`${INTEREST_PAGE}+`);
  });

  it("never shows the over-fetched row: the page holds exactly its bound", async () => {
    seedInterest(INTEREST_PAGE + 5);
    const html = await renderPage();
    // The DataTable footer counts the rows it was handed.
    expect(html).toContain(`Showing 25 of ${INTEREST_PAGE}`);
    expect(html).not.toContain(`Showing 25 of ${INTEREST_PAGE + 1}`);
  });

  it("leaves a failed read as a failed read, not as a cut one", async () => {
    // `null` means we could not look. A truncation sentence on top of that would
    // be a second wrong claim about the same list.
    world.failTable("treatment_interest");
    seedInterest(0);
    const html = await renderPage();
    expect(html).toContain("That is a failure to read them, not a finding");
    expect(html).not.toContain("This list is cut at");
  });

  it("applies the same proof to the implant candidates", async () => {
    // The mining tab is not the active one, so the sentence is asserted on the
    // panel below; what is proven HERE is that the view over-fetches for it and
    // passes the answer down — the badge is on the tab bar, which is rendered.
    seedCandidates(MINING_PAGE + 1);
    const html = await renderPage();
    expect(html).toContain(`${MINING_PAGE}+`);

    world.reset();
    seedCandidates(MINING_PAGE);
    expect(await renderPage()).not.toContain(`${MINING_PAGE}+`);
  });
});

describe("a cut list says so beside the names, not only on the tab", () => {
  const ROW = {
    id: "mc-1",
    patientId: "dp-1",
    patientName: "Alex Berry",
    age: 44,
    lastExtractionAt: "2026-08-02T10:00:00.000Z",
    matchedText: "Extraction UR6",
  };

  function panel(more: boolean): string {
    return renderToStaticMarkup(
      createElement(MiningPanel, {
        title: "Implant interest",
        rows: [ROW],
        // The coverage sentence at its most misleading: the scan has FINISHED,
        // so nothing here hints that the list itself might be short.
        coverage: "Built from appointments between 4 September 2023 and 4 September 2026. That is as far back as this list goes.",
        exclusions: "",
        caveats: ["This is not a clinical assessment."],
        more,
        pageSize: MINING_PAGE,
      }),
    );
  }

  it("prints the cut beside the mining list, under the table the coverage line sits above", () => {
    const html = panel(true);
    expect(html).toContain(`This list is cut at ${MINING_PAGE} patients`);
    expect(html).toContain("the count above is a floor, not a total");
    // ...after the names, where the "Showing 25 of N" claim is.
    expect(html.indexOf("This list is cut at")).toBeGreaterThan(html.indexOf("Alex Berry"));
  });

  it("says nothing when the list is whole", () => {
    expect(panel(false)).not.toContain("This list is cut at");
  });

  it("defaults to silent, so a caller that cannot prove a cut never claims one", () => {
    // `more` is optional and defaults to false: a panel handed a full page has no
    // way of telling a full page from a full page plus one, which is exactly why
    // the server over-fetches rather than the panel inferring.
    const html = renderToStaticMarkup(
      createElement(MiningPanel, {
        title: "Implant interest",
        rows: [ROW],
        coverage: "",
        exclusions: "",
        caveats: [],
      }),
    );
    expect(html).not.toContain("This list is cut at");
  });

  it("counts an interest tab badge with its sign when the list was cut", () => {
    const html = renderToStaticMarkup(
      createElement(PreVisitWorkspace, {
        clientSlug: "vitality",
        isOwner: false,
        treatments: [],
        interest: [
          { id: "i1", patientId: "dp-1", patientName: "Alex Berry", treatment: "whitening", createdAt: "2026-08-02T10:00:00.000Z" },
        ],
        interestCounts: {},
        interestMore: true,
        interestPageSize: 1,
        mining: [],
        miningTitle: "Implant interest",
        miningCoverage: "",
        miningExclusions: "",
        miningCaveats: [],
        systemEnabled: true,
      }),
    );
    expect(html).toContain("1+");
    expect(html).toContain("This list is cut at 1 patients");
  });
});
