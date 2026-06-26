import { describe, it, expect } from "vitest";
import {
  slugify,
  isValidSlug,
  goalTreatment,
  budgetMatches,
  toPublicCampaign,
  type Campaign,
} from "./campaign";
import { scoreAssessment, GOAL_MATCH_BONUS, BUDGET_MATCH_BONUS } from "./scoring";

describe("slugify", () => {
  it("normalises a human name into a URL-safe slug", () => {
    expect(slugify("Summer Invisalign Push!")).toBe("summer-invisalign-push");
    expect(slugify("  Hello__World  ")).toBe("hello-world");
    expect(slugify("Implants & More")).toBe("implants-more");
    expect(slugify("already-good")).toBe("already-good");
  });
  it("returns empty when nothing usable remains", () => {
    expect(slugify("***")).toBe("");
    expect(slugify("   ")).toBe("");
    expect(slugify(null)).toBe("");
  });
  it("caps length and never ends on a dash", () => {
    const s = slugify("a".repeat(80));
    expect(s.length).toBeLessThanOrEqual(60);
    const s2 = slugify("word " + "x".repeat(58)); // slice may land mid/after a dash
    expect(s2.endsWith("-")).toBe(false);
  });
});

describe("isValidSlug", () => {
  it("accepts a clean slug, rejects unclean/reserved ones", () => {
    expect(isValidSlug("summer-invisalign")).toBe(true);
    expect(isValidSlug("Summer")).toBe(false); // uppercase
    expect(isValidSlug("a--b")).toBe(false); // double dash
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("api")).toBe(false); // reserved
    expect(isValidSlug("assess")).toBe(false); // reserved
  });
});

describe("goalTreatment", () => {
  it("maps a focused goal to its Q_TREATMENT value, general to null", () => {
    expect(goalTreatment("implants")).toBe("implants");
    expect(goalTreatment("invisalign")).toBe("invisalign");
    expect(goalTreatment("general")).toBeNull();
    expect(goalTreatment("nonsense")).toBeNull();
    expect(goalTreatment(null)).toBeNull();
  });
});

describe("budgetMatches", () => {
  it("rewards only the answers in the target band", () => {
    expect(budgetMatches("ready", "ready")).toBe(true);
    expect(budgetMatches("ready", "finance")).toBe(false);
    expect(budgetMatches("finance", "ready")).toBe(true);
    expect(budgetMatches("finance", "finance")).toBe(true);
    expect(budgetMatches("flexible", "covered")).toBe(true);
    expect(budgetMatches("any", "ready")).toBe(false); // no preference
    expect(budgetMatches(null, "ready")).toBe(false);
    expect(budgetMatches("ready", undefined)).toBe(false);
  });
});

describe("toPublicCampaign", () => {
  it("exposes ONLY safe public fields (no targeting/internal data leaks)", () => {
    const c: Campaign = {
      id: "id-1",
      clientId: "client-vitality",
      siteId: "site-cc",
      slug: "summer-invisalign",
      name: "Summer Invisalign",
      goal: "invisalign",
      goalNote: "fill August invisalign slots",
      idealCustomer: "25-40 professionals, image conscious",
      targetBudget: "finance",
      headline: "Straighten your smile",
      intro: "Two minutes to your plan",
      status: "active",
      createdBy: "owner@vitality.co",
      createdAt: "2026-06-27T00:00:00Z",
      updatedAt: "2026-06-27T00:00:00Z",
    };
    const pub = toPublicCampaign(c);
    expect(pub).toEqual({
      slug: "summer-invisalign",
      goal: "invisalign",
      goalLabel: "Invisalign / teeth straightening",
      headline: "Straighten your smile",
      intro: "Two minutes to your plan",
    });
    // The sensitive/internal fields must not be present at all (name is the
    // internal worklist label and is deliberately omitted too).
    expect("name" in pub).toBe(false);
    expect("idealCustomer" in pub).toBe(false);
    expect("goalNote" in pub).toBe(false);
    expect("createdBy" in pub).toBe(false);
    expect("clientId" in pub).toBe(false);
  });
});

describe("scoreAssessment campaign tuning", () => {
  // A mid-intent submission: researching-ish timeline so the base lands sub-high,
  // leaving headroom to observe the bonuses.
  const base = { treatment_interest: "implants", timeline: "3_6_months", budget_readiness: "finance", location: "any" };

  it("is unchanged with no tuning (backward compatible)", () => {
    const a = scoreAssessment(base);
    const b = scoreAssessment(base, undefined);
    expect(a.rawScore).toBe(b.rawScore);
  });

  it("adds the goal bonus only when the treatment matches the campaign goal", () => {
    const plain = scoreAssessment(base).rawScore;
    const matched = scoreAssessment(base, { goal: "implants" }).rawScore;
    const mismatched = scoreAssessment(base, { goal: "whitening" }).rawScore;
    expect(matched).toBe(plain + GOAL_MATCH_BONUS);
    expect(mismatched).toBe(plain); // different treatment => no bonus
  });

  it("adds the budget bonus when the funding answer is in the target band", () => {
    const plain = scoreAssessment(base).rawScore;
    const matched = scoreAssessment(base, { targetBudget: "finance" }).rawScore;
    expect(matched).toBe(plain + BUDGET_MATCH_BONUS);
  });

  it("stacks both bonuses and clamps at 100", () => {
    const plain = scoreAssessment(base).rawScore;
    const both = scoreAssessment(base, { goal: "implants", targetBudget: "finance" }).rawScore;
    expect(both).toBe(Math.min(100, plain + GOAL_MATCH_BONUS + BUDGET_MATCH_BONUS));

    const top = { treatment_interest: "implants", timeline: "asap", budget_readiness: "ready", location: "site-cc" };
    const tuned = scoreAssessment(top, { goal: "implants", targetBudget: "ready" }).rawScore;
    expect(tuned).toBeLessThanOrEqual(100);
  });
});
