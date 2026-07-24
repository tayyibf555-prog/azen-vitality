// Owner feedback on the GUIDED smile assessment's chrome, locked down.
//
// Three presentational asks, none of which touch the question bank, the scoring,
// the funnel or the submit flow:
//   1. the header logo must read WHITE on the navy gradient,
//   2. the "Guided Smile Assessment" wordmark and the matching intro pill are gone,
//      leaving the header as logo + practice name only,
//   3. the "STEP 4" badge becomes a quiet "4 of 6" counter, whose ceiling is read
//      from MAX_QUESTIONS rather than typed in.
//
// GuidedAssessmentQuiz is a "use client" component driven by useState/useEffect and
// this suite is environment:"node" with no jsdom, so a static render only ever
// reaches phase "intro". The intro screen is therefore verified by rendering; the
// question screen's counter is verified through the pure label helper it calls plus
// the component's own source read as text, the same technique the sibling image
// suite and the jargon guard already use.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GuidedAssessmentQuiz, stepCounterLabel } from "./guided-assessment-quiz";
import { iconFor, OPTION_ICONS } from "./option-icons";
import { ToothIcon } from "./tooth-icon";
import { MAX_QUESTIONS } from "@/lib/smile-assessment/funnel";

const SOURCE_PATH = "src/components/assess/guided-assessment-quiz.tsx";
const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), "utf8");

function renderIntro(): string {
  return renderToStaticMarkup(
    createElement(GuidedAssessmentQuiz, {
      clientSlug: "vitality",
      practiceName: "Vitality Dental",
      previewMode: true,
    }),
  );
}

/* ---------------------------------------------------------------------------
 * 1. The header logo reads white
 * ------------------------------------------------------------------------- */

describe("the header logo is tinted white rather than shipped as a second asset", () => {
  const html = renderIntro();

  it("still points at the one existing logo file", () => {
    expect(html).toContain('src="/copilot-logo.png"');
    // No white-variant sibling was smuggled in alongside it.
    expect(source).not.toMatch(/copilot-logo-(white|light|inverted)/);
  });

  it("crushes it to black and inverts it, which renders the mark white on the navy", () => {
    // Both halves are required: brightness-0 alone gives a black mark, invert
    // alone just flips the blue to its complement.
    const logoTag = html.match(/<img[^>]*copilot-logo\.png[^>]*>/)?.[0] ?? "";
    expect(logoTag).toContain("brightness-0");
    expect(logoTag).toContain("invert");
  });

  it("keeps the logo's accessible name tied to the practice", () => {
    expect(html).toContain('alt="Vitality Dental logo"');
  });
});

/* ---------------------------------------------------------------------------
 * 2. The wordmark and the intro pill are gone
 * ------------------------------------------------------------------------- */

describe("the 'Guided Smile Assessment' chrome is removed, not just hidden", () => {
  const html = renderIntro();

  it("renders neither the header wordmark nor the intro pill", () => {
    // Both casings, since the header used title case and the pill sentence case.
    expect(html).not.toMatch(/Guided [Ss]mile [Aa]ssessment/);
  });

  it("leaves no dead copy behind in the source", () => {
    // A string constant left unused would drift back into the UI later; the JSX
    // was deleted outright, so the words survive only in explanatory comments.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(codeOnly).not.toMatch(/Guided [Ss]mile [Aa]ssessment/);
  });

  it("still shows the practice name and the start button, so the header survived", () => {
    expect(html).toContain("Vitality Dental");
    expect(html).toContain("Start my assessment");
  });
});

/* ---------------------------------------------------------------------------
 * 3. "4 of 6" — derived from MAX_QUESTIONS, never typed in
 * ------------------------------------------------------------------------- */

