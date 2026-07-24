import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GuidedAssessmentQuiz } from "./guided-assessment-quiz";
import { imageFor, imageAltFor, OPTION_IMAGES } from "./option-images";
import { iconFor, OPTION_ICONS } from "./option-icons";
import { questionById } from "@/lib/smile-assessment/quiz";

// Covers the Guided quiz's picture tiles from the outside in.
//
// GuidedAssessmentQuiz is a "use client" component driven by useState/useEffect,
// so a static render only ever reaches phase "intro" — the question screen is
// unreachable without a DOM, and this suite is environment:"node" with no jsdom.
// So the render here is a mount smoke test only (it proves the new import does not
// break the module graph or the first paint), and the picture wiring is verified
// through the pure map + the component's own source, the same way the jargon guard
// reads this file as text.

const SOURCE_PATH = "src/components/assess/guided-assessment-quiz.tsx";
const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), "utf8");

describe("GuidedAssessmentQuiz still mounts with the picture tiles wired in", () => {
  it("static-renders its intro screen", () => {
    const html = renderToStaticMarkup(
      createElement(GuidedAssessmentQuiz, {
        clientSlug: "vitality",
        practiceName: "Vitality Dental",
        // previewMode keeps the no-op tracker, so nothing reaches for the browser.
        previewMode: true,
      }),
    );
    expect(html).toContain("Guided Smile Assessment");
    expect(html).toContain("Start my assessment");
  });
});

describe("the smile_concern bank question and the image map agree", () => {
  const question = questionById("smile_concern");

  it("exists on the aligners path with the eight expected option values", () => {
    expect(question).toBeDefined();
    expect(question!.appliesTo).toEqual(["invisalign"]);
    expect(question!.options.map((o) => o.value)).toEqual([
      "crowded",
      "gaps",
      "open_bite",
      "overbite",
      "underbite",
      "crossbite",
      "even",
      "unsure",
    ]);
  });

  it("gives every condition option a picture, and only `unsure` degrades to its icon", () => {
    const withArt: string[] = [];
    const withoutArt: string[] = [];
    for (const o of question!.options) {
      (imageFor("smile_concern", o.value) ? withArt : withoutArt).push(o.value);
    }
    expect(withArt).toEqual(["crowded", "gaps", "open_bite", "overbite", "underbite", "crossbite", "even"]);
    expect(withoutArt).toEqual(["unsure"]);
  });

  it("accounts for every mapped key, so no picture is orphaned", () => {
    const mappedForQuestion = Object.keys(OPTION_IMAGES).filter((k) => k.startsWith("smile_concern:"));
    expect(mappedForQuestion).toHaveLength(Object.keys(OPTION_IMAGES).length);
    for (const o of question!.options) {
      const src = imageFor("smile_concern", o.value);
      if (src) expect(imageAltFor("smile_concern", o.value)).toBeTruthy();
    }
  });
});

describe("the tile's rendering contract in the component source", () => {
  it("looks the picture up by question id AND option value, never the value alone", () => {
    expect(source).toContain("imageFor(question.id, o.value)");
    expect(source).toContain("imageAltFor(question.id, o.value)");
    expect(source).not.toContain("imageFor(o.value)");
  });

  it("keeps the icon chip as the other branch, so unmapped options are unchanged", () => {
    expect(source).toContain("iconFor(o.value)");
    expect(source).toContain("<Icon size={22} strokeWidth={2} />");
  });

  it("declares the intrinsic size and defers the fetch, so tiles never shift or block", () => {
    expect(source).toContain("width={OPTION_IMAGE_WIDTH}");
    expect(source).toContain("height={OPTION_IMAGE_HEIGHT}");
    expect(source).toContain('loading="lazy"');
    expect(source).toContain('decoding="async"');
    expect(source).toContain("object-cover");
    // The tinted plate the cut-out models sit on.
    expect(source).toContain("bg-[#eef3fb]");
  });

  it("preserves the tile's selected/focus language and the thinking spinner slot", () => {
    expect(source).toContain("aria-pressed={checked}");
    expect(source).toContain("border-blue-royal bg-blue-royal/[0.07]");
    expect(source).toContain("focus-visible:ring-blue-royal/40");
    expect(source).toContain("motion-safe:hover:-translate-y-0.5");
    expect(source).toContain("motion-safe:animate-spin");
  });

  it("wires the hero seam without shipping a hero image", () => {
    expect(source).toContain("heroFor(question.id)");
  });
});

describe("the Classic quiz is untouched by the picture work", () => {
  it("still renders icon tiles only, with no image map import", () => {
    const classic = readFileSync(resolve(process.cwd(), "src/components/assess/assessment-quiz.tsx"), "utf8");
    expect(classic).toContain("iconFor(o.value)");
    expect(classic).not.toContain("option-images");
    expect(classic).not.toContain("imageFor");
  });

  it("gives the picture question's options distinct icons, since Classic serves it too", () => {
    // Classic is icon-only but draws from the same bank, so every smile_concern
    // option needs its own glyph. Without an entry each would hit iconFor's
    // neutral fallback and the question would render as eight identical dots.
    const question = questionById("smile_concern")!;
    const icons = question.options.map((o) => iconFor(o.value));
    expect(new Set(icons).size).toBe(question.options.length);
    for (const o of question.options) {
      expect(OPTION_ICONS[o.value], `${o.value} has no icon of its own`).toBeDefined();
    }
  });
});
