import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPocketChart } from "@/lib/perio/pocket-chart";
import type { PocketChartInput } from "@/lib/perio/pocket-chart";
import { buildGumProfile, buildGumProfiles } from "@/lib/perio/gum-profile";
import type { GumProfile } from "@/lib/perio/gum-profile";
import type { PerioAttribution, PerioSiteId, PerioSiteMeasurement } from "@/lib/perio/types";
import { GumLine } from "./gum-line";

// ===========================================================================
// THE DRAWING, ASSERTED ON THE MARKUP IT PRODUCES.
//
// gum-profile.test.ts pins the geometry: where a vertex lands, where a run
// breaks, which columns are deep. This file is the other half — what actually
// reaches an SVG — and it exists because the two can disagree. A renderer can
// hold a broken run and still stroke one polyline through it; it can hold a
// derived-only profile and still hang a pointer handler off the picture. Both
// of those are properties of the MARKUP, and the only honest way to check a
// property of the markup is to produce it and look.
//
// WHY THE INPUT AFFORDANCE TEST IS HERE AND NOT IN THE PURE MODULE. Adding
// `tabIndex` and `cursor-grab` to the row's <svg> — the first two things anyone
// reaches for when asked to make a chart "adjustable" — changed nothing any
// pure test could see. This file fails on it.
// ===========================================================================

const SITES: PerioSiteId[] = ["mb", "b", "db", "ml", "l", "dl"];
const RECORDED: PerioAttribution = {
  clinician: { id: "u1", name: "Blerta Hoxha", gdcNumber: null },
  at: "2026-07-01T09:00:00.000Z",
};

function sites(depth: number | null, recession: number | null): PerioSiteMeasurement[] {
  return SITES.map((site) => ({
    site,
    probingDepth: depth,
    recession,
    bleeding: false,
    suppuration: false,
    plaque: false,
  }));
}

function chart(teeth: PocketChartInput["teeth"], sextants: PocketChartInput["sextants"] = ["UR"]) {
  return buildPocketChart({ sextants, teeth, recorded: RECORDED });
}

function render(profiles: GumProfile[]): string {
  return renderToStaticMarkup(createElement(GumLine, { profiles, scopeNote: "SCOPE SENTENCE" }));
}

function upperBuccal(teeth: PocketChartInput["teeth"]): GumProfile {
  return buildGumProfile({ teeth: chart(teeth).teeth, arch: "upper", aspect: "buccal" });
}

const polylines = (markup: string) =>
  [...markup.matchAll(/<polyline[^>]*points="([^"]*)"/g)].map((m) => m[1]);
const polygons = (markup: string) =>
  [...markup.matchAll(/<polygon[^>]*points="([^"]*)"/g)].map((m) => m[1]);
