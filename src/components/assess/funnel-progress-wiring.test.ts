import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { srcPath, walkSrc } from "@/lib/test-support/walk-src";
import { FLOW_SCHEMA_VERSION, type FlowGraph } from "@/lib/smile-assessment/flow";
import { toPublicFlow } from "@/lib/smile-assessment/campaign";
import { createFunnelProgressReporter } from "@/lib/smile-assessment/funnel-progress-beacon";
import { DeterministicAssessmentQuiz } from "./deterministic-assessment-quiz";

// LEAD FUNNEL PROGRESS, INSIDE THE QUIZ. The sibling of step-beacon-wiring.test.ts,
// with the same honest limit stated there: vitest runs environment:"node", a static
// render runs NO effects, so the structural claims are read out of the source as
// text and the RULES they depend on are tested for real in funnel-progress.test.ts.
//
// WHAT THIS FILE IS ACTUALLY FOR. The dangerous mistakes here are not rendering
// bugs, they are wiring ones, and each has a named test below:
//   - reporting progress BEFORE the contact step, which would attach a screen to a
//     person who has not given their details;
//   - reusing the anonymous step beacon's nonce, which would make
//     assessment_step_event joinable to a named lead;
//   - reporting from PREVIEW, which would move a real lead's position because an
//     owner clicked through their own funnel;
//   - reporting on the ADAPTIVE fallback, whose screens have no ordinal.

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "deterministic-assessment-quiz.tsx"), "utf8");

/** Any `from "...funnel-progress-beacon"` import, whatever the path prefix. */
const IMPORT_RE = /from\s+["'][^"']*funnel-progress-beacon["']/;

