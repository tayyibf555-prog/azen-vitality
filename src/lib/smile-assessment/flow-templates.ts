// The starting funnels. One per goal in GOAL_CATALOG (campaign.ts:32-40), so the
// template gallery and the campaign goal dropdown (campaigns-panel.tsx:286) can
// never disagree, plus a minimal Start From Scratch spine.
//
// A template is a PURE, VERSIONED BUILDER: `build()` returns a fresh FlowGraph
// every call, so an owner editing one copy can never mutate the template. Same
// shape as the bespoke landing registry (src/lib/landing/bespoke/registry.ts).
//
// THE SPINE, for every template (brief §5):
//   welcome -> treatment -> [goal-specific question] -> timeline -> funding
//           -> depth -> region -> contact -> result x3
//
// Everything the spine asks comes from quiz.ts. The goal-specific question is
// routed ONLY from the treatment answers it applies to (quiz.ts `appliesTo`),
// with a default edge carrying everyone else straight past it: that is rule 9,
// and it is also just good manners - nobody should be asked how many teeth they
// are replacing when they came in about whitening.
//
// DRIFT GUARD: flow-templates.test.ts validates every template against the LIVE
// question bank. Remove a question from quiz.ts and the suite goes red here
// instead of a broken funnel going live.
//
// COMPLIANCE: every authored string in this file is patient-facing. The test
// scans them all with scanBannedText (src/lib/landing/compliance.ts) plus the
// NHS/private regexes from area16-18-patient-copy-jargon.test.ts. British
// English, no dashes, no funding jargon, no clinical claims, no promises.

import { GOAL_CATALOG, type AssessmentGoalKey } from "./campaign";
import { Q_BUDGET, Q_LOCATION, Q_TIMELINE, Q_TREATMENT } from "./quiz";
import { FLOW_SCHEMA_VERSION, type FlowBand, type FlowEdge, type FlowGraph, type FlowNode } from "./flow";

export interface FlowTemplate {
  key: string;
  goal: AssessmentGoalKey;
  /** Owner-facing name in the gallery. */
  label: string;
  /** Owner-facing one-liner: what this funnel is for. */
  blurb: string;
  /** Bumped when the shape of THIS template changes. Copies already saved are untouched. */
  version: number;
  build(): FlowGraph;
}

// ---------------------------------------------------------------------------
// Shared patient-facing copy.
// ---------------------------------------------------------------------------

/**
 * The warm static lead-in for each step, standing in for the adaptive funnel's
 * per-step AI line (next/route.ts:140-143). Deterministic mode has no runtime AI,
 * and no transition at all reads cold, so every template ships these. An owner
 * can rewrite any of them in the builder; a rewrite is scanned at write time.
 */
const TRANSITIONS = {
  timeline: "That helps. Now, when you would like to get started.",
  budget: "Almost there. How you would like to cover the cost is next.",
  depth: "Nearly there. A few quick ones and we are done.",
  location: "Last one, so the team can point you to the most convenient practice.",
} as const;

/**
 * Result headlines. Deliberately about the ENQUIRY (how ready they are), never
 * about the treatment: the score is intent and fit only, never clinical
 * suitability (quiz.ts:10-12). A clinician decides suitability, always.
 */
const OUTCOME_HEADLINES: Record<FlowBand, string> = {
  high: "You look ready to get started.",
  medium: "Thank you. The team will take it from here.",
  low: "Thank you for taking the time.",
};

// ---------------------------------------------------------------------------
// Node ids. Stable and readable, because they are what a validation failure
// names back to the owner ("region is not answered on every path to contact").
// ---------------------------------------------------------------------------

const WELCOME = "welcome";
const CONTACT = "contact";
const RESULT: Record<FlowBand, string> = {
  high: "result-high",
  medium: "result-medium",
  low: "result-low",
};
const qNode = (questionId: string): string => `q-${questionId}`;

// ---------------------------------------------------------------------------
// The spine builder.
// ---------------------------------------------------------------------------

interface Step {
  questionId: string;
  transition?: string;
}

interface SpineSpec {
  /**
   * The goal-specific question and the treatment answers that lead to it.
   * Everyone else takes the default edge straight past it.
   */
  branch?: { questionId: string; treatments: string[]; transition: string };
  /** Asked of everyone, after funding and before the region question. */
  depth: Step[];
}

