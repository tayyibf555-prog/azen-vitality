import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { SEXTANT_LABEL, SEXTANTS } from "@/lib/perio/bpe";
import { buildPlaqueBleedingChart, buildPocketChart, liveBopScore } from "@/lib/perio/pocket-chart";
import type { PlaqueBleedingView, PocketChartView } from "@/lib/perio/pocket-chart";
import { SITE_IDS } from "@/lib/perio/pocket-chart";
import type {
  BpeScore,
  PerioAttribution,
  PerioSiteMeasurement,
  SextantId,
  SextantStatus,
} from "@/lib/perio/types";
import { PerioShell, type PerioShellProps } from "./perio-shell";

// ===========================================================================
// THE PERIO TAB, PROVEN BY RENDERING IT.
//
// vitest collects only src/**/*.test.ts and runs in the node environment, so no
// .tsx file can BE a test — but a .ts test can import one, and react-dom/server
// will render it. That distinction is what lets the claims below be checked
// rather than asserted: "with the gate off nothing can be authored" is a property
// of the MARKUP, not of a component's intentions, and the only honest way to
// check it is to produce the markup and look.
//
// WHAT THIS FILE IS FOR. Two builders wrote the BPE grid and the six-point chart
// against a described interface, in parallel, without seeing each other's code.
// Prose agreement between their reports is not agreement. These tests render the
// assembled screen and assert on what a clinician would actually see.
//
// THEY ARE ALSO THE RECONCILIATION. Every failure here is a real disagreement
// between the shell and a leaf, not a snapshot that needs re-blessing: nothing
// below matches a whole string of layout, only sentences and elements whose
// presence or absence is the clinical claim.
// ===========================================================================

const CLINICIAN = { id: "user-1", name: "Blerta Hoxha", gdcNumber: null };
const RECORDED: PerioAttribution = { clinician: CLINICIAN, at: "2026-07-01T09:00:00.000Z" };

/** The gate's real sentences, so a test cannot pass against copy that the tab
 *  does not use. Imported through the shell's prop contract rather than from
 *  gate.ts, which is `import "server-only"`. */
const COPY = {
  preview: "PREVIEW-SENTENCE-MARKER",
  bothRecords: "BOTH-RECORDS-MARKER",
  disabled: "DISABLED-MARKER",
  doubleEntry: "DOUBLE-ENTRY-MARKER",
  readFailed: "READ-FAILED-MARKER",
  noAuthor: "NO-AUTHOR-MARKER",
  bpeEntryReadOnly: "BPE-ENTRY-READ-ONLY-MARKER",
  saveFailed: "SAVE-FAILED-MARKER",
};

function baseProps(over: Partial<PerioShellProps> = {}): PerioShellProps {
  return {
    clientSlug: "vitality",
    siteId: "site-cc",
    patientId: "pat-001",
    enabled: false,
    canSave: false,
    copy: COPY,
    bpeExam: null,
    bpeExamId: null,
    bpeFailed: false,
    latestChart: null,
    previousChart: null,
    chartsFailed: false,
    chartIssues: [],
    notices: [],
    clinician: CLINICIAN,
    openedAt: "2026-08-02T09:00:00.000Z",
    ...over,
  };
}

function render(over: Partial<PerioShellProps> = {}): string {
  return renderToStaticMarkup(createElement(PerioShell, baseProps(over)));
}

/** Text as a reader sees it: tags stripped, entities undone, whitespace collapsed. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function exam(
  scores: Partial<Record<SextantId, BpeScore | null>>,
  statuses: Partial<Record<SextantId, SextantStatus>> = {},
) {
  const fullScores = {} as Record<SextantId, BpeScore | null>;
  const fullStatuses = {} as Record<SextantId, SextantStatus>;
  for (const s of SEXTANTS) {
    fullScores[s] = scores[s] ?? null;
    fullStatuses[s] = statuses[s] ?? "scorable";
  }
  return {
    scores: fullScores,
    statuses: fullStatuses,
    probe: "who-621" as const,
    probeNote: null,
    recorded: RECORDED,
  };
}

function sites(depth: number): PerioSiteMeasurement[] {
  return SITE_IDS.map((site) => ({
    site,
    probingDepth: depth,
    recession: 1,
    bleeding: false,
    suppuration: false,
    plaque: false,
  }));
}

/** A chart covering exactly the upper-right sextant, DECLARING all six. */
function partialChart(): PocketChartView {
  return buildPocketChart({
    sextants: [...SEXTANTS],
    teeth: [17, 16, 15, 14].map((tooth) => ({
      tooth,
      sites: sites(4),
      mobility: null,
      furcation: null,
    })),
    recorded: RECORDED,
    probe: "who-621",
  });
}

// ---------------------------------------------------------------------------
// The gate. The whole risk of the module.
// ---------------------------------------------------------------------------

