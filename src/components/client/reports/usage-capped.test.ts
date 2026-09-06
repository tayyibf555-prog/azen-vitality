// THE FLOOR ON THE USAGE PANEL, WHICH IS THE ONLY PLACE IT REACHES A PERSON.
//
// `usageSummary` reads at most USAGE_SCAN_CAP rows and sets `capped` when the
// window held more (pinned in src/lib/telemetry.test.ts). That flag is worth
// nothing if the screen prints the figure as a bare total anyway — charter §0/5
// and ruling W3/11 are about the SENTENCE, not the boolean. So this renders the
// real panel against a capped summary and reads what an owner would read.
//
// UsageSection is an async server component: awaiting it gives the element tree,
// which renderToStaticMarkup then turns into the markup Next would send.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ summary: vi.fn() }));
vi.mock("@/lib/telemetry", () => ({ usageSummary: h.summary }));

import { UsageSection } from "./usage-section";

interface Summary {
  windowDays: number;
  totalViews: number;
  surfaces: { surface: string; views: number }[];
  mostActiveUser: { email: string; views: number } | null;
  capped: boolean;
}

async function renderSummary(over: Partial<Summary>): Promise<string> {
  h.summary.mockResolvedValue({
    windowDays: 30,
    totalViews: 412,
    surfaces: [{ surface: "patients", views: 412 }],
    mostActiveUser: null,
    capped: false,
    ...over,
  } satisfies Summary);
  const element = await UsageSection({ clientId: "vitality" });
  return renderToStaticMarkup(element);
}

/**
 * A capped window with THREE DISTINGUISHABLE FIGURES on it.
 *
 * The original fixture gave its one surface row `views: totalViews` and a null
 * `mostActiveUser`, so a single "50,000" satisfied every assertion no matter
 * which of the three printed it — which is how a table of unqualified floors sat
 * under an honest headline through a green suite. Every number here is its own
 * value, so each has to be qualified on its own.
 */
const CAPPED: Summary = {
  windowDays: 30,
  totalViews: 50_000,
  surfaces: [
    { surface: "patients", views: 18_402 },
    { surface: "diary", views: 11_904 },
  ],
  mostActiveUser: { email: "blerta@vitalitydental.example", views: 9_120 },
  capped: true,
};

describe("the Usage panel prints a capped figure as a floor (W3/11)", () => {
  // MUTATION: drop the `summary.capped ? "at least " : null` in usage-section.tsx.
  // The headline then prints "50,000 page views" as an exact total for a window
  // the scan never finished counting.
  //
  // WHY THIS ASSERTION IS ANCHORED TO THE HEADLINE'S MARKUP (wave-3d review,
  // ruling W3/17). It used to be a bare `toContain("at least")` over the whole
  // panel, run against the DEFAULT fixture — whose one surface row is
  // `{ surface: "patients", views: 412 }`. Under `capped: true` that row renders
  // "at least 412", so the table underneath supplied the substring and the
  // headline mutation above stayed GREEN through the full suite: the vacuity the
  // CAPPED fixture below was introduced to kill had simply been inverted, with
  // the rows now rescuing the headline instead of the headline rescuing the rows.
  // Four figures on this panel wear the qualifier, so an assertion that cannot
  // say WHICH element produced it proves nothing about any of them. The regex
  // names the one sentence this test is about, in the house's own markup-anchored
  // style (`/>18,402</` below), and goes red under the mutation.
  it('says "at least" on the HEADLINE when the scan hit its bound', async () => {
    const html = await renderSummary(CAPPED);
    expect(html, "the headline total is printed bare, as a total the scan never proved").toMatch(
      /at least\s*<span[^>]*>50,000<\/span> page views/,
    );
  });

  it("leaves the headline in a plain figure when the whole window was read", async () => {
    const html = await renderSummary({});
    expect(html).not.toContain("at least");
    // Anchored the same way, so the negative above cannot be the whole of the
    // proof: the headline is still printed, and printed plainly.
    expect(html).toMatch(/<span[^>]*>412<\/span> page views/);
  });
});

describe("EVERY figure off the capped scan wears the cap, not only the headline", () => {
  // MUTATION: `countLabel(r.views, summary.capped)` → `r.views.toLocaleString("en-GB")`.
  it("qualifies each surface row, which is what a training decision gets sized on", async () => {
    const html = await renderSummary(CAPPED);
    expect(html).toContain("at least 18,402");
    expect(html).toContain("at least 11,904");
    // The bare floors must not be on the screen anywhere.
    expect(html).not.toMatch(/>18,402</);
    expect(html).not.toMatch(/>11,904</);
  });

  // MUTATION: `countLabel(summary.mostActiveUser.views, summary.capped)` →
  // `summary.mostActiveUser.views.toLocaleString("en-GB")`.
  it("qualifies the most-active tally", async () => {
    const html = await renderSummary(CAPPED);
    expect(html).toContain("at least 9,120");
  });

  // MUTATION: collapse the capped/uncapped label back to a plain "Most active: ".
  it("says the most-active NAME was picked from the counted slice, not the window", async () => {
    // The scan is newest-first: past the bound it ranked only the most recent
    // rows, so the winner of the whole window may not be the name on screen.
    const html = await renderSummary(CAPPED);
    expect(html).toContain("Most active of those counted:");
    expect(html).toContain("blerta@vitalitydental.example");
  });

  it("leaves an uncapped panel in plain figures, so the hedge keeps its meaning", async () => {
    const html = await renderSummary({ ...CAPPED, capped: false });
    expect(html).not.toContain("at least");
    expect(html).not.toContain("of those counted");
    expect(html).toContain(">18,402<");
    expect(html).toContain("Most active:");
  });
});