/**
 * Build the spine. The welcome node deliberately carries NO copy: the campaign
 * already owns its patient-facing headline and intro (campaign.ts:139-155), and
 * two sources of the same words on one screen is how they end up contradicting
 * each other. The builder lets an owner override per funnel if they want to.
 */
function buildSpine(spec: SpineSpec): FlowGraph {
  const nodes: FlowNode[] = [{ id: WELCOME, kind: "welcome" }];
  const edges: FlowEdge[] = [];

  const addQuestion = (step: Step): string => {
    const id = qNode(step.questionId);
    const node: FlowNode = { id, kind: "question", questionId: step.questionId };
    if (step.transition) node.transition = step.transition;
    nodes.push(node);
    return id;
  };

  // welcome -> treatment
  const treatment = addQuestion({ questionId: Q_TREATMENT });
  edges.push({ from: WELCOME, to: treatment, answer: null });

  // The straight-through spine after the treatment question.
  const trunk: Step[] = [
    { questionId: Q_TIMELINE, transition: TRANSITIONS.timeline },
    { questionId: Q_BUDGET, transition: TRANSITIONS.budget },
    ...spec.depth,
    { questionId: Q_LOCATION, transition: TRANSITIONS.location },
  ];
  const trunkIds = trunk.map(addQuestion);
  const firstTrunk = trunkIds[0]!;

  // treatment -> [goal question] -> trunk, or treatment -> trunk.
  if (spec.branch) {
    const branchId = addQuestion({
      questionId: spec.branch.questionId,
      transition: spec.branch.transition,
    });
    for (const t of spec.branch.treatments) {
      edges.push({ from: treatment, to: branchId, answer: t });
    }
    edges.push({ from: treatment, to: firstTrunk, answer: null });
    edges.push({ from: branchId, to: firstTrunk, answer: null });
  } else {
    edges.push({ from: treatment, to: firstTrunk, answer: null });
  }

  for (let i = 0; i < trunkIds.length - 1; i++) {
    edges.push({ from: trunkIds[i]!, to: trunkIds[i + 1]!, answer: null });
  }
  edges.push({ from: trunkIds[trunkIds.length - 1]!, to: CONTACT, answer: null });

  // contact -> one result per band. The band comes from scoreAssessment AFTER
  // the submission, never from a patient answer: it is the only routing that
  // lets one contact step sit in front of all three results (rules 6 and 7).
  nodes.push({ id: CONTACT, kind: "contact" });
  for (const band of ["high", "medium", "low"] as const) {
    nodes.push({ id: RESULT[band], kind: "outcome", band, headline: OUTCOME_HEADLINES[band] });
    edges.push({ from: CONTACT, to: RESULT[band], answer: band });
  }

  return { schemaVersion: FLOW_SCHEMA_VERSION, entry: WELCOME, nodes, edges };
}

// ---------------------------------------------------------------------------
// Reusable branch definitions, straight off quiz.ts `appliesTo`.
// ---------------------------------------------------------------------------

/** quiz.ts:149 - the picture question, and the only one with 3D option tiles. */
const ALIGNER_BRANCH = {
  questionId: "smile_concern",
  treatments: ["invisalign"],
  transition: "Thank you. A quick one about your smile so the team knows what you would like to change.",
};

/** quiz.ts:123 - how much work an implant enquiry is really asking about. */
const IMPLANT_BRANCH = {
  questionId: "implant_scope",
  treatments: ["implants"],
  transition: "Thank you. Just so the team has a sense of what you are looking to replace.",
};

/** quiz.ts:177 - shared by veneers, bonding and whitening, per its appliesTo. */
const COSMETIC_BRANCH = {
  questionId: "cosmetic_goal",
  treatments: ["veneers", "whitening", "bonding"],
  transition: "Thank you. A quick one about what you would most like to change.",
};