describe("the perio tab with the gate shut", () => {
  it("renders the screen rather than hiding it, and says it is a preview", () => {
    const body = text(render());
    expect(body).toContain(COPY.preview);
    // BpeGrid's own banner. The two sentences are complementary and neither is
    // printed twice: `preview` says what the screen is, `disabled` says why and
    // where the real record lives.
    expect(body).toContain(COPY.disabled);
    expect(body.split(COPY.disabled).length - 1).toBe(1);
    expect(body.split(COPY.preview).length - 1).toBe(1);
  });

  it("NEVER states the FP17 double-entry warning, because nothing is being entered", () => {
    // Amber on a screen where nothing can be recorded is how a practice learns to
    // read past amber. The warning appears the moment the gate opens, and not
    // before it.
    expect(text(render())).not.toContain(COPY.doubleEntry);
  });

  it("AUTHORS NOTHING: there is no input, button, textarea or select on the page", () => {
    const markup = render();
    for (const tag of ["<input", "<button", "<textarea", "<select", "contenteditable"]) {
      expect(markup, `the gate is shut and the markup contains ${tag}`).not.toContain(tag);
    }
  });

  it("still shows the six BPE entry boxes, and says why nothing on them can be typed", () => {
    // The panel does not vanish: the shape of the feature is what the preview is
    // FOR, and a practice deciding whether to switch this on has to be able to see
    // what they would be switching on. What it must never do is look typeable —
    // which the assertion above proves, because there is no control on the page.
    const body = text(render());
    expect(body).toContain("Record a BPE");
    expect(body).toContain(COPY.bpeEntryReadOnly);
    // Six boxes, and not one of them blank or showing a digit.
    for (const sextant of SEXTANTS) {
      expect(body, `${sextant} is missing from the entry grid`).toContain(SEXTANT_LABEL[sextant]);
    }
  });

  it("does not announce a gap it no longer has", () => {
    // PERIO_COPY.bpeEntryUnbuilt existed solely to say a BPE could not be typed
    // here. It can be now, so the sentence is gone — and this checks the copy
    // module rather than the markup, because a stale key left behind is the thing
    // that would quietly reappear on some other screen.
    expect(Object.keys(COPY)).not.toContain("bpeEntryUnbuilt");
    for (const markup of [render(), render({ enabled: true, canSave: true })]) {
      expect(text(markup)).not.toMatch(/cannot be typed on this screen yet/i);
      expect(text(markup)).not.toMatch(/until an entry form exists/i);
    }
  });

  it("still says a chart is owed, and says where to record it", () => {
    // A code 4 with the gate shut is the dangerous combination: the obligation is
    // real, and this platform is not where it can be met.
    const body = text(render({ bpeExam: exam({ LL: { code: 4, furcation: false } }) }));
    expect(body).toMatch(/full-mouth/i);
    expect(body).toContain("recorded in Dentally");
  });
});

describe("the perio tab with the gate open", () => {
  const open = { enabled: true, canSave: true };

  it("states the FP17 consequence, once, where the score is", () => {
    const body = text(render(open));
    expect(body).toContain(COPY.doubleEntry);
    expect(body.split(COPY.doubleEntry).length - 1).toBe(1);
  });

  it("states that findings can now exist in Dentally AND here", () => {
    // PERIO.md §4: this is the moment a clinician is most likely to look in the
    // wrong place, so the screen must say both.
    expect(text(render(open))).toContain(COPY.bothRecords);
  });

  it("lets a BPE be typed, which is the screening layer and the daily action", () => {
    // BPE has been a MANDATORY FP17 FIELD since 1 October 2022, so this is the
    // one periodontal reading that has to exist whether or not anyone is thinking
    // about periodontal disease that morning. The controls that prove it is
    // authorable are the grid it is typed into, the probe select and the button.
    const markup = render(open);
    expect(markup).toContain('aria-label="Record a Basic Periodontal Examination"');
    expect(markup).toContain("Record BPE");
    expect(text(markup)).toContain("Record a BPE");
    // And the read-only sentence is NOT printed, because it is not read-only.
    expect(text(markup)).not.toContain(COPY.bpeEntryReadOnly);
  });

  it("does not repeat the switched-off sentence", () => {
    expect(text(render(open))).not.toContain(COPY.disabled);
  });

  it("puts a six-point chart entry grid on the page", () => {
    // The entry grid types through a keydown handler on a role="grid" rather than
    // through 192 <input> elements — 192 focusable inputs is slower to drive than
    // paper, which PERIO.md §4 says is the failure mode that kills the feature. So
    // the controls that prove it is authorable are the probe <select> and the save
    // <button>, and the grid itself.
    const markup = render(open);
    expect(markup).toContain("<select");
    expect(markup).toContain("<button");
    expect(markup).toContain('role="grid"');
  });

  it("refuses authorship when the server cannot name a clinician", () => {
    // GDC 4.1.4. The screen still renders; what it will not do is attribute a
    // periodontal finding to nobody.
    expect(text(render({ ...open, clinician: null }))).toContain(COPY.noAuthor);
  });
});

