import { describe, it, expect } from "vitest";
import {
  slugify,
  isValidSlug,
  goalTreatment,
  goalLabel,
  budgetMatches,
  toPublicCampaign,
  toPublicFlow,
  GOAL_CATALOG,
  GOAL_KEYS,
  type Campaign,
} from "./campaign";
import { scoreAssessment, GOAL_MATCH_BONUS, BUDGET_MATCH_BONUS } from "./scoring";
import { FLOW_SCHEMA_VERSION, type FlowGraph } from "./flow";
import { Q_TIMELINE, Q_TREATMENT, questionById } from "./quiz";

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
    expect(goalTreatment("bonding")).toBe("bonding");
    expect(goalTreatment("general")).toBeNull();
    expect(goalTreatment("nonsense")).toBeNull();
    expect(goalTreatment(null)).toBeNull();
  });
});

describe("GOAL_CATALOG bonding entry", () => {
  it("includes a bonding goal that targets the bonding treatment", () => {
    const bonding = GOAL_CATALOG.find((g) => g.key === "bonding");
    expect(bonding).toEqual({ key: "bonding", label: "Composite bonding", treatment: "bonding" });
    expect(GOAL_KEYS).toContain("bonding");
    expect(goalLabel("bonding")).toBe("Composite bonding");
  });

  it("keeps general as the last catalogue entry", () => {
    expect(GOAL_CATALOG[GOAL_CATALOG.length - 1]?.key).toBe("general");
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
      flow: { schemaVersion: 1, entry: "w", nodes: [], edges: [] },
      flowVersion: 3,
      flowPublished: true,
      theme: "landing-blue",
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
      // The colour scheme's KEY, not its colours: a name from a closed list the
      // page has to resolve anyway. It reveals nothing about targeting or
      // scoring, and the renderer re-checks it before it reaches any style.
      theme: "landing-blue",
    });
    // The sensitive/internal fields must not be present at all (name is the
    // internal worklist label and is deliberately omitted too).
    expect("name" in pub).toBe(false);
    expect("idealCustomer" in pub).toBe(false);
    expect("goalNote" in pub).toBe(false);
    expect("createdBy" in pub).toBe(false);
    expect("clientId" in pub).toBe(false);
    // The authored funnel is served separately, by toPublicFlow, and only after
    // it validates. It must never ride along on the campaign payload unchecked.
    expect("flow" in pub).toBe(false);
    expect("flowPublished" in pub).toBe(false);
  });

  // MUTATION: coerce a null theme to "default" on the way out and the public
  // payload stops being able to say "this campaign predates colour schemes" -
  // which is the state every campaign on an un-migrated database is in. The two
  // render identically (palette.ts, paletteFor), and that is precisely why the
  // raw value should travel rather than being helpfully filled in here.
  it("carries a null theme through as null", () => {
    const c: Campaign = {
      id: "id-2",
      clientId: "client-vitality",
      siteId: "site-cc",
      slug: "no-scheme",
      name: "No scheme",
      goal: "general",
      goalNote: null,
      idealCustomer: null,
      targetBudget: "any",
      headline: null,
      intro: null,
      status: "active",
      flow: null,
      flowVersion: 0,
      flowPublished: false,
      theme: null,
      createdBy: null,
      createdAt: "2026-06-27T00:00:00Z",
      updatedAt: "2026-06-27T00:00:00Z",
    };
    expect(toPublicCampaign(c).theme).toBeNull();
  });
});

describe("toPublicFlow", () => {
  /** A one-question funnel whose question really exists in the bank. */
  const graph: FlowGraph = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    entry: "w",
    nodes: [
      { id: "w", kind: "welcome" },
      { id: "q1", kind: "question", questionId: Q_TREATMENT },
      { id: "q2", kind: "question", questionId: Q_TIMELINE },
      { id: "c", kind: "contact" },
      { id: "r", kind: "outcome", band: "high" },
    ],
    edges: [
      { from: "w", to: "q1", answer: null },
      { from: "q1", to: "q2", answer: null },
      { from: "q2", to: "c", answer: null },
      { from: "c", to: "r", answer: "high" },
    ],
  };

  it("NEVER ships an option weight to the browser", () => {
    const pub = toPublicFlow(graph);
    expect(pub).not.toBeNull();
    // The bank definitely has weights, so this is a real strip and not a vacuous pass.
    expect(questionById(Q_TREATMENT)!.options.every((o) => typeof o.weight === "number")).toBe(true);
    for (const q of pub!.questions) {
      for (const o of q.options) {
        expect(Object.keys(o).sort()).toEqual(["label", "value"]);
      }
    }
    expect(JSON.stringify(pub)).not.toContain("weight");
  });

  it("carries the prompt and options for exactly the questions the funnel asks", () => {
    const pub = toPublicFlow(graph)!;
    expect(pub.questions.map((q) => q.id)).toEqual([Q_TREATMENT, Q_TIMELINE]);
    expect(pub.questions[0].prompt).toBe(questionById(Q_TREATMENT)!.prompt);
    // A bank question this funnel never asks is not sent at all.
    expect(pub.questions.some((q) => q.id === "location")).toBe(false);
  });

  it("does not send the same question twice when two nodes reuse it", () => {
    const reused: FlowGraph = {
      ...graph,
      nodes: [...graph.nodes, { id: "q3", kind: "question", questionId: Q_TREATMENT }],
    };
    expect(toPublicFlow(reused)!.questions.map((q) => q.id)).toEqual([Q_TREATMENT, Q_TIMELINE]);
  });

  it("refuses the whole funnel when a node names a question the bank does not have", () => {
    const broken: FlowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === "q2" ? { id: "q2", kind: "question", questionId: "invented_question" } : n,
      ),
    };
    expect(toPublicFlow(broken)).toBeNull();
  });

  it("returns a fresh graph, so a caller cannot mutate the stored row through it", () => {
    const pub = toPublicFlow(graph)!;
    expect(pub.graph).toEqual(graph);
    expect(pub.graph.nodes[0]).not.toBe(graph.nodes[0]);
    pub.graph.nodes[0].id = "tampered";
    expect(graph.nodes[0].id).toBe("w");
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
