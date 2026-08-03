// ===========================================================================
// EVERY BLOCKED CONTROL STILL EXPLAINS ITSELF. Proved by RENDERING, not by grep.
//
// THE RULE THIS DEFENDS. The chart is a read-only mirror: Dentally publishes no
// create route on any charting resource, so New treatment plan, Select template,
// the round + and Record New BPE / BEWE are all rendered and all inert. The brief's
// standard for that is absolute — no affordance may be a disabled button with no
// explanation — and DisabledControl meets it by staying FOCUSABLE with
// aria-disabled, pointing aria-describedby at a RENDERED sentence.
//
// WHY A SOURCE SCAN WAS NOT ENOUGH. write-gate.test.ts already reads the source and
// pins that every write control sits behind canWriteChartToDentally(). It cannot see
// the failure mode that actually threatens these controls: `hideReason`. A card whose
// button sits hard against its right edge cannot carry a full clinical-safety
// sentence beside it, so plan-cards.tsx and plan-tabs.tsx suppress the built-in line
// and render it themselves, full width, under the id the control already points at.
// That is a contract between two files. Delete or rename one paragraph and the
// aria-describedby dangles: the control looks perfect on screen, the source still
// mentions the gate, the suite stays green, and a screen-reader user is told nothing
// at all about why the button will not act. Only a render catches it.
//
// A .ts FILE, AND NO JSX. vitest collects src/ ** / *.test.ts in a node environment
// and never a .tsx, so the components are built with createElement and rendered
// through react-dom/server. That is also a second, quieter assertion: everything
// here renders without a DOM, which is what "universal module" means in this
// directory.
// ===========================================================================

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { ChartTools } from "@/components/client/patients/record/chart/chart-tools";
import { ChartUnavailablePanel } from "@/components/client/patients/record/chart/chart-unavailable-panel";
import { PlanCards } from "@/components/client/patients/record/chart/plan-cards";
import { PlanTabs } from "@/components/client/patients/record/chart/plan-tabs";
import { CHART_COPY } from "@/lib/patient/tabs";
import type { ChartReadHealth, PlanRow } from "./types";

const HEALTH: ChartReadHealth = {
  items: "ok",
  treatments: "ok",
  categories: "ok",
  plans: "ok",
};
const PLANS: PlanRow[] = [
  { id: "p1", label: "Plan 1", status: "accepted", acceptedAt: "2026-01-01T00:00:00Z" },
];

const noop = () => {};

/** Every surface of the chart that renders a control Dentally would write with. */
function surfaces(): { name: string; node: ReactElement }[] {
  return [
    { name: "PlanCards", node: createElement(PlanCards) },
    {
      name: "PlanTabs",
      node: createElement(PlanTabs, {
        plans: PLANS,
        activePlanId: null,
        onSelectPlan: noop,
        health: HEALTH,
      }),
    },
    {
      name: "ChartTools",
      node: createElement(ChartTools, {
        baseMode: false,
        historyOpen: false,
        onOpenPanel: noop,
        onToggleBase: noop,
        onToggleHistory: noop,
        onOpenPreferences: noop,
      }),
    },
    // The BPE panel is where Dentally's "Record New BPE / BEWE" lives.
    { name: "ChartUnavailablePanel(bpe)", node: createElement(ChartUnavailablePanel, { variant: "bpe" }) },
  ];
}

/** Every id an aria-describedby in this markup points at. */
function describedByTargets(html: string): string[] {
  return [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
}

/** The text inside the element carrying this id, or null when there is none. */
function textOfElementWithId(html: string, id: string): string | null {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = html.indexOf(">", at);
  const close = html.indexOf("<", open);
  if (open < 0 || close < 0) return null;
  return html.slice(open + 1, close);
}

describe("blocked chart controls", () => {
  it("renders every one of them, rather than removing the ones we cannot fill", () => {
    const html = surfaces()
      .map((s) => renderToStaticMarkup(s.node))
      .join("");
    // A Dentally user's hand goes to these positions without reading. An absence
    // says the capability is gone; an inert control with a sentence says why.
    for (const label of [
      "New treatment plan",
      "Select template",
      "Record New BPE / BEWE",
    ]) {
      expect(html, `${label} must still be on the screen`).toContain(label);
    }
  });

  it("resolves every aria-describedby to a sentence that is actually rendered", () => {
    for (const { name, node } of surfaces()) {
      const html = renderToStaticMarkup(node);
      const targets = describedByTargets(html);
      for (const id of targets) {
        const text = textOfElementWithId(html, id);
        // THE DANGLING CASE. hideReason moves the sentence into the caller; if the
        // caller stops rendering it, this is where it is caught.
        expect(text, `${name}: aria-describedby="${id}" points at nothing`).not.toBeNull();
        expect(
          (text ?? "").trim().length,
          `${name}: the explanation for ${id} is empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("gives every inert control an aria-describedby, and never a bare disabled attribute", () => {
    for (const { name, node } of surfaces()) {
      const html = renderToStaticMarkup(node);
      const inert = [...html.matchAll(/<button[^>]*aria-disabled="true"[^>]*>/g)].map((m) => m[0]);
      for (const button of inert) {
        expect(button, `${name}: an inert control with no explanation`).toContain(
          "aria-describedby=",
        );
      }
      // `disabled` would take the control out of the tab order, so a keyboard user
      // could never reach the explanation at all. aria-disabled keeps it reachable.
      expect(html, `${name} must not use the disabled attribute`).not.toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
    }
  });

  it("renders the write-blocked sentence in full, never a shortened paraphrase", () => {
    const html = renderToStaticMarkup(createElement(PlanCards));
    // The clinical-safety copy lives in CHART_COPY so the record's copy sweep covers
    // it. Rendering a trimmed version here would put an unswept sentence on a
    // clinical screen.
    expect(html).toContain(CHART_COPY.writeBlockedTitle);
  });
});