describe("the step counter derives its ceiling from MAX_QUESTIONS", () => {
  it("reads '<n> of <cap>' for every question the funnel can ask", () => {
    for (let step = 1; step <= MAX_QUESTIONS; step++) {
      expect(stepCounterLabel(step)).toBe(`${step} of ${MAX_QUESTIONS}`);
    }
  });

  it("moves with the constant, so raising the cap cannot leave the counter behind", () => {
    // Asserting the RELATIONSHIP rather than the literal: nothing here says "6".
    const cap = Number(stepCounterLabel(1).split(" of ")[1]);
    expect(cap).toBe(MAX_QUESTIONS);
    expect(stepCounterLabel(MAX_QUESTIONS)).toBe(`${MAX_QUESTIONS} of ${MAX_QUESTIONS}`);
  });

  it("clamps rather than showing a patient an impossible '<cap + 1> of <cap>'", () => {
    expect(stepCounterLabel(MAX_QUESTIONS + 1)).toBe(`${MAX_QUESTIONS} of ${MAX_QUESTIONS}`);
    expect(stepCounterLabel(MAX_QUESTIONS + 9)).toBe(`${MAX_QUESTIONS} of ${MAX_QUESTIONS}`);
  });

  it("imports the cap instead of hardcoding it, in the counter AND the progress bar", () => {
    expect(source).toContain('import { MAX_QUESTIONS } from "@/lib/smile-assessment/funnel"');
    // The bar used to divide by a literal 6; if the two ever disagreed the bar
    // would fill at a different rate than the numbers claim.
    expect(source).toContain("step / MAX_QUESTIONS");
    expect(source).not.toMatch(/step \/ \d/);
  });

  it("renders as plain muted text, not the old badge", () => {
    expect(source).toContain("{stepCounterLabel(step)}");
    expect(source).not.toContain("Step {step}");
    // The pill's shape/fill classes went with it.
    expect(source).not.toContain("rounded-full bg-card-muted");
  });
});

/* ---------------------------------------------------------------------------
 * 4. veneers gets a tooth, and nothing else moves
 * ------------------------------------------------------------------------- */

describe("the veneers option is a tooth, not a gem", () => {
  it("maps veneers to the local tooth component", () => {
    expect(iconFor("veneers")).toBe(ToothIcon);
    expect(OPTION_ICONS.veneers).toBe(ToothIcon);
  });

  it("leaves every other mapped value on the icon it already had", () => {
    // A representative sample across the map's sections (treatment, timeline,
    // budget, readiness, scope, the picture question, location) plus the unknown
    // fallback. None of these should have become the tooth.
    const sample = [
      "invisalign",
      "implants",
      "bonding",
      "whitening",
      "hygiene",
      "asap",
      "researching",
      "ready",
      "finance",
      "book_now",
      "one",
      "many",
      "crowded",
      "overbite",
      "even",
      "brighter",
      "england",
      "elsewhere",
      "definitely-not-a-real-option-value",
    ];
    for (const value of sample) {
      expect(iconFor(value), `${value} should not have become the tooth`).not.toBe(ToothIcon);
    }
    // And the map is otherwise whole: exactly one entry is the tooth.
    const toothKeys = Object.keys(OPTION_ICONS).filter((k) => OPTION_ICONS[k] === ToothIcon);
    expect(toothKeys).toEqual(["veneers"]);
  });

  it("draws to lucide's spec so it sits in the same family as its neighbours", () => {
    const svg = renderToStaticMarkup(createElement(ToothIcon, { size: 22, strokeWidth: 2 }));
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('width="22"');
    expect(svg).toContain('height="22"');
    expect(svg).toContain('stroke-width="2"');
    // One closed outline, nothing else.
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toMatch(/d="M[\d.]+ [\d.]+[^"]*Z"/);
  });

  it("honours the call signature the icon map promises", () => {
    // The default path (no props) is what a bare <Icon /> would render, and the
    // className slot is what the tile passes through.
    const bare = renderToStaticMarkup(createElement(ToothIcon, {}));
    expect(bare).toContain('width="24"');
    expect(bare).toContain('stroke-width="2"');
    const classed = renderToStaticMarkup(createElement(ToothIcon, { className: "text-blue-royal" }));
    expect(classed).toContain('class="text-blue-royal"');
  });
});

/* ---------------------------------------------------------------------------
 * 5. Nothing behavioural moved
 * ------------------------------------------------------------------------- */

describe("the accessibility and behaviour contract is untouched by the reskin", () => {
  it("keeps the focus-moving question region, the live region and the motion gating", () => {
    expect(source).toContain("regionRef.current?.focus()");
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("motion-safe:[animation:guidedEnter_240ms_ease-out]");
    expect(source).toContain("aria-pressed={checked}");
    expect(source).toContain("onChoose(o.value)");
  });

  it("leaves the Classic quiz free of any Guided-only import", () => {
    const classic = readFileSync(
      resolve(process.cwd(), "src/components/assess/assessment-quiz.tsx"),
      "utf8",
    );
    // Classic still hosts Guided (it renders it for style="guided") — that one
    // import is expected. What must NOT leak across is the Guided-only chrome.
    expect(classic).toContain('import { GuidedAssessmentQuiz } from "./guided-assessment-quiz"');
    expect(classic).not.toContain("stepCounterLabel");
    expect(classic).not.toContain("tooth-icon");
    // It reaches the tooth the same way it reaches every other glyph.
    expect(classic).toContain('import { iconFor } from "./option-icons"');
  });
});
