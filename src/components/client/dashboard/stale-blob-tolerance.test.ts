// THE CRASH THIS PINS: commit 47353ac added `takingsFailedSites` to every scope
// of the dashboard view — and the first production render after the deploy
// crashed with `Cannot read properties of undefined (reading 'map')`, because
// the L2 display cache served a view blob SERIALIZED BY THE PREVIOUS
// DEPLOYMENT, whose scopes do not carry the field. No test could see it: the
// suite always builds views with today's builder. This file simulates exactly
// that skew — build a view with the current builder, then DELETE the new field
// the way a v1 blob would lack it — and requires the component to render.
//
// The durable rule: a component reading the cached dashboard view must tolerate
// one blob-version of missing-field skew (render, degrade quietly), because the
// cache outlives the deployment that wrote it. The cache-key bump
// ("dashboard:v2") makes the window transient; this tolerance makes it
// harmless. Both halves are asserted here.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PracticeDashboard } from "@/components/client/dashboard/practice-dashboard";
import { buildDashboardView } from "@/lib/dashboard/view";
import type { PracticeDashboardView } from "@/lib/dashboard/view";

function minimalView(): PracticeDashboardView {
  return buildDashboardView({
    now: new Date("2026-08-22T10:00:00+01:00"),
    sites: [
      { id: "site-cc", name: "N15 Vitality Dental" },
      { id: "site-ng", name: "Romford Road" },
    ],
    practitioners: [],
    payments: [],
    paymentsCoverage: null,
    takingsWindowTotals: new Map(),
    takingsFailedSites: ["site-ng"],
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
  });
}

describe("a dashboard view cached by a PREVIOUS deployment", () => {
  it("renders when its scopes lack takingsFailedSites, instead of crashing the page", () => {
    const view = minimalView();
    // Simulate the v1 blob: the field the old builder never wrote.
    for (const scope of view.scopes) {
      delete (scope as Partial<(typeof view.scopes)[number]>).takingsFailedSites;
    }
    const html = renderToStaticMarkup(
      createElement(PracticeDashboard, { view, clientSlug: "vitality", initialSiteId: null }),
    );
    expect(html.length).toBeGreaterThan(0);
  });

  it("still renders the current shape with the failed site named", () => {
    const view = minimalView();
    const html = renderToStaticMarkup(
      createElement(PracticeDashboard, { view, clientSlug: "vitality", initialSiteId: null }),
    );
    expect(html).toContain("Romford Road");
  });

  it("cannot be READ at all any more: the cache key was bumped past the v1 blobs", () => {
    const source = readFileSync("src/lib/dashboard/read.ts", "utf8");
    expect(source).not.toContain('"dashboard:v1"');
    expect(source).toContain('"dashboard:v2"');
  });
});
