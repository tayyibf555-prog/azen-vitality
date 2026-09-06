// ===========================================================================
// THE IMPLANT LIST'S COVERAGE CLAIM IS ABOUT THE SITES IN SCOPE, NOT THE SITES
// THAT HAPPEN TO HAVE BEEN SCANNED.
//
// THE DEFECT this pins: `mergeCoverage` narrowed the window to the intersection
// of the rows `listCoverage` RETURNED. A site in scope with no scan row at all —
// never opened, not one day of book read — is simply absent from that array, so
// it narrowed nothing, and the surviving site's window was printed as the whole
// list's provenance: "Built from appointments between 6 August and 4 September"
// over a three-site scope where two practices had never been touched. Worse, the
// moment the scanned site reached the horizon the tail became "That is as far
// back as this list goes" — a COMPLETENESS claim over two sites nobody had
// looked at.
//
// It is not a hypothetical state. `runMiningSweep` walks the sites in a fixed
// order and breaks out of the site loop the moment it spends its patient-read
// budget, so the busiest site consumes the budget every run and the others get
// no coverage row — and the owner's "build candidates" door reaches that state
// in one click.
//
// THE PROOF DRIVES THE REAL SERVER COMPONENT against an in-memory database with
// a real three-site scope: the reads, the merge and the sentence are the
// shipped ones. Only the workspace is stubbed, because Tabs mounts one panel and
// the implant panel is never the active one — the stub prints the props the page
// resolved, which is exactly the seam under test (charter §0/5, ruling W3/11).
// ===========================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

const world = createFakeSupabase();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => world.client }));

/** All three practices, which is what the site switcher's "All sites" resolves to. */
const SCOPE = ["site-cc", "site-rv", "site-ng"];

vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({
    siteIds: SCOPE,
    selection: "all",
    isAllSites: true,
    siteName: null,
    label: "all sites",
  }),
}));
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => ({
    id: "usr_manager",
    name: "Blerta",
    email: "manager@example.com",
    role: "client_coordinator",
    clientId: "vitality",
    siteIds: SCOPE,
  }),
}));

// THE WORKSPACE IS STUBBED so the props the page resolved can be read. The panel
// that renders `coverage` is proven separately (previsit-truncation.test.ts
// renders MiningPanel directly); what is under test here is the sentence the
// server composes, which no rendering of the workspace would ever show, because
// the implant tab is not the one Tabs mounts.
vi.mock("./previsit-workspace", () => ({
  PreVisitWorkspace: (props: Record<string, unknown>) =>
    createElement("pre", null, JSON.stringify({
      miningCoverage: props.miningCoverage,
      miningExclusions: props.miningExclusions,
      scopeLabel: props.scopeLabel,
    })),
}));

import { PreVisitTriageView } from "./previsit-view";

beforeEach(() => {
  world.reset();
});

function seedCoverage(siteId: string, over: Record<string, unknown> = {}): void {
  world.seed("previsit_mining_scan", {
    site_id: siteId,
    covered_from: "2026-08-06",
    covered_to: "2026-09-04",
    examined: 120,
    candidates: 41,
    excluded_no_dob: 0,
    excluded_under_age: 0,
    last_run_at: "2026-09-04T02:20:00.000Z",
    more_to_read: true,
    ...over,
  });
}

async function sentences(): Promise<{ miningCoverage: string; miningExclusions: string }> {
  const html = renderToStaticMarkup(await PreVisitTriageView({ clientSlug: "vitality" }));
  const block = html.match(/<pre>([\s\S]*?)<\/pre>/);
  expect(block, "the stubbed workspace did not render; the page shape has changed").not.toBeNull();
  const decoded = block![1]
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return JSON.parse(decoded) as { miningCoverage: string; miningExclusions: string };
}

async function coverageSentence(): Promise<string> {
  return (await sentences()).miningCoverage;
}

async function exclusions(): Promise<string> {
  return (await sentences()).miningExclusions;
}

