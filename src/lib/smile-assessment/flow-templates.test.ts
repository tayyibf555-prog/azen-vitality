// The drift guard and the scoring guard for the shipped funnels.
//
// DRIFT: every template is validated against the LIVE question bank, so a
// question leaving or changing in quiz.ts fails the suite here rather than
// shipping a funnel that dead-ends a patient.
//
// SCORING: two valid funnels can band the same patient differently, because
// scoreAssessment normalises against the questions ACTUALLY ANSWERED
// (scoring.ts:79-80). So each template is walked end to end with the real runtime
// and scored with the real engine: the most engaged answers must band "high" (or
// no lead is ever fast-tracked) and the least engaged must band "low" (or every
// tyre-kicker is).

import { describe, it, expect } from "vitest";
import {
  FLOW_TEMPLATES,
  SCRATCH_FLOW_KEY,
  buildScratchFlow,
  flowTemplate,
  templateForGoal,
} from "./flow-templates";
import { validateFlow, describeFlowFailures } from "./flow-validate";
import { walkFlow } from "./flow-runtime";
import { GOAL_CATALOG, GOAL_KEYS, goalTreatment } from "./campaign";
import { scoreAssessment } from "./scoring";
import { MAX_QUESTIONS } from "./funnel";
import { questionById, Q_TREATMENT, type QuizOption, type QuizQuestion } from "./quiz";
import type { FlowGraph } from "./flow";
import { scanBannedText } from "@/lib/landing/compliance";

// Mirrors area16-18-patient-copy-jargon.test.ts:17 - the project rule that
// patient-facing copy never says NHS or private.
const FORBIDDEN = [/\bNHS\b/i, /\bprivate\b/i, /\bprivately\b/i];

const best = (q: QuizQuestion): string => q.options.reduce(pickHigher).value;
const worst = (q: QuizQuestion): string => q.options.reduce(pickLower).value;
function pickHigher(a: QuizOption, b: QuizOption): QuizOption {
  return b.weight > a.weight ? b : a;
}
function pickLower(a: QuizOption, b: QuizOption): QuizOption {
  return b.weight < a.weight ? b : a;
}

/**
 * Walk a funnel for real with flow-runtime, answering each question with
 * `choose`, and return the submission it would produce. Bounded so a funnel that
 * failed to terminate fails the assertion rather than hanging the suite.
 */
function walkAnswers(
  graph: FlowGraph,
  choose: (q: QuizQuestion) => string,
): { answers: Record<string, string>; asked: string[] } {
  const answers: Record<string, string> = {};
  for (let i = 0; i <= MAX_QUESTIONS + 3; i++) {
    const walk = walkFlow(graph, answers);
    if (walk.status === "contact") return { answers, asked: walk.asked };
    expect(walk.status, `walk got stuck: ${walk.status === "stuck" ? walk.reason : ""}`).toBe("ask");
    if (walk.status !== "ask") break;
    const q = questionById(walk.node.questionId);
    expect(q, `node ${walk.node.id} asks an unknown question`).toBeTruthy();
    answers[walk.node.questionId] = choose(q!);
  }
  throw new Error("the funnel never reached the contact step");
}

/** Every patient-facing and owner-facing string a template ships. */
function authoredCopy(graph: FlowGraph): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "welcome") {
      if (n.headline) out.push({ where: `${n.id}.headline`, text: n.headline });
      if (n.intro) out.push({ where: `${n.id}.intro`, text: n.intro });
    }
    if (n.kind === "question" && n.transition) {
      out.push({ where: `${n.id}.transition`, text: n.transition });
    }
    if (n.kind === "outcome" && n.headline) {
      out.push({ where: `${n.id}.headline`, text: n.headline });
    }
  }
  for (const e of graph.edges) {
    if (e.transition) out.push({ where: `${e.from}->${e.to}.transition`, text: e.transition });
  }
  return out;
}

describe("the template gallery", () => {
  it("ships exactly one template per campaign goal", () => {
    expect(FLOW_TEMPLATES.map((t) => t.goal).sort()).toEqual([...GOAL_KEYS].sort());
    expect(new Set(FLOW_TEMPLATES.map((t) => t.key)).size).toBe(FLOW_TEMPLATES.length);
    expect(FLOW_TEMPLATES.length).toBe(GOAL_CATALOG.length);
  });

  it("never uses the Start From Scratch key as a goal", () => {
    expect(GOAL_KEYS).not.toContain(SCRATCH_FLOW_KEY);
    expect(FLOW_TEMPLATES.map((t) => t.key)).not.toContain(SCRATCH_FLOW_KEY);
  });

  it("looks a template up by key, and gives a goal one even when the goal is junk", () => {
    expect(flowTemplate("implants")?.goal).toBe("implants");
    expect(flowTemplate("nope")).toBeUndefined();
    expect(templateForGoal("whitening").key).toBe("whitening");
    expect(templateForGoal("something-else").goal).toBe("general");
    expect(templateForGoal(null).goal).toBe("general");
  });

  it("builds a fresh graph every call, so an edited copy cannot poison the template", () => {
    const template = FLOW_TEMPLATES[0]!;
    const first = template.build();
    first.nodes.push({ id: "vandalism", kind: "contact" });
    first.entry = "vandalism";
    const second = template.build();
    expect(second.entry).toBe("welcome");
    expect(second.nodes.some((n) => n.id === "vandalism")).toBe(false);
  });
});

