// ONE ADJECTIVE, FIVE SITES, AND THE IMPORT THAT MUST NOT WIDEN.
//
// `period === "week" ? "weekly" : "monthly"` was written out four times: once in the
// prompt the model is given, once in the Reports page's "could not be read" copy,
// and twice in the workspace. A FIFTH copy was found afterwards, in the generate
// route's own "not enough activity yet" message -- which is the whole argument for
// this file, because that is the sentence an owner reads on the day the report does
// not arrive, and the consolidation that was supposed to end the duplication had
// walked straight past it. Each copy is a chance for the page and the review printed
// on it to call the same window different things, and the version that matters is
// the one nobody sees in review -- the prompt's -- because its wording ends up inside
// sentences the owner reads as fact.
//
// The second half of this file is the part that is easy to lose. Two of the sites
// live in a "use client" component, and the obvious home for the shared word --
// reports/ai.ts, beside the prompt that needs it -- reaches the Supabase SERVICE
// client through snapshot.ts -> speed-to-lead/repository.ts. Nothing in that chain
// carries `server-only`, so importing the word from there would not fail the build;
// it would quietly ship the enquiry repository to the browser. The word therefore
// lives in a module that imports nothing at runtime, ai.ts does NOT re-export it (a
// re-export puts that hazardous path back in autocomplete beside the safe one), and
// no client component may reach either module for a value. All three are pinned
// below rather than trusted.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { srcPath, walkSrc } from "@/lib/test-support/walk-src";
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
  // THE FIFTH, and the one the first consolidation missed. A server route has no
  // client-bundle hazard, which is exactly why nobody thought to check it -- and it
  // is where the "there is not enough live activity yet to write a reliable weekly
  // review" sentence is composed, so a drift here is a drift in the message an owner
  // gets INSTEAD of their report.
  ["the generate route's awaiting copy", "app/api/reports/generate/route.ts"],
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

  // MUTATION: re-add `export { periodWord }` to ai.ts "so a server-side reader finds
  // it beside the prompt". It had no non-test caller and it is not a convenience: it
  // is the one import path for this word whose chain constructs the Supabase SERVICE
  // client, offered in autocomplete beside the safe one, in a repo where two of the
  // call sites are "use client" files. The word is one import away either way.
  it("is NOT re-exported from ai.ts: that path drags the service client behind it", async () => {
    const ai = await import("./ai");
    expect(Object.keys(ai), "ai.ts re-exports periodWord again").not.toContain("periodWord");
    const source = readFileSync(srcPath("lib/reports/ai.ts"), "utf8");
    expect(source).not.toMatch(/export\s*\{[^}]*\bperiodWord\b[^}]*\}/);
    expect(source).not.toMatch(/export\s+\*\s+from\s+["'][^"']*period-word["']/);
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

  // The client component that holds two of the five sites must not have grown an
  // import of ai.ts (or of snapshot.ts as a value) while nobody was looking. This one
  // names the file; the sweep in the next describe says the same thing about all of
  // them, which is what stops the rule being true only where someone remembered it.
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
// AND THE SAME RULE FOR EVERY CLIENT COMPONENT, NOT JUST THE ONE WE THOUGHT OF.
//
// The pin above names reports-workspace.tsx because that is the file that holds the
// word. But the hazard is not about the word at all: ai.ts and snapshot.ts BOTH
// reach the Supabase service client through speed-to-lead/repository.ts, and nothing
// in the chain carries `server-only`, so any "use client" file that imports either
// one for a VALUE ships it to the browser. A single-file pin only holds where
// somebody remembered to write it, and the one place it was written is the one place
// the mistake had already been avoided.
//
// A type-only import is fine and is the shape the workspace already uses: it is
// erased before the bundler ever sees it.
// ---------------------------------------------------------------------------

/**
 * Every "use client" module under src/components, as a path under src/.
 *
 * Dot-directories are left out (the walker's default) on purpose: src/components is
 * not a routed tree, so a dot-folder here would be a stray copy rather than a
 * reachable module. Tests are left out too — a test importing the prompt builder is
 * a server-side read, not a bundle.
 */
const CLIENT_COMPONENTS = walkSrc({ subdir: "components" }).filter((file) =>
  /^\s*["']use client["']/.test(readFileSync(srcPath(file), "utf8")),
);

/**
 * The modules a file imports for their VALUES.
 *
 * `import type { X } from "y"` is erased by the compiler and cannot widen a bundle,
 * so it is not an offence. An inline `{ type X }` is counted as a value import here:
 * that is stricter than the compiler, and the strictness is the point — the safe
 * spelling is one word away and it is the one the workspace already uses.
 */
function valueImports(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']/gm)]
    .filter((m) => !m[1])
    .map((m) => m[3]);
}

/** ai.ts and snapshot.ts, however the specifier is spelled. */
const SERVICE_CLIENT_CHAIN = /(^|\/)reports\/(ai|snapshot)$/;

describe("no client component reaches the prompt builder or the snapshot for a value", () => {
  // MUTATION: add `import { buildReportPrompt } from "@/lib/reports/ai"` to any
  // "use client" file — to reuse one formatting helper, or because autocomplete
  // offered it. It type-checks, it builds, it renders, and the Supabase service
  // client is now in the browser bundle. This is what notices.
  it("not one of them imports lib/reports/ai or lib/reports/snapshot", () => {
    const offenders = CLIENT_COMPONENTS.flatMap((file) =>
      valueImports(readFileSync(srcPath(file), "utf8"))
        .filter((spec) => SERVICE_CLIENT_CHAIN.test(spec))
        .map((spec) => `${file} imports ${spec} for its values`),
    );
    expect(
      offenders,
      "both modules reach the Supabase SERVICE client through " +
        "speed-to-lead/repository.ts, and no file in that chain carries `server-only` " +
        "to stop it. Import the type only, or move the value you need into a module " +
        "that imports nothing at runtime (see period-word.ts).",
    ).toEqual([]);
  });

  // MUTATION: break the walk or the directive test and the sweep above passes by
  // examining nothing at all. A toEqual([]) reads identically either way.
  it("actually has a list of client components to sweep", () => {
    expect(CLIENT_COMPONENTS.length).toBeGreaterThan(100);
    expect(CLIENT_COMPONENTS).toContain("components/client/reports/reports-workspace.tsx");
    // The server component that legitimately DOES import snapshot.ts for its values:
    // if this ever appears in the list, the directive test has stopped working.
    expect(CLIENT_COMPONENTS).not.toContain("components/client/reports/reports-view.tsx");
  });

  it("reads value imports and type imports differently, or the sweep means nothing", () => {
    const workspace = readFileSync(
      srcPath("components/client/reports/reports-workspace.tsx"),
      "utf8",
    );
    expect(valueImports(workspace)).toContain("@/lib/reports/period-word");
    expect(valueImports(workspace), "an `import type` line is erased, not an offence").not.toContain(
      "@/lib/reports/snapshot",
    );
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