/** Source with comments stripped: what the file DOES, not what it explains. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const GRAPH: FlowGraph = {
  schemaVersion: FLOW_SCHEMA_VERSION,
  entry: "w",
  nodes: [
    { kind: "welcome", id: "w", headline: "Straighter teeth", intro: "Two minutes." },
    { kind: "question", id: "q1", questionId: "treatment_interest" },
    { kind: "contact", id: "c" },
    { kind: "outcome", id: "hot", band: "high", headline: "A great fit" },
    { kind: "outcome", id: "mid", band: "medium", headline: "Worth a look" },
    { kind: "outcome", id: "cold", band: "low", headline: "Worth a chat" },
  ],
  edges: [
    { from: "w", to: "q1", answer: null },
    { from: "q1", to: "c", answer: null },
    { from: "c", to: "hot", answer: "high" },
    { from: "c", to: "mid", answer: "medium" },
    { from: "c", to: "cold", answer: "low" },
  ],
};

function render(props: { previewMode?: boolean; flowVersion?: number } = {}): string {
  const flow = toPublicFlow(GRAPH);
  if (!flow) throw new Error("fixture graph names a question that is not in the bank");
  return renderToStaticMarkup(
    createElement(DeterministicAssessmentQuiz, {
      clientSlug: "vitality",
      campaignSlug: "spring-implants",
      practiceName: "Vitality Dental",
      flow,
      ...props,
    }),
  );
}

// THE WALK IS THE SHARED ONE (src/lib/test-support/walk-src.ts), and that is not
// tidiness. This file used to hand-roll its own: rooted at
// `resolve(process.cwd(), "src")` — the RUNNER'S directory, which in a worktree is
// a different checkout of this repo, so the sweep could report "exactly one
// caller" about source nobody had edited — and descending EVERY directory,
// dot-directories and node_modules included. That second half made this file FLAKY
// in a parallel run: walk-src.test.ts builds a real, temporary
// `.walk-fixture-XXXX/` under src/lib/test-support to prove `includeDotDirs`
// works, and a walk that descends dot-directories reads files that are being
// deleted underneath it (ENOENT on .walk-fixture-XXXX/node_modules/route.ts,
// reproduced 1 run in 11). `walkSrc` skips dot-directories by default, so the
// fixture is invisible to it and the race is gone.
describe("the reporter has exactly one caller", () => {
  function importers(): string[] {
    return walkSrc({ includeTests: true }).filter((file) => {
      if (/funnel-progress-beacon(\.test)?\.ts$/.test(file)) return false;
      if (file.endsWith("funnel-progress-wiring.test.ts")) return false;
      return IMPORT_RE.test(readFileSync(srcPath(file), "utf8"));
    });
  }

  // MUTATION: wire it into the ADAPTIVE quiz, the Guided style or a landing page
  // "for parity". Those runtimes have no authored graph, so their screens have no
  // ordinal — they would move a real lead's position to a number that describes
  // nothing.
  it("is imported by the deterministic quiz and by nothing else", () => {
    expect(
      importers(),
      "funnel-progress-beacon has a new importer: only the deterministic runtime has a numbering to report against",
    ).toEqual(["components/assess/deterministic-assessment-quiz.tsx"]);
  });
});

describe("progress can only be reported after the person gave their details", () => {
  // MUTATION: create the reporter at mount, next to the step beacon. Every visitor
  // would then be reporting screens — but there is no lead until the contact step is
  // submitted, so this is the line between "anonymous visitor" and "named person".
  it("the reporter is created only in the submit handler, from the server's token", () => {
    const created = [...CODE.matchAll(/createFunnelProgressReporter\(/g)];
    expect(created).toHaveLength(1);
    expect(CODE).toContain("data.funnelToken");
    // ...and the token is the server's, never anything the component made up.
    expect(CODE).not.toMatch(/createFunnelProgressReporter\(\{\s*token:\s*(nonce|crypto)/);
  });

  // MUTATION: pass the step beacon's nonce as the token. That single change would
  // make every anonymous row in assessment_step_event joinable to a named lead with
  // a phone number on it — retroactively, for every session already stored.
  it("NEVER REUSES THE ANONYMOUS BEACON'S NONCE", () => {
    expect(CODE).not.toMatch(/createFunnelProgressReporter\([^)]*beacon/);
    expect(CODE).not.toMatch(/token:\s*[^,)]*nonce/);
  });

  // MUTATION: drop `!previewMode`. An owner clicking through the builder's live
  // preview would then move a real patient's lead — the same class of mistake the
  // inert step beacon and the inert funnel tracker already guard against.
  it("reports nothing from the internal live preview", () => {
    expect(CODE).toMatch(/createFunnelProgressReporter\(/);
    const guard = CODE.slice(0, CODE.indexOf("createFunnelProgressReporter("));
    expect(guard.slice(-400)).toContain("!previewMode");
  });

  // MUTATION: send flowVersion unconditionally. A session that degraded to the
  // adaptive funnel is no longer walking the drawn one, so its position would be a
  // fraction of a funnel it stopped following.
  it("tells the server which funnel version it walked only while it is still walking it", () => {
    expect(CODE).toMatch(/mode === "flow" && typeof flowVersion === "number" \? \{ flowVersion \}/);
  });

  // MUTATION: call `beacon.view(...)` on one screen and forget `record(...)`. One
  // call site for both records is what stops a screen being counted in the chart
  // and forgotten on the lead.
  it("records every screen through one call site, shared with the anonymous beacon", () => {
    expect(CODE).toContain("progressRef.current?.report(ordinal)");
    expect(CODE).toMatch(/record\(numbering\.outcomeStep\)/);
    expect(CODE).toMatch(/record\(numbering\.contactStep\)/);
  });
});

describe("the reporter itself", () => {
  it("is inert on the server, so a static render can never post", () => {
    // typeof window is undefined under vitest's node environment: this is the real
    // guard running, not a mock of it.
    const reporter = createFunnelProgressReporter({ token: "abcd1234-ef", flowVersion: 3 });
    expect(() => reporter.report(4)).not.toThrow();
  });

  it("is inert without a token or with a version that is not a version", () => {
    expect(() => createFunnelProgressReporter({ token: "", flowVersion: 3 }).report(1)).not.toThrow();
    expect(() =>
      createFunnelProgressReporter({ token: "abcd1234-ef", flowVersion: -1 }).report(1),
    ).not.toThrow();
  });
});

describe("the quiz still mounts and still looks the same", () => {
  it("renders the funnel's first screen", () => {
    const html = render({ flowVersion: 7 });
    expect(html).toContain("Straighter teeth");
    expect(html).toContain("Vitality Dental");
  });

  it("renders identically in preview, where nothing is reported", () => {
    expect(render({ flowVersion: 7, previewMode: true })).toContain("Straighter teeth");
  });
});
