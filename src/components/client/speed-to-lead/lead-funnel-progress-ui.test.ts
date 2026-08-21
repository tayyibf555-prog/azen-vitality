import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Worklist } from "./worklist";
import { LeadDrawer } from "./lead-drawer";
import { sourceLabel } from "@/lib/speed-to-lead/source-label";
import { FUNNEL_QUIET_MINUTES } from "@/lib/smile-assessment/funnel-progress";
import type { Lead } from "@/lib/types";

// WHAT THE PRACTICE ACTUALLY SEES. funnel-progress.test.ts pins the sentence; this
// file pins that the sentence reaches the two surfaces staff use, that it is
// ADDITIVE (a lead with no funnel renders exactly what it rendered before), and
// that the row and the drawer cannot contradict each other.
//
// TECHNIQUE: createElement + renderToStaticMarkup, the house idiom for a .tsx in a
// node-env suite. A static render runs no effects and no clicks, so the drawer is
// rendered directly rather than through the row it opens from.

const NOW = "2026-08-21T12:00:00.000Z";
/** A minute ago: inside the quiet period. */
const RECENT = "2026-08-21T11:59:00.000Z";
/** Comfortably past it. */
const QUIET = new Date(
  new Date(NOW).getTime() - (FUNNEL_QUIET_MINUTES + 5) * 60_000,
).toISOString();

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    siteId: "site-ng",
    name: "Amara Osei",
    stage: "contacted",
    assessmentScore: 82,
    treatmentInterest: "Invisalign",
    source: "smile:spring-implants",
    createdAt: "2026-08-21T11:00:00.000Z",
    firstResponseSeconds: 24,
    channel: "sms",
    ...over,
  };
}

/** Stopped on the third question of a five-question funnel. */
function stoppedOnQuestion(at: string): Lead {
  return lead({
    funnelProgress: {
      lastStep: 2,
      totalSteps: 7,
      flowVersion: 3,
      lastStepAt: at,
      completedAt: null,
    },
  });
}

function renderWorklist(leads: Lead[]): string {
  return renderToStaticMarkup(createElement(Worklist, { leads, nowIso: NOW }));
}

function renderDrawer(l: Lead): string {
  return renderToStaticMarkup(
    createElement(LeadDrawer, { lead: l, nowIso: NOW, onClose: () => {} }),
  );
}

describe("the worklist", () => {
  it("shows a compact indicator under the source, for a lead that has one", () => {
    const html = renderWorklist([stoppedOnQuestion(QUIET)]);
    expect(html).toContain("Left at question 3 of 5");
  });

  it("says 'At question N of M' while the session is still recent", () => {
    const html = renderWorklist([stoppedOnQuestion(RECENT)]);
    expect(html).toContain("At question 3 of 5");
    expect(html).not.toContain("Left at question");
  });

  it("says the assessment is complete when it is", () => {
    const html = renderWorklist([
      lead({
        funnelProgress: {
          lastStep: 6,
          totalSteps: 7,
          flowVersion: 3,
          lastStepAt: QUIET,
          completedAt: QUIET,
        },
      }),
    ]);
    expect(html).toContain("Assessment complete");
  });

  it("IS ADDITIVE: a lead with no funnel renders no indicator at all", () => {
    // Most leads are missed calls and website forms. Nothing about their row moves.
    const without = renderWorklist([lead({ source: "missed-call" })]);
    expect(without).not.toMatch(/question \d+ of|Assessment complete|finished/);
  });

  it("LEAVES sourceLabel ALONE — the indicator is a second line, not a new label", () => {
    const html = renderWorklist([stoppedOnQuestion(QUIET)]);
    expect(html).toContain(sourceLabel("smile:spring-implants"));
  });

  it("does not add a column: the header row is unchanged", () => {
    const before = renderWorklist([lead({ source: "missed-call" })]);
    const after = renderWorklist([stoppedOnQuestion(QUIET)]);
    const headers = (html: string) => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(headers(after)).toEqual(headers(before));
  });
});

describe("the lead drawer", () => {
  it("carries the full sentence prominently, beside the stage and the SLA", () => {
    const html = renderDrawer(stoppedOnQuestion(QUIET));
    expect(html).toContain("Abandoned at question 3 of 5");
  });

  it("says when, so 'abandoned' is answerable", () => {
    const html = renderDrawer(stoppedOnQuestion(QUIET));
    expect(html).toContain("Last activity");
  });

  it("says 'Finished' rather than 'Last activity' for a completed assessment", () => {
    const html = renderDrawer(
      lead({
        funnelProgress: {
          lastStep: 6,
          totalSteps: 7,
          flowVersion: 3,
          lastStepAt: QUIET,
          completedAt: QUIET,
        },
      }),
    );
    expect(html).toContain("Completed the assessment");
    expect(html).toContain("Finished");
    expect(html).not.toContain("Last activity");
  });

  it("does not call a recent session abandoned", () => {
    const html = renderDrawer(stoppedOnQuestion(RECENT));
    expect(html).toContain("Reached question 3 of 5");
    expect(html).not.toMatch(/Abandoned/i);
  });

  it("IS ADDITIVE: a lead with no funnel gets no Assessment row", () => {
    const html = renderDrawer(lead({ source: "missed-call" }));
    expect(html).not.toContain("Assessment</dt>");
    expect(html).not.toMatch(/question \d+ of/);
  });
});

describe("the row and the drawer cannot contradict each other", () => {
  // MUTATION: let the drawer read its own clock (`new Date().toISOString()`). A
  // page left open past the quiet period would then say "abandoned" in the panel
  // and "not finished yet" in the row behind it — one lead, two sentences, on one
  // screen.
  it("both are rendered against the same clock", () => {
    const borderline = new Date(
      new Date(NOW).getTime() - FUNNEL_QUIET_MINUTES * 60_000 + 1000,
    ).toISOString();
    const l = stoppedOnQuestion(borderline);
    expect(renderWorklist([l])).toContain("At question 3 of 5");
    expect(renderDrawer(l)).toContain("Reached question 3 of 5");
  });
});
