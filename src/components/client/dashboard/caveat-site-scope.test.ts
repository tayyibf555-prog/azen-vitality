import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// F5 — A SCOPE'S CAVEAT NAMES ONLY THE PRACTICES THAT SCOPE CAN SEE.
//
// `view.takingsFailedSites` is assembled ONCE for the whole group. The dashboard
// resolved it to names once, at view level, and handed the same list to every
// scope's takings caveat — so the caveat under a single-practice strip could name
// practices that are not on the screen.
//
// It reads as a contradiction, in one breath, in the same sentence pair. On a
// single-site scope computeTakingsStrip says "Takings unavailable: this site could
// not be read." — deliberately singular, because "one of the sites in this view" is
// plainly wrong when there is only one. The caveat then appended "The sites that did
// not answer: N15 Vitality Dental, N17 Dental." A manager looking at N15 was told her
// blank was caused by a practice she is not looking at, whose failure blanks nothing
// she can see.
//
// So the list is filtered to the strip's own scope before it is rendered, and a scope
// with no failures inside it appends nothing at all.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({ usePathname: () => "/c/vitality" }));

import { PracticeDashboard } from "./practice-dashboard";
import { buildDashboardView, type BuildViewInput } from "@/lib/dashboard/view";

const NOW = new Date("2026-07-30T09:42:00Z");
const SITE_A = { id: "site-cc", name: "N15 Vitality Dental" };
const SITE_B = { id: "site-rv", name: "N17 Dental" };

/**
 * An assembly where the takings read answered for NEITHER site: an empty window-total
 * map with sites in scope is exactly what a site outage looks like here, so every
 * period is blank and the "periods blank" caveat fires on every scope.
 */
function view(failed: readonly string[]) {
  const input: BuildViewInput = {
    now: NOW,
    sites: [SITE_A, SITE_B],
    practitioners: [],
    payments: [],
    paymentsCoverage: null,
    takingsWindowTotals: new Map(),
    takingsFailedSites: [...failed],
    rollups: null,
    appointments: null,
    appointmentsCoverage: null,
    appointmentRows: [],
    patients: null,
    activeCounts: null,
    plans: null,
    plansWindowed: true,
    invoices: null,
    balances: null,
    claims: null,
    udaTargets: {},
  };
  return buildDashboardView(input);
}

/**
 * The caveat row as first paint renders it. Caveats are collapsed, never dropped, so
 * every sentence the view produced is in this block.
 *
 * SCOPED TO THAT BLOCK ON PURPOSE. The page legitimately names every practice
 * elsewhere — the appointment list's site filter lists them all — so asserting
 * against the whole document would fail on the site <select> and prove nothing about
 * the caveat.
 */
function caveats(failed: readonly string[], initialSiteId: string | null): string {
  const html = renderToStaticMarkup(
    createElement(PracticeDashboard, {
      view: view(failed),
      clientSlug: "vitality",
      initialSiteId,
    }),
  );
  const start = html.indexOf('id="dashboard-caveat-text"');
  expect(start, "the caveat row is not in the markup at all").toBeGreaterThan(-1);
  // Up to the next <section>, which is the appointment list — the site <select> in
  // it names every practice by design and is nothing to do with this caveat.
  const end = html.indexOf("<section", start);
  return html.slice(start, end === -1 ? undefined : end);
}

const BOTH = [SITE_A.id, SITE_B.id];

describe("F5: the takings caveat is scoped to the strip it sits under", () => {
  it("names only the selected practice when both failed", () => {
    const html = caveats(BOTH, SITE_A.id);

    expect(html).toContain("The site that did not answer: N15 Vitality Dental.");
    expect(html, "a single-practice strip named a practice it is not showing").not.toContain(
      "N17 Dental",
    );
  });

  it("never follows the singular sentence with a list of several practices", () => {
    // The two halves have to agree. "this site could not be read" is the reason a
    // single-site scope prints; a plural list after it describes a different screen.
    const html = caveats(BOTH, SITE_B.id);

    expect(html).toContain("Takings unavailable: this site could not be read.");
    expect(html).toContain("The site that did not answer: N17 Dental.");
    expect(html, "the plural list is back under a singular sentence").not.toContain(
      "The sites that did not answer",
    );
  });

  it("appends nothing when the scope's own practice answered", () => {
    // Site A is fine; only B failed. A's strip is blank for its own reasons and must
    // not borrow B's explanation.
    const html = caveats([SITE_B.id], SITE_A.id);

    expect(html).not.toContain("The site that did not answer");
    expect(html).not.toContain("The sites that did not answer");
    // The caveat itself is still there — the blank is still disclosed, just not
    // blamed on a practice that is not on screen.
    expect(html).toContain("Takings unavailable: this site could not be read.");
  });

  it("CONTROL: the all-sites scope still names every practice that failed", () => {
    // The whole point of resolving ids to names. Narrowing the list must not have
    // narrowed it to nothing on the scope that genuinely covers both.
    const html = caveats(BOTH, null);

    expect(html).toContain("The sites that did not answer: N15 Vitality Dental, N17 Dental.");
    expect(html).toContain("Takings unavailable: one of the sites in this view could not be read.");
  });
});