describe("the coverage sentence never claims a window for a site nobody has scanned", () => {
  it("names the sites the scan has not reached when only one of three has a row", async () => {
    seedCoverage("site-cc");
    const sentence = await coverageSentence();
    expect(sentence).toContain("Built from appointments between");
    expect(sentence).toContain("2 other sites in view have not been scanned at all");
    expect(sentence).toContain("nobody from them can be on this list yet");
  });

  it("never says the list is finished while a site in scope has never been scanned", async () => {
    // THE WORST VERSION OF THE DEFECT: the scanned site has reached its horizon,
    // so `moreToRead` is false on the only row there is, and the sentence used to
    // become "That is as far back as this list goes" — a completeness claim over
    // two practices whose book has not been opened.
    seedCoverage("site-cc", { more_to_read: false });
    const sentence = await coverageSentence();
    expect(sentence).not.toContain("That is as far back as this list goes");
    expect(sentence).toContain("The scan is still reading further back");
    expect(sentence).toContain("2 other sites in view have not been scanned");
  });

  it("says nothing about missing sites once every site in scope has a row", async () => {
    // THE OTHER DIRECTION. A page that always warned would be as useless as one
    // that never did, and this is the state the sentence is allowed to be plain
    // in: every site scanned, and the finished tail is then honest.
    for (const site of SCOPE) seedCoverage(site, { more_to_read: false });
    const sentence = await coverageSentence();
    expect(sentence).toContain("That is as far back as this list goes");
    expect(sentence).not.toContain("have not been scanned");
    expect(sentence).not.toContain("other sites in view");
  });

  it("counts one missing site in the singular", async () => {
    seedCoverage("site-cc");
    seedCoverage("site-rv");
    const sentence = await coverageSentence();
    expect(sentence).toContain("one other site in view has not been scanned at all");
    expect(sentence).toContain("nobody from it can be on this list yet");
  });

  it("still says the list has not been built when NO site has been scanned", async () => {
    const sentence = await coverageSentence();
    expect(sentence).toContain("This list has not been built yet");
    expect(sentence).not.toContain("have not been scanned at all");
  });

  it("keeps a FAILED coverage read apart from an unbuilt list", async () => {
    // `.catch(() => null)` on the read means "we could not look". Printing
    // "this list has not been built yet" for that is a second wrong statement
    // about the same thing, and a window printed off it would be a claim
    // nothing supports.
    seedCoverage("site-cc");
    world.failTable("previsit_mining_scan");
    const sentence = await coverageSentence();
    expect(sentence).toContain("could not be read just now");
    expect(sentence).not.toContain("This list has not been built yet");
    expect(sentence).not.toContain("Built from appointments between");
  });
});

// ---------------------------------------------------------------------------
// THE SAME GAP, IN THE SENTENCE DIRECTLY BELOW IT (handoff H108 / B81).
// ---------------------------------------------------------------------------
// `exclusionSentence` takes an optional scope and FAILS CLOSED without it: it
// appends "That is a count over the sites the scan has reached so far", which
// qualifies without claiming, because a caller that said nothing might have no
// gap at all. This page is not that caller — it computes `unscanned` one line
// above for the coverage sentence — so it hands the number over and the reader
// gets the counted gap in the same words, or the plain sentence when there is no
// gap to state.
// ---------------------------------------------------------------------------
describe("the exclusions sentence names the same gap the coverage sentence does", () => {
  it("counts the unscanned sites rather than hedging with 'so far'", async () => {
    seedCoverage("site-cc", { excluded_no_dob: 41 });
    const sentence = await exclusions();
    expect(sentence).toContain("41 patients have no date of birth on record");
    expect(sentence).toContain("2 other sites in view have not been scanned");
    expect(sentence).toContain("nobody there has been counted either way");
    expect(sentence, "the page knew the gap and hedged anyway").not.toContain("reached so far");
  });

  it("drops the SCOPE qualifier once every site in scope has been scanned", async () => {
    // THE OTHER DIRECTION: a sentence that always warned about SCOPE would be as
    // useless as one that never did — so the "other sites have not been scanned"
    // clause must be gone here.
    //
    // The per-run ceiling clause is NOT that qualifier and is still owed, however
    // complete the scan: the exclusion counters ADD ACROSS RUNS (migration 0097,
    // and 0101 for the third of them), so six occurrences can be fewer than six
    // people if somebody had extractions in two of the periods read. Scanning
    // every site closes the coverage gap; it does not make the figure a headcount.
    for (const site of SCOPE) seedCoverage(site, { excluded_no_dob: 2 });
    const sentence = await exclusions();
    expect(sentence).toBe(
      "Left off this list: up to 6 patients have no date of birth on record, so we could not tell whether they are 18 or over." +
        " Each run counts these again, so somebody with extractions in two of the periods we have read is in them twice:" +
        " the number of people is this or fewer.",
    );
  });

  it("says nothing at all when nobody was left off", async () => {
    // An empty string, not a sentence about zero exclusions.
    for (const site of SCOPE) seedCoverage(site);
    expect(await exclusions()).toBe("");
  });

  it("claims no exclusions off a coverage read that FAILED", async () => {
    seedCoverage("site-cc", { excluded_no_dob: 41 });
    world.failTable("previsit_mining_scan");
    expect(await exclusions()).toBe("");
  });
});
