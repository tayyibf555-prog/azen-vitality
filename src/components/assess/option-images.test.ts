import { describe, it, expect } from "vitest";
import {
  OPTION_IMAGES,
  OPTION_IMAGE_ALT,
  OPTION_IMAGE_WIDTH,
  OPTION_IMAGE_HEIGHT,
  QUESTION_HERO_IMAGES,
  optionImageKey,
  imageFor,
  imageAltFor,
  heroFor,
} from "./option-images";
import { QUIZ_QUESTIONS, questionById } from "@/lib/smile-assessment/quiz";

// The map is keyed by questionId + option value on purpose. These tests pin that
// down, prove the `unsure` collision it exists to solve, and check every mapped
// entry against the real quiz bank so a renamed option value can never leave a
// silently orphaned picture behind.

describe("optionImageKey", () => {
  it("composes questionId and value, never the value alone", () => {
    expect(optionImageKey("smile_concern", "crowded")).toBe("smile_concern:crowded");
    expect(optionImageKey("align_detail", "crowded")).toBe("align_detail:crowded");
    expect(optionImageKey("smile_concern", "crowded")).not.toBe("crowded");
  });

  it("gives different questions different keys for the same value", () => {
    expect(optionImageKey("budget_readiness", "unsure")).not.toBe(optionImageKey("align_detail", "unsure"));
  });
});

describe("imageFor", () => {
  it("returns the mapped render for each smile_concern condition option", () => {
    expect(imageFor("smile_concern", "crowded")).toBe("/assess/conditions/crowded.webp");
    expect(imageFor("smile_concern", "gaps")).toBe("/assess/conditions/gaps.webp");
    expect(imageFor("smile_concern", "open_bite")).toBe("/assess/conditions/open-bite.webp");
    expect(imageFor("smile_concern", "overbite")).toBe("/assess/conditions/overbite.webp");
    expect(imageFor("smile_concern", "underbite")).toBe("/assess/conditions/underbite.webp");
    expect(imageFor("smile_concern", "crossbite")).toBe("/assess/conditions/crossbite.webp");
    expect(imageFor("smile_concern", "even")).toBe("/assess/conditions/even-bite.webp");
  });

  it("returns null for an unknown question, an unknown value, and empty strings", () => {
    expect(imageFor("not_a_question", "crowded")).toBeNull();
    expect(imageFor("smile_concern", "not_an_option")).toBeNull();
    expect(imageFor("", "")).toBeNull();
  });

  it("returns null for options that have no artwork, so they keep their icon", () => {
    // Graceful degradation is the normal path: nearly every option is icon-only.
    expect(imageFor("smile_concern", "unsure")).toBeNull();
    expect(imageFor("treatment_interest", "invisalign")).toBeNull();
    expect(imageFor("timeline", "asap")).toBeNull();
    expect(imageFor("location", "england")).toBeNull();
  });

  it("never resolves a bare value the way the flat icon map would", () => {
    // "crowded" is only meaningful under smile_concern. Asking for it under any
    // other question id must not hand back smile_concern's picture.
    expect(imageFor("align_detail", "crowded")).toBeNull();
    expect(imageFor("cosmetic_goal", "gaps")).toBeNull();
  });
});

describe("the `unsure` collision the keying exists to prevent", () => {
  const unsureQuestions = QUIZ_QUESTIONS.filter((q) => q.options.some((o) => o.value === "unsure")).map(
    (q) => q.id,
  );

  it("is a real collision: several distinct questions share the value", () => {
    expect(unsureQuestions).toEqual(
      expect.arrayContaining(["budget_readiness", "implant_scope", "align_detail", "smile_concern"]),
    );
    expect(unsureQuestions.length).toBeGreaterThanOrEqual(4);
  });

  it("resolves independently per question, so one mapping can never leak to another", () => {
    // None of them is mapped today, which is exactly the point: a flat value-keyed
    // map could only ever give all four the same answer.
    for (const id of unsureQuestions) expect(imageFor(id, "unsure")).toBeNull();

    // Prove the mechanism rather than today's data: a value mapped under one
    // question stays invisible to every other question that shares that value.
    const mappedUnderOne = imageFor("smile_concern", "crowded");
    expect(mappedUnderOne).not.toBeNull();
    for (const id of unsureQuestions.filter((q) => q !== "smile_concern")) {
      expect(imageFor(id, "crowded")).toBeNull();
    }
  });
});

describe("imageAltFor", () => {
  it("describes what the render shows, in the site's 3D model wording", () => {
    expect(imageAltFor("smile_concern", "crowded")).toBe("Crowded teeth 3D model");
    expect(imageAltFor("smile_concern", "crossbite")).toBe("Crossbite 3D model");
    expect(imageAltFor("smile_concern", "even")).toBe("Even bite 3D model");
  });

  it("returns null wherever there is no render", () => {
    expect(imageAltFor("smile_concern", "unsure")).toBeNull();
    expect(imageAltFor("timeline", "asap")).toBeNull();
  });

  it("covers exactly the mapped options, so no picture ships without alt text", () => {
    expect(Object.keys(OPTION_IMAGE_ALT).sort()).toEqual(Object.keys(OPTION_IMAGES).sort());
    for (const alt of Object.values(OPTION_IMAGE_ALT)) expect(alt.trim().length).toBeGreaterThan(0);
  });
});

describe("the map's shape and contents", () => {
  it("keys every entry as questionId:value against a real bank question + option", () => {
    for (const key of Object.keys(OPTION_IMAGES)) {
      const parts = key.split(":");
      expect(parts, `key "${key}" must be exactly questionId:value`).toHaveLength(2);
      const [questionId, value] = parts as [string, string];
      const question = questionById(questionId);
      expect(question, `key "${key}" references an unknown question`).toBeDefined();
      expect(
        question!.options.some((o) => o.value === value),
        `key "${key}" references an option "${value}" that ${questionId} does not have`,
      ).toBe(true);
    }
  });

  it("points every entry at a plausible, area-owned public path", () => {
    const seen = new Set<string>();
    for (const [key, path] of Object.entries(OPTION_IMAGES)) {
      expect(path.startsWith("/assess/conditions/"), `${key} must live under the assess asset folder`).toBe(true);
      expect(path.endsWith(".webp"), `${key} must be the optimised webp derivative`).toBe(true);
      expect(path).not.toContain(" ");
      expect(path).not.toContain("//");
      // Never reach across into another area's asset tree.
      expect(path).not.toContain("/landing/");
      expect(seen.has(path), `${path} is mapped twice`).toBe(false);
      seen.add(path);
    }
  });

  it("declares a 4:3 intrinsic size for the tiles to reserve", () => {
    expect(OPTION_IMAGE_WIDTH).toBe(360);
    expect(OPTION_IMAGE_HEIGHT).toBe(270);
    expect(OPTION_IMAGE_WIDTH / OPTION_IMAGE_HEIGHT).toBeCloseTo(4 / 3, 5);
  });
});

describe("heroFor", () => {
  it("ships no hero artwork yet, so the seam is inert", () => {
    expect(Object.keys(QUESTION_HERO_IMAGES)).toHaveLength(0);
    expect(heroFor("smile_concern")).toBeNull();
    expect(heroFor("treatment_interest")).toBeNull();
    expect(heroFor("")).toBeNull();
  });
});
