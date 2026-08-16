// THE DROP-OFF CHART, held at the seams a pure test of the aggregation cannot
// reach: that every number the lib computed reaches the screen, that the component
// computes NONE of them itself, and that it stays a picture.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts,
// but .tsx components are freely imported and rendered: createElement plus
// renderToStaticMarkup is the house idiom (flow-phone-mini.test.ts:19-24). What a
// static render cannot show — what the file imports and what hooks it calls — is
// read out of the source as text.
//
// WHY A RENDER TEST AT ALL. This component is mounted from a client component
// (dropoff-section.tsx) inside the campaigns panel, so nothing else in the suite
// ever renders it — and a chart nobody has rendered is a chart nobody knows is
// wrong.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aggregateStepEvents, type StepFunnel } from "@/lib/smile-assessment/step-events";
import { DropoffChart, type DropoffChartProps } from "./dropoff-chart";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "dropoff-chart.tsx"), "utf8");

/** Source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const CODE = codeOnly(SOURCE);

function render(props: DropoffChartProps): string {
  return renderToStaticMarkup(createElement(DropoffChart, props));
}

/** The real thing, end to end: raw rows through the lib and into the markup. */
function funnelFrom(rows: Array<[number, string]>, opts?: { stepCount?: number }): StepFunnel {
  return aggregateStepEvents(
    rows.map(([stepIndex, nonce]) => ({ stepIndex, nonce })),
    opts,
  );
}

/** 10 sessions at step 0, 6 at step 1, 2 at step 2. */
function straightFunnel(): StepFunnel {
  const rows: Array<[number, string]> = [];
  for (let i = 0; i < 10; i++) rows.push([0, `s${i}`]);
  for (let i = 0; i < 6; i++) rows.push([1, `s${i}`]);
  for (let i = 0; i < 2; i++) rows.push([2, `s${i}`]);
  return funnelFrom(rows);
}

/* ---------------------------------------------------------------------------
 * 1. Every number the lib computed reaches the screen.
 * ------------------------------------------------------------------------- */

describe("the chart draws one bar per step, with that step's own numbers", () => {
  const funnel = straightFunnel();
  const html = render({ funnel });

  // MUTATION: render only the steps with traffic, or cap the list. The bottom of
  // the funnel is the half an owner opened this for.
  it("draws every step, in order", () => {
    const bars = html.split("<li>").length - 1;
    expect(bars).toBe(3);
    expect(html.indexOf("Step 1")).toBeLessThan(html.indexOf("Step 2"));
    expect(html.indexOf("Step 2")).toBeLessThan(html.indexOf("Step 3"));
  });

  // MUTATION: show only the percentage. "60%" without "6" hides that this funnel
  // is being judged on six people, which is the difference between a signal and
  // noise.
  it("prints both the count and the share still present", () => {
    for (const text of [">10<", ">6<", ">2<", "100%", "60%", "20%"]) {
      expect(html, `missing ${text}`).toContain(text);
    }
  });

  // MUTATION: label the bar with the raw ordinal. step_index is 0-based in the
  // table because it is an index; "Step 0" is not a thing a human counts.
  it("numbers the fallback labels from one, not from zero", () => {
    expect(html).toContain("Step 1");
    expect(html).not.toContain("Step 0");
  });

  it("prefers the labels it was given, and falls back per step", () => {
    const labelled = render({
      funnel,
      labels: { 0: "Which treatment?", 2: "Your details" },
    });
    expect(labelled).toContain("Which treatment?");
    expect(labelled).toContain("Your details");
    // Step index 1 had no label, so it keeps the ordinal.
    expect(labelled).toContain("Step 2");
  });

  it("carries the session count and the completion headline", () => {
    expect(html).toContain("10");
    expect(html).toContain("sessions");
    expect(html).toContain("reached the last step");
  });

  // MUTATION: pluralise unconditionally and a one-session funnel reads "1 sessions".
  it("says session, singular, when there is one", () => {
    const single = render({ funnel: funnelFrom([[0, "only-one"]]) });
    expect(single).toContain("session");
    expect(single).not.toContain("sessions");
  });
});