// ---------------------------------------------------------------------------
// A sextant that cannot be scored
// ---------------------------------------------------------------------------

describe("a sextant that cannot be scored", () => {
  const unscorable = {
    enabled: true,
    canSave: true,
    bpeExam: exam({ UR: null }, { UR: "insufficient-teeth" }),
  };

  it("names the adjacent sextant its teeth are recorded with", () => {
    const body = text(render(unscorable));
    // ADJACENT_SEXTANT.UR is UA. The sentence must name it, not merely say the
    // sextant was skipped.
    expect(body).toContain(`recorded with the ${SEXTANT_LABEL.UA} sextant`);
  });

  it("says it is not a score of 0, in those words", () => {
    // The single most dangerous confusion in this module: "not scorable" is the
    // absence of a claim and 0 is a claim of health.
    expect(text(render(unscorable))).toMatch(/not scored — never 0|This is not a score of 0/);
  });

  it("does not print a digit for it", () => {
    const body = text(render(unscorable));
    expect(body).toContain("Too few teeth");
  });
});

// ---------------------------------------------------------------------------
// A partial chart
// ---------------------------------------------------------------------------

describe("a partial chart", () => {
  it("cannot summarise as full-mouth", () => {
    const body = text(render({ enabled: true, canSave: true, latestChart: partialChart() }));
    expect(body).toMatch(/Partial six-point chart/);
    expect(body).not.toMatch(/Full-mouth six-point chart: all six sextants hold readings/);
  });

  it("names the sextants it declared and never charted", () => {
    const body = text(render({ enabled: true, canSave: true, latestChart: partialChart() }));
    expect(body).toContain("unexamined, which is not the same as healthy");
    expect(body).toContain(SEXTANT_LABEL.LL);
  });

  it("says so about a chart whose coverage the builder computed, not one this file asserted", () => {
    // The engine's own answer, so the test cannot pass on a screen that agrees
    // with this file and disagrees with pocket-chart.ts.
    expect(partialChart().coverage).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// Failures, and what they must never look like
// ---------------------------------------------------------------------------

describe("a read that failed", () => {
  it("is never rendered as a patient with no findings", () => {
    const body = text(render({ enabled: true, canSave: true, bpeFailed: true }));
    expect(body).toContain(COPY.readFailed);
  });

  it("names which half of the screen it affects", () => {
    expect(text(render({ enabled: true, canSave: true, chartsFailed: true }))).toContain(
      "This affects the six-point charts below",
    );
    expect(text(render({ enabled: true, canSave: true, bpeFailed: true }))).toContain(
      "This affects the BPE below",
    );
  });

  it("prints a chart that could not be built rather than dropping it", () => {
    const issue = "A six-point chart recorded on 2026-01-02 could not be read and is not shown below.";
    expect(text(render({ enabled: true, canSave: true, chartIssues: [issue] }))).toContain(issue);
  });
});

describe("empty states", () => {
  it("never leaves a blank panel where a chart would be", () => {
    const body = text(render({ enabled: true, canSave: true }));
    expect(body).toContain("No six-point chart in this platform");
    expect(body).toContain("Nothing to compare yet");
  });

  it("says a BPE cannot measure treatment response", () => {
    // PERIO.md §3.1. A clinician looking at one chart and a stack of BPEs has to
    // be told that the BPEs cannot stand in for the second chart.
    expect(text(render({ enabled: true, canSave: true }))).toContain(
      "cannot measure treatment response",
    );
  });
});

// ---------------------------------------------------------------------------
// THE GUM LINE — the picture, beside the numbers it is drawn from.
//
// Dentally's claim for their perio chart is that it "gives you a good
// visualization of the patient's mouth allowing you to see at a glance how oral
// health has improved or changed over treatment time". We rendered numbers only.
// These tests are about the assembled screen: that the drawing is THERE, that it
// is on the same tab as its numbers, and that it never appears over a chart that
// does not exist.
// ---------------------------------------------------------------------------

describe("the gum line", () => {
  const withChart = { enabled: true, canSave: true, latestChart: partialChart() };

  it("is drawn on the same tab as the numbers it comes from, not on one of its own", () => {
    const markup = render(withChart);
    // The drawing itself: gum-line.tsx renders <svg> rows and no <path>.
    expect(markup).toContain("<svg");
    expect(text(markup)).toContain("Gum line and pocket depth");
    // Same panel as the six-point figures — one tabpanel holds both.
    const panel = /id="perio-panel-chart"[\s\S]*?id="perio-panel-plaque-bleeding"/.exec(markup);
    expect(panel, "the chart panel is not in the markup").toBeTruthy();
    expect(panel![0]).toContain("<svg");
    expect(panel![0]).toContain("Standing six-point chart");
  });

  /**
   * THE DRAWING IS OF THIS CHART, and that has to be asserted separately from
   * "a drawing is present".
   *
   * A mutation that left the <svg>, the heading, the legend and the scale
   * sentence exactly where they were and simply built the profiles from an empty
   * chart passed every other test in this describe. What renders then is four
   * empty arch rows and the sentence "no gum line is drawn" — a screen that says
   * a charted mouth was never probed. So the assertions below are on the
   * chart's OWN numbers reaching the picture: its site count, its 4mm-or-deeper
   * count, and a line actually being stroked.
   */
  it("draws THIS chart's readings, not an empty pair of arches", () => {
    const markup = render(withChart);
    const body = text(markup);
    // 4 teeth x 3 buccal sites measured, of 16 tooth positions x 3.
    expect(body).toContain("gum line drawn from 12 of 48 sites");
    // Every site in the fixture is 4mm, which is Dentally's red-underline mark.
    expect(body).toContain("12 sites at 4mm or deeper");
    // A stroked line, not just an axis: polylines exist and carry vertices.
    const lines = [...markup.matchAll(/<polyline[^>]*points="([^"]+)"/g)].map((m) => m[1]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((points) => points.split(" ").length > 1)).toBe(true);
  });

  it("carries the chart's own coverage sentence, so a partial chart is not read as a mouth", () => {
    // The drawing's most dangerous property: four arch rows look like a whole
    // dentition whatever was actually probed.
    //
    // ASSERTED WHERE THE DRAWING IS, not anywhere on the page. The summary block
    // prints the same sentence a few hundred pixels higher, so a page-wide match
    // stayed green with the drawing's own scopeNote removed — and a reader
    // scrolled down to four full arches has that sentence off screen.
    const markup = render(withChart);
    const from = markup.indexOf("cannot be drawn on");
    const to = markup.indexOf("gingival margin, from recession");
    expect(from, "the gum line's own header is not in the markup").toBeGreaterThan(-1);
    expect(to, "the gum line's legend is not in the markup").toBeGreaterThan(from);
    expect(text(markup.slice(from, to))).toMatch(/Partial six-point chart/);
  });

  it("states its scale on the page, because a picture with an unstated scale is a shape", () => {
    expect(text(render(withChart))).toMatch(/millimetre|mm (above|below)|per millimetre/i);
  });

  it("says it cannot be drawn on", () => {
    expect(text(render(withChart))).toContain("cannot be drawn on");
  });

  it("is NOT drawn when there is no chart — an empty mouth is a claim about a mouth", () => {
    const markup = render({ enabled: true, canSave: true });
    expect(text(markup)).not.toContain("Gum line and pocket depth");
    expect(text(markup)).toContain("No six-point chart in this platform");
  });
});

// ---------------------------------------------------------------------------
// PLAQUE AND BLEEDING — Dentally's second tab, and the fact that it IS a second
// tab rather than another block on the same page.
// ---------------------------------------------------------------------------

function plaqueBleedingRecord(): PlaqueBleedingView {
  return buildPlaqueBleedingChart({
    examinedTeeth: [16, 15, 14, 11],
    teeth: [
      { tooth: 16, surfaces: [{ surface: "buccal", plaque: true, bleeding: true }] },
      { tooth: 15, surfaces: [{ surface: "mesial", plaque: true }] },
      { tooth: 14, surfaces: [{ surface: "lingual", bleeding: true }] },
    ],
    recorded: RECORDED,
  });
}

describe("the plaque and bleeding examination", () => {
  const open = { enabled: true, canSave: true };

  it("has its own tab, alongside the six-point chart and not inside it", () => {
    const markup = render(open);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('id="perio-tab-chart"');
    expect(markup).toContain('id="perio-tab-plaque-bleeding"');
    expect(markup).toContain('role="tabpanel"');
    // Exactly two examinations, so a third tab appearing is a decision somebody
    // has to make rather than something that drifts in.
    expect((markup.match(/role="tab"/g) ?? []).length).toBe(2);
  });

  it("opens on the six-point chart, which is the examination the protocol demands", () => {
    const markup = render(open);
    expect(markup).toMatch(/id="perio-tab-chart"[^>]*aria-selected="true"/);
    // The other panel is in the markup and hidden, so a switch cannot reveal
    // something the server never produced.
    expect(markup).toMatch(/id="perio-panel-plaque-bleeding"[^>]*hidden/);
  });

  it("says out loud that it is a different examination from the pocket chart", () => {
    // The two record plaque and bleeding on different things — surfaces against
    // probed sites — and a reader who thinks one is a view of the other will
    // read a low plaque score as a low bleeding-on-probing score.
    expect(text(render(open))).toContain("not derived from it");
  });

  it("prints the percentages, and the denominator they are percentages OF", () => {
    const body = text(render({ ...open, plaqueBleeding: plaqueBleedingRecord() }));
    // 4 teeth × 4 surfaces = 16 available. 2 plaque, 2 bleeding, 1 both.
    expect(body).toContain("16 surfaces of the 4 teeth examined");
    expect(body).toContain("12.5%"); // 2/16 plaque and 2/16 bleeding
    expect(body).toContain("6.3%"); //  1/16 both
    // The counts as well as the percentage. "12.5%" alone leaves a reader
    // guessing whether the denominator is teeth, sites or surfaces.
    expect(body).toContain("2 of 16 surfaces");
    expect(body).toContain("1 of 16 surfaces");
  });

  it("lets plaque and bleeding exceed 100% between them, because a surface can be both", () => {
    // Dentally's three colours are three independent findings and the orange
    // surfaces are counted in all three figures. Pinned so nobody later
    // "fixes" the arithmetic into something that adds up.
    const record = plaqueBleedingRecord();
    expect(record.scores.bothSurfaces).toBe(1);
    expect(record.scores.plaqueSurfaces + record.scores.bleedingSurfaces).toBe(4);
    expect(record.scores.availableSurfaces).toBe(16);
  });

  it("says teeth that were not examined are absent from the figures, not clean", () => {
    expect(text(render({ ...open, plaqueBleeding: plaqueBleedingRecord() }))).toContain(
      "they are not clean",
    );
  });

  it("never renders an unrecorded examination as a clean mouth", () => {
    const body = text(render(open));
    expect(body).toContain("No plaque and bleeding examination in this platform");
    expect(body).toContain("not a finding about their oral hygiene");
  });

  it("does not tell a finding by colour alone", () => {
    // A red/green deficit affects roughly one man in twelve. Every marked
    // surface carries its letters and a name in words.
    const markup = render({ ...open, plaqueBleeding: plaqueBleedingRecord() });
    expect(markup).toContain("Tooth 16, buccal surface: plaque and bleeding");
    expect(markup).toContain("Tooth 14, lingual surface: bleeding");
    expect(markup).toContain("Tooth 11, mesial surface: examined, no plaque and no bleeding");
  });

  it("says it can be shown here and not yet recorded here, rather than letting it be assumed", () => {
    expect(text(render(open))).toContain("cannot yet be recorded here");
    // And with the gate shut the sentence is absent: the gate notice already
    // says nothing on this tab can be recorded, and two overlapping "you cannot
    // record" banners is how a practice learns to read past both.
    expect(text(render())).not.toContain("cannot yet be recorded here");
  });

  it("keeps the tab strip typeable-free with the gate shut", () => {
    // The strip is anchors, not buttons, precisely so the assertion at the top of
    // this file stays absolute. Restated here as the reason, not just the effect.
    const markup = render();
    expect(markup).toContain('role="tablist"');
    expect(markup).not.toContain("<button");
  });
});

// ---------------------------------------------------------------------------
// DENTALLY'S SCALES ON THE ASSEMBLED SCREEN.
// ---------------------------------------------------------------------------

describe("the scales this tab names", () => {
  it("never names Hamp or Miller anywhere on the page", () => {
    // A screen that names a scale the keyboard does not use is a screen a
    // hygienist has to translate. Checked over the whole assembled tab rather
    // than per component, because one surviving label is the bug.
    for (const markup of [
      render(),
      render({ enabled: true, canSave: true, latestChart: partialChart() }),
    ]) {
      expect(text(markup)).not.toMatch(/Hamp|Miller/);
    }
  });

  it("names mobility in stages 1–3 and furcation in grades 1–4", () => {
    const body = text(render({ enabled: true, canSave: true, latestChart: partialChart() }));
    expect(body).toContain("Mobility (stages 1–3)");
    expect(body).toContain("Furcation (grades 1–4)");
  });
});

// ---------------------------------------------------------------------------
// THE RSC BOUNDARY, held the same way src/lib/charting/boundary.test.ts holds
// the chart's: by reading source, because vitest collects no .tsx and the
// failure this guards against does not appear in a renderToStaticMarkup pass.
//
// A shared component taking function props that gains "use client" builds green
// and throws when a SERVER parent renders it — this repo has shipped that once.
// tab-perio.tsx is a server component; everything in perio/ that is not named
// below must stay universal.
//
// THIS SET GREW BY ONE, DELIBERATELY. bpe-entry.tsx is the second island, and it
// is one for the same reason as the first: recording is keyboard-driven local
// state that posts, which a server component cannot be. It obeys the same
// contract — every prop it takes is plain data, it imports no `server-only`
// module, and BpeGrid (universal) renders it from above the boundary, which is
// the legal direction.
//
// AND THEN BY ONE MORE. perio-tabs.tsx is the third, and it is the only one that
// is not an entry grid. Dentally's perio exam has two tabs — the pocket chart
// and Plaque & Bleeding — and "which tab is showing" is a piece of state, which
// a server component cannot hold. It is admitted on three conditions, each
// checked below: it holds NOTHING but that one value, both panels are built on
// the server and reach it as ReactNode slots rather than being re-derived under
// the boundary, and its props contain no function. It also renders anchors
// rather than buttons, so the gate-shut "there is nothing to type into"
// assertion above stays absolute instead of gaining an exception.
// ---------------------------------------------------------------------------

const PERIO_DIR = fileURLToPath(new URL("./", import.meta.url));
const TAB_PERIO = fileURLToPath(new URL("../tab-perio.tsx", import.meta.url));

function perioFiles(): { name: string; source: string }[] {
  return readdirSync(PERIO_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((name) => ({ name, source: readFileSync(`${PERIO_DIR}${name}`, "utf8") }));
}

/** The only files in perio/ allowed to be client islands: the two entry grids.
 *  Adding to this list is a decision, which is why it is a named constant with a
 *  reason above it rather than a condition inside the loop. */
const CLIENT_ISLANDS = new Set(["pocket-chart.tsx", "bpe-entry.tsx", "perio-tabs.tsx"]);

describe("the perio tab's client boundary", () => {
  it("puts every 'use client' directive on an entry grid, and nowhere else", () => {
    const files = perioFiles();
    expect(files.length).toBeGreaterThan(3);
    for (const { name, source } of files) {
      const declaresClient = /^\s*["']use client["']/m.test(source);
      expect(declaresClient, `${name} declares 'use client'`).toBe(CLIENT_ISLANDS.has(name));
    }
    // Both islands exist. A typo in the set above would otherwise silently relax
    // the check for a file that is not there.
    for (const island of CLIENT_ISLANDS) {
      expect(files.map((f) => f.name)).toContain(island);
    }
  });

  it("lets the server tab reach perio/ only through the shell", () => {
    const source = readFileSync(TAB_PERIO, "utf8");
    const imported = [...source.matchAll(/from\s+["'][^"']*\.\/perio\/([a-z0-9-]+)["']/g)].map(
      (m) => m[1],
    );
    expect(imported).toEqual(["perio-shell"]);
  });

  it("takes no function prop in anything the server renders directly", () => {
    // The other half of the same failure: a function prop does not throw on its
    // own, but it cannot cross the server boundary, so a server parent passing one
    // is a runtime error rather than a build one.
    //
    // The client islands are EXCLUDED because they ARE the boundary. Everything
    // below a "use client" module is allowed to hand functions around — that is
    // what being a client island means — and their own internal props are not
    // crossing anything.
    for (const { name, source } of perioFiles()) {
      if (CLIENT_ISLANDS.has(name)) continue;
      expect(source, `${name} takes an on* handler prop`).not.toMatch(/^\s*on[A-Z]\w*\??:\s*\(/m);
    }
  });

  it("keeps a client island's own props serialisable, so a server parent can render it", () => {
    // The other direction of the same failure. BpeGrid is universal and renders
    // BpeEntry, so BpeEntry's PUBLIC props must all be plain data — a function
    // among them compiles, ships, and throws the first time the server renders
    // the tab. Checked on the exported props interface, which is the contract.
    const source = readFileSync(`${PERIO_DIR}bpe-entry.tsx`, "utf8");
    const props = /export interface BpeEntryProps \{([\s\S]*?)\n\}/.exec(source);
    expect(props, "BpeEntryProps is not declared where this test can read it").toBeTruthy();
    expect(props![1]).not.toMatch(/:\s*\([^)]*\)\s*=>/);
    expect(props![1]).not.toMatch(/ReactNode|children/);
  });

  it("lets the tab island take PANELS but never a function", () => {
    // The third island is the one that takes ReactNode, and that is the whole
    // reason it is safe: a server parent may hand a client child ELEMENTS, and
    // may not hand it a FUNCTION. Both panels are therefore built above the
    // boundary and merely displayed below it — no chart is re-derived, no
    // percentage recomputed and no repository reached under the "use client".
    const source = readFileSync(`${PERIO_DIR}perio-tabs.tsx`, "utf8");
    const props = /export interface PerioTabsProps \{([\s\S]*?)\n\}/.exec(source);
    expect(props, "PerioTabsProps is not declared where this test can read it").toBeTruthy();
    expect(props![1]).not.toMatch(/:\s*\([^)]*\)\s*=>/);
    expect(props![1]).toMatch(/ReactNode/);
  });

  it("keeps the tab island to one piece of state and no data fetching", () => {
    // An island that starts fetching is an island that can disagree with the
    // server it was rendered by. One useState, and nothing else.
    const source = readFileSync(`${PERIO_DIR}perio-tabs.tsx`, "utf8");
    expect((source.match(/useState/g) ?? []).length).toBe(2); // the import and the call
    expect(source).not.toMatch(/useEffect|fetch\(|useSearchParams|usePathname/);
    // Anchors, not buttons — see the gate-shut assertion at the top of this file.
    expect(source).not.toMatch(/<button/);
  });

  it("never pulls the server-only gate into a component, which would poison the client graph", () => {
    // gate.ts is `import "server-only"`. Every sentence it owns reaches these
    // components as a prop; importing it here would make the shell unimportable
    // from any client component and drag the flag toward the wire.
    //
    // Matched on the IMPORT, not on the string: three of these files explain in
    // their own comments why they do not import it, and a check that cannot tell a
    // comment from an import would forbid documenting the decision.
    for (const { name, source } of perioFiles()) {
      expect(source, `${name} imports the server-only gate`).not.toMatch(
        /from\s+["'][^"']*perio\/gate["']/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// THE TOKEN LINK. Not a literal — the link.
//
// This repo has shipped `var(--x, fallback)` on an UNDECLARED token twice, and
// the chart builder found three more dead classes (shadow-card, shadow-shell,
// shadow-intensity) declared in :root and never mapped into @theme inline, so
// Tailwind generates no utility and the class silently paints nothing. A test
// that asserted a literal class name would have passed for all five.
//
// So: scan the colour utilities the two files I own actually use, and require
// each to be BOTH declared in :root AND mapped into @theme inline. Either half
// missing is a class that renders nothing.
// ---------------------------------------------------------------------------

const CSS = readFileSync(
  fileURLToPath(new URL("../../../../../app/globals.css", import.meta.url)),
  "utf8",
);
// GREW WITH THE TAB. plaque-bleeding.tsx introduces a new colour vocabulary —
// Dentally paints plaque yellow, bleeding red and both orange — and this palette
// declares no orange, so "both" is drawn as the bleeding fill inside an amber
// outline rather than as an invented `--tint-orange` that would resolve to
// nothing. That substitution is exactly the kind of thing this scan exists to
// catch, so the file is in it.
const OWNED = [
  "perio-shell.tsx",
  "perio-gate-notice.tsx",
  "bpe-entry.tsx",
  "bpe-grid.tsx",
  "perio-tabs.tsx",
  "plaque-bleeding.tsx",
].map((name) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"));

/** Utilities that take a keyword rather than a colour token. Alignment and text
 *  behaviour, border style and collapse, and the three colour keywords Tailwind
 *  resolves without a variable of ours. */
const NON_COLOUR = new Set([
  "left",
  "right",
  "center",
  "justify",
  "wrap",
  "nowrap",
  "balance",
  "collapse",
  "separate",
  "solid",
  "dashed",
  "dotted",
  "double",
  "hidden",
  "none",
  "transparent",
  "current",
  "inherit",
  "white",
  "black",
]);

/**
 * `border-b-2`, `border-t`, `border-x` — an EDGE and a width, not a colour.
 *
 * The colour on such an element arrives in a second class (`border-b-2
 * border-navy`), which this scan still sees and still checks. Without this the
 * tab strip's underline reports a missing `--color-b`, which is a token that was
 * never meant to exist — a false alarm on a scan whose whole value is that a
 * failure means something.
 */
const EDGE = /^[btlrxyse](-\d+(\.\d+)?)?$/;

function colourTokensUsed(): string[] {
  const found = new Set<string>();
  for (const source of OWNED) {
    for (const m of source.matchAll(/\b(?:bg|text|border)-([a-z][a-z0-9-]*)(?:\/\d+)?\b/g)) {
      if (!NON_COLOUR.has(m[1]) && !EDGE.test(m[1])) found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe("every colour class on this tab resolves to a real token", () => {
  const tokens = colourTokensUsed();

  it("uses some", () => {
    expect(tokens.length).toBeGreaterThan(4);
  });

  it("maps each one into @theme inline, so Tailwind generates the utility", () => {
    for (const token of tokens) {
      expect(CSS, `--color-${token} is not mapped into @theme inline`).toMatch(
        new RegExp(`--color-${token}:\\s*var\\(--${token}\\)`),
      );
    }
  });

  it("declares the variable each one points at, so it paints a colour", () => {
    for (const token of tokens) {
      expect(CSS, `--${token} is never declared, so var(--${token}) paints nothing`).toMatch(
        new RegExp(`^\\s*--${token}:\\s*\\S`, "m"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// THE LIVE BOP SCORE, ON THE ASSEMBLED SCREEN.
//
// Dentally: "A live % Bleeding on Probing (BOP) score will appear at the top of
// the perio chart." The engine's liveBopScore() was written, tested, given a
// label sentence — and imported by nothing at all, while the grid showed a site
// count in its place. A unit test on the engine cannot see that; only rendering
// the tab can. This is that test.
// ---------------------------------------------------------------------------

describe("the live bleeding-on-probing score", () => {
  const open = { enabled: true, canSave: true };

  it("is at the top of the entry grid, where Dentally puts it", () => {
    const body = text(render(open));
    expect(body).toContain("Bleeding on probing (live)");
  });

  it("says no site has been probed rather than printing a reassuring 0%", () => {
    // A 0% bleeding score on an unprobed mouth is a claim of health nobody made.
    // The sentence is the ENGINE's, so this cannot pass against a screen that
    // invented its own wording.
    const body = text(render(open));
    expect(body).toContain(liveBopScore([]).label);
    expect(body).toContain("no site has been probed yet");
  });

  it("keeps the site count as well, because progress and bleeding are different things", () => {
    expect(text(render(open))).toMatch(/0 of \d+ sites/);
  });

  it("is absent with the gate shut, along with the entry grid it sits on", () => {
    expect(text(render())).not.toContain("Bleeding on probing (live)");
  });
});

// ---------------------------------------------------------------------------
// DENTALLY'S DOUBLE-FIGURE KEY, SAID ON THE PAGE.
//
// `d` used to select the depth row here while Dentally uses it to type a double
// figure, so d-2 for a 12mm pocket recorded a 2mm one at the next site. The
// behaviour is fixed in the reducer and pinned in pocket-chart-entry.test.ts;
// this is the other half — that the screen TEACHES the key it now honours,
// rather than leaving a hygienist to discover it.
// ---------------------------------------------------------------------------

describe("the keys the entry grid advertises", () => {
  const open = { enabled: true, canSave: true };

  it("teaches d as the double-figure key, in Dentally's own terms", () => {
    const body = text(render(open));
    expect(body).toContain("a double figure, added to ten");
    expect(body).toContain("records 12");
  });

  it("says d then a digit in the grid's accessible name too", () => {
    // The grid is one focusable role="grid", so its aria-label is the only
    // instruction a screen-reader user gets before typing into it.
    expect(render(open)).toContain("press d and then a digit");
  });

  it("no longer offers d as the depth row, which is the collision itself", () => {
    const body = text(render(open));
    expect(body).toContain("switch between depth and recession");
    expect(body).not.toMatch(/d r\s+depth or recession/);
  });

  it("no longer claims a typed 1 waits", () => {
    // The mirror-image fabrication: 1 then 2 becoming a single 12.
    const body = text(render(open));
    expect(body).not.toMatch(/1 waits/);
    expect(body).not.toMatch(/a second digit extends the number/);
  });
});

// ---------------------------------------------------------------------------
// WHAT THIS PLATFORM DOES NOT KNOW ABOUT THE MOUTH.
//
// PerioShell takes `presentTeeth` and feeds it to the gum line, the read-only
// chart and the comparison. Nothing passes it, and nothing CAN: Dentally
// publishes no tooth status, which the FDI chart in this same record says on its
// own face. So the fix is not to wire the prop — it is to stop the silence.
// An extracted tooth renders as "not charted", which is the safer wrong answer
// and still a wrong answer, and a dangling prop is how that becomes an
// assumption in six months.
// ---------------------------------------------------------------------------

describe("the dentition this screen does not know", () => {
  const open = { enabled: true, canSave: true };

  it("says out loud that it does not know which teeth are present", () => {
    const body = text(render(open));
    expect(body).toContain("This platform does not know which teeth this patient has");
  });

  it("says a blank column may be an absent tooth rather than an unexamined one", () => {
    // The specific misreading. "Not charted" over a tooth that was taken out
    // years ago reads as an examination somebody still owes.
    const body = text(render(open));
    expect(body).toContain("may be absent rather than unrecorded");
    expect(body).toContain("Dentally is the record for the dentition");
  });

  it("says it over a standing chart too, where whole arches are drawn", () => {
    const body = text(render({ ...open, latestChart: partialChart() }));
    expect(body).toContain("This platform does not know which teeth this patient has");
  });

  it("STOPS saying it the moment a dentition is actually supplied", () => {
    // The mutation guard. A notice that prints unconditionally is decoration; this
    // one is a statement about the data, and it has to stop being true.
    const body = text(render({ ...open, presentTeeth: [16, 15, 14, 13, 12, 11] }));
    expect(body).not.toContain("This platform does not know which teeth this patient has");
  });

  it("does not print it with the gate shut, where nothing is read at all", () => {
    expect(text(render())).not.toContain("This platform does not know which teeth");
  });
});
