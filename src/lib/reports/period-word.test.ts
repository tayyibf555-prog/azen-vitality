// ONE ADJECTIVE, FOUR SCREENS, AND THE IMPORT THAT MUST NOT WIDEN.
//
// `period === "week" ? "weekly" : "monthly"` was written out four times: once in the
// prompt the model is given, once in the Reports page's "could not be read" copy,
// and twice in the workspace. Four copies of one word is four chances for the page
// and the review printed on it to call the same window different things, and the
// version that matters is the one nobody sees in review -- the prompt's -- because
// its wording ends up inside the sentences the owner reads as fact.
//
// The second half of this file is the part that is easy to lose. Two of the four
// sites live in a "use client" component, and the obvious home for the shared word
// -- reports/ai.ts, beside the prompt that needs it -- reaches the Supabase SERVICE
// client through snapshot.ts -> speed-to-lead/repository.ts. Nothing in that chain
// carries `server-only`, so importing the word from there would not fail the build;
// it would quietly ship the enquiry repository to the browser. The word therefore
// lives in a module that imports nothing at runtime, and that emptiness is pinned
// below rather than trusted.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { srcPath } from "@/lib/test-support/walk-src";
import { periodWord } from "./period-word";
import type { ReportPeriod, ReportSnapshot } from "./snapshot";
import { ReportsWorkspace } from "@/components/client/reports/reports-workspace";

const PERIOD_WORD_SOURCE = readFileSync(srcPath("lib/reports/period-word.ts"), "utf8");

/**
 * Every place the adjective is printed, as a path under src/.
 *
 * The prompt is listed with the screens on purpose: the model is told "weekly
 * business review" in the same words the page prints, and a drift between them is
 * a review that describes a different window from the figures beside it.
 */
const CALL_SITES = [
  ["the AI prompt", "lib/reports/ai.ts"],
  ["the Reports page's unavailable copy", "components/client/reports/reports-view.tsx"],
  ["the review workspace", "components/client/reports/reports-workspace.tsx"],
] as const;

/** The hand-rolled ternary, in any of the spacings it was written in. */
const INLINE_TERNARY = /===\s*"week"\s*\?\s*"weekly"\s*:\s*"monthly"/;

describe("the adjective itself", () => {
  it("is the same two words it always was", () => {
    expect(periodWord("week")).toBe("weekly");
    expect(periodWord("month")).toBe("monthly");
  });

  it("answers for every period the union holds", () => {
    const ALL: ReportPeriod[] = ["week", "month"];
    for (const period of ALL) expect(typeof periodWord(period)).toBe("string");
  });
});

describe("nothing spells it out for itself any more", () => {
  // MUTATION: inline the ternary back at any one site "because it is shorter than
  // an import". Four copies is where this started, and the copy that drifts is not
  // noticed on a screenshot -- it is noticed in a sentence the model wrote.
  it.each(CALL_SITES)("%s calls periodWord and holds no ternary of its own", (_name, file) => {
    const source = readFileSync(srcPath(file), "utf8");
    expect(source, `${file} does not call periodWord`).toContain("periodWord(");
    expect(source, `${file} has spelled the adjective out again`).not.toMatch(INLINE_TERNARY);
  });

  // The brief's own instruction, kept literally: a server-side reader looking for
  // the word beside the prompt that uses it finds it exported from ai.ts.
  it("is still exported from ai.ts, for callers already on the server", async () => {
    const ai = await import("./ai");
    expect(ai.periodWord("week")).toBe("weekly");
    expect(ai.periodWord("month")).toBe("monthly");
  });
});

describe("and the module holding it can be pulled into the browser", () => {
  // MUTATION: move periodWord into ai.ts and import it from there. That import runs
  // snapshot.ts, which runs speed-to-lead/repository.ts, which constructs the
  // Supabase SERVICE client -- in a "use client" component, with no `server-only`
  // anywhere in the chain to make it fail loudly.
  it("imports nothing at runtime, so no caller's graph can widen through it", () => {
    const runtimeImports = [
      ...PERIOD_WORD_SOURCE.matchAll(/^\s*import\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    expect(runtimeImports, "a runtime import here reaches every client caller").toEqual([]);
  });

  it("names nothing server-only", () => {
    // Comments stripped: the header EXPLAINS the service-client hazard at length,
    // and a raw includes would read the explanation as the offence.
    const code = PERIOD_WORD_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["serviceClient", "server-only", "repository", "process.env"]) {
      expect(code, `found ${banned}`).not.toContain(banned);
    }
  });

  // The client component that holds two of the four sites must not have grown an
  // import of ai.ts (or of snapshot.ts as a value) while nobody was looking.
  it("the client workspace imports only the word, and only types from snapshot", () => {
    const source = readFileSync(
      srcPath("components/client/reports/reports-workspace.tsx"),
      "utf8",
    );
    expect(source).toContain('import { periodWord } from "@/lib/reports/period-word"');
    expect(source, "the client bundle must not reach the prompt builder").not.toContain(
      "@/lib/reports/ai",
    );
    expect(source, "snapshot may only be imported for its TYPES here").toMatch(
      /import\s+type\s*\{[^}]*\}\s*from\s*"@\/lib\/reports\/snapshot"/,
    );
    expect(source).not.toMatch(/import\s*\{[^}]*\}\s*from\s*"@\/lib\/reports\/snapshot"/);
  });
});

// ---------------------------------------------------------------------------
// The words as the owner actually reads them. A structural pin proves the call
// was made; this proves the sentence did not change.
// ---------------------------------------------------------------------------

function snapshot(period: ReportPeriod): ReportSnapshot {
  return {
    period,
    windowLabel: period === "week" ? "last 7 days" : "last 30 days",
    enquiries: 12,
    contacted: 10,
    booked: 4,
    enquiryToBookedRate: 0.33,
    avgFirstResponseSeconds: 42,
    topSource: { source: "smile-assessment", count: 7 },
    hasEnoughData: true,
    readFailed: false,
    truncated: false,
    countsExact: true,
  };
}

function renderWorkspace(defaultPeriod: ReportPeriod): string {
  return renderToStaticMarkup(
    createElement(ReportsWorkspace, {
      clientSlug: "vitality",
      snapshots: { week: snapshot("week"), month: snapshot("month") },
      defaultPeriod,
    }),
  );
}

describe("the sentences on the screen are unchanged", () => {
  // The two sentences that render WITHOUT a generated report: the waiting prompt
  // here, and (once a report exists) the panel heading and the "Writing your ..."
  // line, which need a live API response and are pinned structurally above.
  it("says 'weekly' throughout the week tab", () => {
    const html = renderWorkspace("week");
    expect(html).toContain(
      "Generate a report to get a written weekly review with highlights and recommendations.",
    );
    expect(html, "the week tab must not describe itself as a month").not.toContain("monthly");
  });

  it("says 'monthly' throughout the month tab", () => {
    const html = renderWorkspace("month");
    expect(html).toContain(
      "Generate a report to get a written monthly review with highlights and recommendations.",
    );
    expect(html, "the month tab must not describe itself as a week").not.toContain("weekly");
  });
});
