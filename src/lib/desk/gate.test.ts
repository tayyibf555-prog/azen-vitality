import { describe, it, expect } from "vitest";
import {
  bothWays,
  firstMatch,
  looksLikeContinuation,
  mentionsVocabulary,
  normaliseForGate,
} from "./gate";

// The SHAPE both desk agents' gates are built from. Each agent's own rules are
// tested against its own battery; this file tests the primitives underneath, and
// in particular the two that would fail silently: a rule that only matches one
// word order, and a vocabulary token that is also a regular expression.

describe("normaliseForGate", () => {
  it("normalises the punctuation people actually type", () => {
    // Curly apostrophes arrive constantly from anything pasted out of Word or
    // typed on a phone, and a rule written with a straight one must not miss them.
    expect(normaliseForGate("Don’t  turn it off")).toBe("don't turn it off");
    expect(normaliseForGate("  MIXED   Case \n")).toBe("mixed case");
  });

  it("keeps sentence terminators, because the rules span within a sentence", () => {
    expect(normaliseForGate("One. Two? Three!")).toBe("one. two? three!");
  });
});

describe("bothWays", () => {
  const rule = bothWays("bypass|disable", "interlock|guard", 30);

  it("matches either word order", () => {
    expect(rule.test("how do i bypass the interlock")).toBe(true);
    expect(rule.test("the interlock - any way to disable it")).toBe(true);
  });

  it("does not span a sentence boundary", () => {
    // `.*` here would fire on two unrelated questions in one message, and a gate
    // that refuses legitimate questions is a gate somebody switches off.
    expect(rule.test("the interlock is fine. can you disable the daily email")).toBe(false);
  });

  it("respects the span, so two distant words are not a match", () => {
    expect(rule.test(`bypass ${"x".repeat(60)} interlock`)).toBe(false);
  });
});

describe("mentionsVocabulary", () => {
  it("matches a practice's own asset name at word boundaries", () => {
    expect(mentionsVocabulary("is the steripro due a service", ["SteriPro 22B", "SteriPro"])).toBe(true);
    expect(mentionsVocabulary("nothing relevant here", ["SteriPro"])).toBe(false);
  });

  it("does NOT match inside a longer word", () => {
    expect(mentionsVocabulary("lisandra rang about it", ["Lisa"])).toBe(false);
  });

  it("survives regex metacharacters in PRACTICE DATA", () => {
    // The vocabulary comes from what somebody typed into the register. "W&H Lisa
    // (+)" compiled naively is a regex with an unmatched group and throws at
    // request time — which would take the whole agent down for that practice.
    expect(() => mentionsVocabulary("anything", ["W&H Lisa (+)", "a[b", "*", "\\"])).not.toThrow();
    expect(mentionsVocabulary("is the w&h lisa (+) ok", ["W&H Lisa (+)"])).toBe(true);
  });

  it("ignores tokens under three characters", () => {
    // A model number of "5" would otherwise match every message ever sent.
    expect(mentionsVocabulary("we have 5 of them", ["5", "22"])).toBe(false);
  });
});

describe("looksLikeContinuation", () => {
  it("recognises the second turn of a conversation", () => {
    expect(looksLikeContinuation("and then what?")).toBe(true);
    expect(looksLikeContinuation("tried that, no luck")).toBe(true);
    expect(looksLikeContinuation("still the same")).toBe(true);
  });

  it("refuses a long message, which is a new subject rather than a continuation", () => {
    expect(
      looksLikeContinuation(
        "and then i wondered whether you could tell me about the practice takings for last month please",
      ),
    ).toBe(false);
  });

  it("refuses a message with no continuation words in it", () => {
    expect(looksLikeContinuation("what is the capital of portugal")).toBe(false);
  });
});

describe("firstMatch", () => {
  it("returns the first rule that matches, so rule order is the reported reason", () => {
    const rules = [
      { id: "a", pattern: /alpha/ },
      { id: "b", pattern: /alpha|beta/ },
    ];
    expect(firstMatch(rules, "alpha")?.id).toBe("a");
    expect(firstMatch(rules, "beta")?.id).toBe("b");
    expect(firstMatch(rules, "gamma")).toBeNull();
  });
});