const circles = (markup: string) => [...markup.matchAll(/<circle[^>]*cx="/g)].length;

// ---------------------------------------------------------------------------
// A site with no reading breaks the line — in the SVG, not only in the model
// ---------------------------------------------------------------------------

describe("the drawn line stops where the readings stop", () => {
  it("strokes two polylines, not one, across an unmeasured tooth", () => {
    // 16 and 14 fully probed; 15 has depths but no recession anywhere, so its
    // margin cannot be placed and the line has to break across it.
    const profile = upperBuccal([
      { tooth: 16, mobility: null, furcation: null, sites: sites(3, 1) },
      { tooth: 15, mobility: null, furcation: null, sites: sites(3, null) },
      { tooth: 14, mobility: null, furcation: null, sites: sites(3, 1) },
    ]);
    const markup = render([profile]);
    const gap = profile.columns.filter((c) => c.tooth === 15).map((c) => c.x);
    expect(gap.length).toBe(3);

    const lines = polylines(markup);
    expect(lines.length).toBeGreaterThanOrEqual(4); // margin and base, each side
    for (const line of lines) {
      const xs = line.split(" ").map((p) => Number(p.split(",")[0]));
      // No vertex sits on the unmeasured tooth...
      for (const x of gap) expect(xs).not.toContain(x);
      // ...and no stroke spans it either, which is the failure a smoothed curve
      // would produce: a drawn finding at a site nobody probed.
      const spans = Math.min(...xs) < Math.min(...gap) && Math.max(...xs) > Math.max(...gap);
      expect(spans, `a polyline spans tooth 15: ${line}`).toBe(false);
    }
  });

  it("draws a lone measured site as a dot, since a one-point polyline draws nothing", () => {
    const one: PerioSiteMeasurement[] = SITES.map((site) => ({
      site,
      probingDepth: site === "b" ? 4 : null,
      recession: site === "b" ? 2 : null,
      bleeding: false,
      suppuration: false,
      plaque: false,
    }));
    const markup = render([upperBuccal([{ tooth: 16, mobility: null, furcation: null, sites: one }])]);
    expect(polylines(markup).length).toBe(0);
    expect(circles(markup)).toBeGreaterThanOrEqual(2); // the margin and the base
  });

  it("marks the gap as a gap, with its reason, rather than leaving white space", () => {
    const markup = render(
      buildGumProfiles(
        chart([
          { tooth: 16, mobility: null, furcation: null, sites: sites(3, 1) },
          { tooth: 14, mobility: null, furcation: null, sites: sites(3, 1) },
        ]).teeth,
      ),
    );
    expect(markup).toContain("url(#gum-not-recorded-upper-buccal)");
    expect(markup).toMatch(/not drawn/);
    expect(markup).toMatch(/not a finding of health/);
  });
});

// ---------------------------------------------------------------------------
// Derived, never an input
// ---------------------------------------------------------------------------

describe("the drawing cannot be drawn on", () => {
  const markup = render(
    buildGumProfiles(
      chart([
        { tooth: 16, mobility: null, furcation: null, sites: sites(5, 2) },
        { tooth: 15, mobility: null, furcation: null, sites: sites(3, 1) },
      ]).teeth,
    ),
  );

  it("renders no control of any kind", () => {
    for (const tag of ["<input", "<button", "<textarea", "<select", "<form"]) {
      expect(markup, tag).not.toContain(tag);
    }
  });

  it("carries no pointer, drag, focus or edit affordance", () => {
    for (const attr of [
      "onclick",
      "onmousedown",
      "onpointerdown",
      "ondrag",
      "draggable",
      "tabindex",
      "contenteditable",
      "cursor-pointer",
      "cursor-grab",
      "cursor-move",
      "cursor-ew-resize",
      "cursor-ns-resize",
      'role="slider"',
      'role="button"',
      'role="textbox"',
    ]) {
      expect(markup.toLowerCase(), attr).not.toContain(attr);
    }
  });

  it("the geometry module offers no way back from screen units to millimetres", async () => {
    // A drag handle needs an inverse mapping. There isn't one, and this fails
    // the moment somebody adds one — which is cheaper than noticing afterwards.
    const mod = await import("@/lib/perio/gum-profile");
    for (const name of Object.keys(mod)) {
      expect(name, name).not.toMatch(/mmFor|fromY|toMm|setMm|invert|hitTest|atPoint/i);
    }
    expect(Object.keys(mod)).toContain("yForMm");
  });

  it("says so on the page, in words a clinician reads before reaching for a mouse", () => {
    expect(markup).toContain("cannot be drawn on");
  });
});

// ---------------------------------------------------------------------------
// Same attachment loss, different disease, different picture
// ---------------------------------------------------------------------------

describe("recession and pocketing do not draw alike", () => {
  function row(depth: number, recession: number) {
    const profile = upperBuccal([{ tooth: 16, mobility: null, furcation: null, sites: sites(depth, recession) }]);
    return { profile, markup: render([profile]) };
  }

  const pocket = row(3, 0); // a 3mm pocket, gum at the CEJ
  const recede = row(0, 3); // 3mm of recession, no pocket at all

  it("really are the same attachment loss, or this proves nothing", () => {
    const cal = (r: typeof pocket) => r.profile.baseVertices.map((v) => v.mm);
    expect(cal(pocket)).toEqual(cal(recede));
    expect(cal(pocket).every((mm) => mm === 3)).toBe(true);
  });

  it("produce different markup", () => {
    expect(pocket.markup).not.toBe(recede.markup);
  });

  it("put the gingival margin at different heights", () => {
    const ys = (m: string) =>
      JSON.stringify(polylines(m).map((l) => l.split(" ").map((p) => Number(p.split(",")[1]))));
    expect(ys(pocket.markup)).not.toBe(ys(recede.markup));
  });

  it("shade a band with area in one and a collapsed band in the other", () => {
    // The band polygon is the three margin points then the three base points.
    const band = (m: string) => polygons(m).filter((p) => p.split(" ").length === 6);
    const distinctYs = (points: string) =>
      new Set(points.split(" ").map((p) => p.split(",")[1])).size;
    expect(band(pocket.markup).length).toBeGreaterThan(0);
    expect(band(recede.markup).length).toBeGreaterThan(0);
    expect(distinctYs(band(pocket.markup)[0])).toBeGreaterThan(1);
    expect(distinctYs(band(recede.markup)[0])).toBe(1);
  });

  it("say which is which in words, not only in pixels", () => {
    expect(pocket.markup).toContain("Pocket, deepest 3mm");
    expect(recede.markup).toContain("No pocket here");
  });

  it("flag only the deep POCKET at Dentally's 4mm mark, never deep recession", () => {
    const deepPocket = row(4, 0);
    const deepRecession = row(0, 4);
    expect(deepPocket.profile.deepColumns.length).toBeGreaterThan(0);
    expect(deepRecession.profile.deepColumns.length).toBe(0);
    expect(deepPocket.markup).toMatch(/at 4mm or deeper/);
    expect(deepRecession.markup).not.toMatch(/at 4mm or deeper/);
  });
});

describe("the drawing names no retired scale", () => {
  it("has no Hamp and no Miller anywhere in its markup", () => {
    const markup = render(
      buildGumProfiles(chart([{ tooth: 16, mobility: 3, furcation: 4, sites: sites(5, 2) }]).teeth),
    );
    expect(markup).not.toMatch(/Hamp|Miller/);
  });
});