describe.each(FLOW_TEMPLATES.map((t) => [t.key, t] as const))("template: %s", (_key, template) => {
  const graph = template.build();

  it("validates against the live question bank", () => {
    const result = validateFlow(graph);
    expect(describeFlowFailures(result.failures)).toBe("");
    expect(result.ok).toBe(true);
  });

  it("asks no more questions than the adaptive funnel would", () => {
    const { asked } = walkAnswers(graph, best);
    expect(asked.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });

  it("bands the most engaged answers high, so the lead is fast-tracked", () => {
    const { answers } = walkAnswers(graph, best);
    expect(scoreAssessment(answers).band).toBe("high");
  });

  it("bands the least engaged answers low, so a browser is not fast-tracked", () => {
    const { answers } = walkAnswers(graph, worst);
    expect(scoreAssessment(answers).band).toBe("low");
  });

  it("bands an engaged enquiry for its own goal high, with and without campaign tuning", () => {
    const target = goalTreatment(template.goal);
    const { answers, asked } = walkAnswers(graph, (q) =>
      q.id === Q_TREATMENT && target ? target : best(q),
    );
    if (target) expect(answers[Q_TREATMENT]).toBe(target);
    expect(scoreAssessment(answers).band).toBe("high");
    expect(scoreAssessment(answers, { goal: template.goal, targetBudget: "any" }).band).toBe("high");
    expect(asked.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });

  it("never fast-tracks a disengaged enquiry, even one on the campaign's own treatment", () => {
    const target = goalTreatment(template.goal);
    const { answers } = walkAnswers(graph, (q) =>
      q.id === Q_TREATMENT && target ? target : worst(q),
    );
    expect(scoreAssessment(answers, { goal: template.goal, targetBudget: "any" }).band).not.toBe("high");
  });

  it("asks its goal-specific question only on the branch it applies to", () => {
    const target = goalTreatment(template.goal);
    const branchNodes = graph.nodes.filter(
      (n) => n.kind === "question" && !!questionById(n.questionId)?.appliesTo,
    );
    if (branchNodes.length === 0) return; // hygiene + general have no bank question
    expect(target).toBeTruthy();
    const onBranch = walkAnswers(graph, (q) => (q.id === Q_TREATMENT ? target! : best(q))).asked;
    const offBranch = walkAnswers(graph, (q) => (q.id === Q_TREATMENT ? "other" : best(q))).asked;
    for (const n of branchNodes) {
      if (n.kind !== "question") continue;
      const applies = questionById(n.questionId)!.appliesTo!;
      expect(applies).toContain(target!);
      expect(onBranch).toContain(n.questionId);
      expect(offBranch).not.toContain(n.questionId);
    }
  });

  it("carries a warm lead-in into every step after the first", () => {
    const withCopy = graph.nodes.filter((n) => n.kind === "question" && n.transition).length;
    expect(withCopy).toBeGreaterThanOrEqual(3);
  });

  it("passes the compliance scan on every authored string", () => {
    const strings = [
      ...authoredCopy(graph),
      { where: `${template.key}.label`, text: template.label },
      { where: `${template.key}.blurb`, text: template.blurb },
    ];
    expect(strings.length).toBeGreaterThan(0);
    for (const { where, text } of strings) {
      const hits = scanBannedText(text);
      expect(hits.map((h) => `${h.category}:${h.matched}`).join(", "), `${where} -> "${text}"`).toBe("");
      for (const re of FORBIDDEN) {
        expect(re.test(text), `${where} -> "${text}" contains forbidden jargon ${re}`).toBe(false);
      }
    }
  });
});

describe("Start From Scratch", () => {
  it("starts on a funnel that already passes every rule", () => {
    const result = validateFlow(buildScratchFlow());
    expect(describeFlowFailures(result.failures)).toBe("");
    expect(result.ok).toBe(true);
  });

  it("is the shortest legal funnel: the core trio plus the region question", () => {
    const { asked } = walkAnswers(buildScratchFlow(), best);
    expect(asked.length).toBe(4);
  });
});