// The depth question is the one real difference between the funnels that share a
// branch, so each is chosen for what that enquiry actually turns on:
//   readiness  - a bigger decision: how close are they to booking (quiz.ts:92)
//   motivation - what is prompting them NOW, which is what a date-driven or
//                long-postponed enquiry hinges on (quiz.ts:102)
//   experience - have they shopped around already (quiz.ts:113)
const READINESS: Step = { questionId: "readiness", transition: TRANSITIONS.depth };
const MOTIVATION: Step = { questionId: "motivation", transition: TRANSITIONS.depth };
const EXPERIENCE: Step = { questionId: "experience" };

// ---------------------------------------------------------------------------
// The seven templates: one per GOAL_CATALOG key.
// ---------------------------------------------------------------------------

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [
  {
    key: "invisalign",
    goal: "invisalign",
    label: "Teeth straightening enquiry",
    version: 1,
    blurb: "Opens with the picture question so an aligner enquiry says what it wants to change.",
    build: () => buildSpine({ branch: ALIGNER_BRANCH, depth: [READINESS] }),
  },
  {
    key: "implants",
    goal: "implants",
    label: "Implant enquiry",
    version: 1,
    blurb: "Asks how much is being replaced, then how ready they are to book.",
    build: () => buildSpine({ branch: IMPLANT_BRANCH, depth: [READINESS] }),
  },
  {
    key: "veneers",
    goal: "veneers",
    label: "Smile makeover enquiry",
    version: 1,
    blurb: "For a bigger cosmetic decision: what they want changed, then how close they are to booking.",
    build: () => buildSpine({ branch: COSMETIC_BRANCH, depth: [READINESS] }),
  },
  {
    key: "bonding",
    goal: "bonding",
    label: "Composite bonding enquiry",
    version: 1,
    blurb: "For chips, gaps and shape: what they want changed, and what has prompted them now.",
    build: () => buildSpine({ branch: COSMETIC_BRANCH, depth: [MOTIVATION] }),
  },
  {
    key: "whitening",
    goal: "whitening",
    label: "Whitening enquiry",
    version: 1,
    blurb: "Whitening usually has a date behind it, so this one asks what has prompted them now.",
    build: () => buildSpine({ branch: COSMETIC_BRANCH, depth: [MOTIVATION] }),
  },
  {
    // No goal-specific question exists in the bank for hygiene (nothing carries
    // appliesTo: ["hygiene"]), so motivation is the differentiator: what has
    // prompted a check-up now is exactly what the front desk wants to know.
    key: "hygiene",
    goal: "hygiene",
    label: "Check-up and hygiene enquiry",
    version: 1,
    blurb: "The short one: what has prompted them now, when, and where they are based.",
    build: () => buildSpine({ depth: [MOTIVATION] }),
  },
  {
    // Likewise no goal-specific question, and no single treatment to lean on, so
    // this one goes wider: how ready they are AND whether they have looked into
    // it before.
    key: "general",
    goal: "general",
    label: "General enquiry",
    version: 1,
    blurb: "Treatment-agnostic: covers how ready they are and whether they have looked before.",
    build: () => buildSpine({ depth: [READINESS, EXPERIENCE] }),
  },
];

export function flowTemplate(key: string | null | undefined): FlowTemplate | undefined {
  return key ? FLOW_TEMPLATES.find((t) => t.key === key) : undefined;
}

/**
 * The template for a campaign goal. This is also the AI generator's last resort
 * (brief §6): if a generated graph will not validate even after one repair pass,
 * the owner gets this instead of an unvalidated funnel. Falls back to the general
 * template so it can never return nothing.
 */
export function templateForGoal(goal: string | null | undefined): FlowTemplate {
  return (
    FLOW_TEMPLATES.find((t) => t.goal === goal) ??
    FLOW_TEMPLATES.find((t) => t.goal === "general")!
  );
}

export const GOAL_KEYS_WITH_TEMPLATE: readonly string[] = GOAL_CATALOG.map((g) => g.key);

/** The key the gallery uses for Start From Scratch (never a goal key). */
export const SCRATCH_FLOW_KEY = "scratch";

/**
 * The smallest funnel that is still legal: treatment, timing, funding, region,
 * contact, three results. Start From Scratch begins here rather than on an empty
 * canvas, because an empty canvas starts life failing six rules and there is no
 * sense showing an owner a wall of red before they have done anything.
 */
export function buildScratchFlow(): FlowGraph {
  return buildSpine({ depth: [] });
}