describe("the loss between two steps is stated, not left to be eyeballed", () => {
  const html = render({ funnel: straightFunnel() });

  // MUTATION: put the badge on the step the people left FROM. dropOffPct is
  // defined as the loss coming INTO a step (step-events.ts), so rendering it on
  // the previous row blames the wrong screen — the single most consequential thing
  // this chart can get wrong.
  it("shows the drop-off above the step it was lost getting to", () => {
    const firstBar = html.indexOf("Step 1");
    const secondBar = html.indexOf("Step 2");
    const badge = html.indexOf("40% drop-off");
    expect(badge).toBeGreaterThan(firstBar);
    expect(badge).toBeLessThan(secondBar);
  });

  it("prints the lib's own rounding, to one decimal", () => {
    expect(html).toContain("40% drop-off");
    expect(html).toContain("66.7% drop-off");
  });

  // MUTATION: render a badge for the first step. There is nothing before it, so a
  // "0% drop-off" chip there is a fact about nothing.
  it("shows no badge on the first step", () => {
    const firstBadge = html.indexOf("drop-off");
    expect(firstBadge).toBeGreaterThan(html.indexOf("Step 1"));
  });

  // MUTATION: hide a zero. "No drop-off" is a result an owner wants to see — it is
  // the screen that is working.
  it("says so out loud when a step loses nobody", () => {
    const flat = render({ funnel: funnelFrom([[0, "a"], [1, "a"], [0, "b"], [1, "b"]]) });
    expect(flat).toContain("no drop-off");
    expect(flat).not.toContain("0% drop-off");
  });

  // MUTATION: render `null` as 0%. The lib returns null when the previous step had
  // no sessions, because "100% of nobody" is not a fact — and "0% drop-off" there
  // would read as "this screen loses nobody", the exact opposite.
  it("renders nothing at all where the lib said nothing", () => {
    // Steps 0,1,2,3 with views 2,0,1,0 — step 2's dropOffPct is null.
    const gapped = funnelFrom([[0, "a"], [0, "b"], [2, "a"]], { stepCount: 4 });
    expect(gapped.steps[2].dropOffPct).toBeNull();
    const gappedHtml = render({ funnel: gapped });
    // Three badges, not four: steps 1 and 3 lost everybody, step 2 has no
    // denominator, step 0 has nothing before it.
    expect(gappedHtml.split("drop-off").length - 1).toBe(2);
    expect(gappedHtml).toContain("100% drop-off");
  });
});

/* ---------------------------------------------------------------------------
 * 2. It computes nothing. The lib is the only arithmetic.
 * ------------------------------------------------------------------------- */

describe("the chart does no arithmetic of its own", () => {
  // MUTATION: recompute the drop-off from the two view counts "because it is right
  // there". Then two surfaces reading the same funnel round differently, a
  // screenshot stops matching a CSV, and the clamp that stops a branch drawing a
  // negative bar lives in one of them and not the other. Fed a funnel whose numbers
  // are deliberately inconsistent, the component must print what it was HANDED.
  it("prints the numbers it was handed, even when they disagree with each other", () => {
    const rigged: StepFunnel = {
      steps: [
        { stepIndex: 0, views: 5, dropOffPct: null, reachedPct: 100 },
        { stepIndex: 1, views: 5, dropOffPct: 42, reachedPct: 77 },
      ],
      sessions: 5,
      completionPct: 13,
    };
    const html = render({ funnel: rigged });
    expect(html).toContain("42% drop-off"); // not 0%, which the counts would imply
    expect(html).toContain("77%"); // not 100%
    expect(html).toContain("13%"); // not 100%
  });

  it("sizes each bar from reachedPct and nothing else", () => {
    const html = render({ funnel: straightFunnel() });
    expect(html).toContain("width:100%");
    expect(html).toContain("width:60%");
    expect(html).toContain("width:20%");
  });

  // MUTATION: let a zero-view step render a zero-width bar. The row then looks like
  // a rendering fault rather than like the answer.
  it("keeps a hairline on a step nobody reached", () => {
    const html = render({ funnel: funnelFrom([[0, "a"], [0, "b"]], { stepCount: 2 }) });
    expect(html).not.toContain("width:0%");
    expect(html).toContain("width:0.6%");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The states either end of the data.
 * ------------------------------------------------------------------------- */

describe("an empty funnel says nobody has been here, not that everybody left", () => {
  // MUTATION: render an empty chart frame, or "0% completion". The route answers
  // 503 when the migration is missing, so reaching here really does mean "no rows".
  it("renders one honest sentence and no chart", () => {
    const html = render({ funnel: aggregateStepEvents([]) });
    expect(html).toContain("No one has reached a step of this funnel yet.");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("0%");
  });
});

describe("a truncated scan says so", () => {
  // MUTATION: drop the flag. A partial tally rendered as a whole one is a wrong
  // number presented with full confidence, which is worse than no number.
  it("notes it only when the scan hit its ceiling", () => {
    const funnel = straightFunnel();
    expect(render({ funnel, truncated: true })).toContain("most recent events only");
    expect(render({ funnel })).not.toContain("most recent events only");
    expect(render({ funnel, truncated: false })).not.toContain("most recent events only");
  });
});

/* ---------------------------------------------------------------------------
 * 4. It is a picture, and it stays one.
 * ------------------------------------------------------------------------- */

describe("the chart is presentational, structurally", () => {
  // MUTATION: mark it "use client" for a hover tooltip. It takes plain data so a
  // server component can render it directly; a directive here would drag the whole
  // subtree across the client boundary (and a props-with-functions version of this
  // component would then fail at render, not at build).
  it("declares no client boundary and holds no state", () => {
    expect(CODE).not.toContain("use client");
    for (const banned of ["useState", "useEffect", "useMemo", "fetch(", "onClick", "onChange"]) {
      expect(CODE, `found ${banned}`).not.toContain(banned);
    }
  });

  // MUTATION: accept `label: (i) => string`. A function prop is what makes a shared
  // primitive un-renderable from a server component — the failure shows up at
  // render time on a live page, not in the build.
  it("takes plain data, with no function props", () => {
    expect(CODE).not.toMatch(/\w+\??:\s*\([^)]*\)\s*=>/);
  });

  it("renders nothing focusable and no controls", () => {
    const html = render({ funnel: straightFunnel(), truncated: true });
    for (const tag of ["<button", "<input", "<a ", "<select", "<textarea", "tabindex"]) {
      expect(html, `found ${tag}`).not.toContain(tag);
    }
  });

  // MUTATION: reach for a hex "just for the bar". This can sit inside a paletteVars
  // wrapper like the phone strip does, and a literal would be the one element that
  // ignored the colour scheme.
  it("names every colour by token", () => {
    const found = [...CODE.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(
      found,
      `dropoff-chart.tsx hardcodes ${found.join(", ")}; name the colour in globals.css and use the token`,
    ).toEqual([]);
    const html = render({ funnel: straightFunnel() });
    for (const cls of ["bg-card", "border-line", "text-navy", "text-ink", "text-muted", "bg-blue-dark", "bg-card-muted"]) {
      expect(html, `lost ${cls}`).toContain(cls);
    }
  });

  // MUTATION: import the repository, or the route's types, "for convenience". This
  // is a component in the authed panel today and could be reused in a preview
  // tomorrow; the pure lib is the only dependency it needs.
  it("imports the pure lib and nothing server-only", () => {
    const imports = [...SOURCE.matchAll(/^\s*import\b[\s\S]*?from\s+["']([^"']+)["']/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["@/lib/smile-assessment/step-events", "@/lib/utils"]);
  });

  // MUTATION: fetch here, or take an onRetry callback. The moment this file holds
  // state or a function prop it becomes a client boundary, and a server component
  // can no longer render it — which is the whole reason the fetching, the
  // disclosure and every error state live in dropoff-section.tsx instead.
  it("is mounted by the section that owns the fetch, and stays a picture itself", () => {
    const section = readFileSync(join(HERE, "dropoff-section.tsx"), "utf8");
    expect(section).toContain("DropoffChart");
    expect(section).toContain("drop-off");
    // The chart itself: no fetching, no state, no client directive.
    expect(CODE).not.toContain("use client");
    expect(CODE).not.toContain("fetch(");
    expect(CODE).not.toContain("useState");
  });
});
