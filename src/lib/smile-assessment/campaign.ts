// Smile Assessment CAMPAIGNS — the practice owner's configuration for a targeted
// assessment: its goal (treatment focus), ideal customer, budget band and public
// copy. Each campaign has a custom public URL (/assess/<client>/<slug>) used as an
// ad destination. The goal/budget feed the scoring tuning and the AI first-contact.
//
// Pure data + helpers only (no I/O), so it is shared by the public landing page,
// the submit endpoint, the scoring engine and the internal management UI.

import { Q_TREATMENT, questionById } from "./quiz";
import { cloneFlowGraph, type FlowGraph } from "./flow";

// ---------------------------------------------------------------------------
// Goal catalogue. A goal maps to the Q_TREATMENT option value it targets (or null
// for a general assessment that targets no specific treatment).
// ---------------------------------------------------------------------------

export type AssessmentGoalKey =
  | "invisalign"
  | "implants"
  | "veneers"
  | "bonding"
  | "whitening"
  | "hygiene"
  | "general";

export interface GoalDef {
  key: AssessmentGoalKey;
  label: string;
  /** The Q_TREATMENT option value this goal rewards, or null for general. */
  treatment: string | null;
}

export const GOAL_CATALOG: GoalDef[] = [
  { key: "invisalign", label: "Invisalign / teeth straightening", treatment: "invisalign" },
  { key: "implants", label: "Dental implants", treatment: "implants" },
  { key: "veneers", label: "Veneers / smile makeover", treatment: "veneers" },
  { key: "bonding", label: "Composite bonding", treatment: "bonding" },
  { key: "whitening", label: "Teeth whitening", treatment: "whitening" },
  { key: "hygiene", label: "Hygiene / check-ups", treatment: "hygiene" },
  { key: "general", label: "General (any treatment)", treatment: null },
];

const GOAL_BY_KEY = new Map(GOAL_CATALOG.map((g) => [g.key, g]));

export function goalDef(key: string | null | undefined): GoalDef | undefined {
  return key ? GOAL_BY_KEY.get(key as AssessmentGoalKey) : undefined;
}

/** The Q_TREATMENT value a campaign goal rewards (null for general/unknown). */
export function goalTreatment(key: string | null | undefined): string | null {
  return goalDef(key)?.treatment ?? null;
}

/** Human label for a goal (falls back to the raw key). */
export function goalLabel(key: string | null | undefined): string {
  return goalDef(key)?.label ?? (key ?? "General");
}

export const GOAL_KEYS: string[] = GOAL_CATALOG.map((g) => g.key);

// ---------------------------------------------------------------------------
// Target budget catalogue. Maps to the Q_BUDGET answers a campaign rewards.
// ---------------------------------------------------------------------------

export type TargetBudgetKey = "ready" | "finance" | "flexible" | "any";

export interface BudgetDef {
  key: TargetBudgetKey;
  label: string;
  /** The Q_BUDGET option values this target rewards. Empty = no preference. */
  rewards: string[];
}

export const BUDGET_CATALOG: BudgetDef[] = [
  { key: "ready", label: "Ready to pay / invest now", rewards: ["ready"] },
  { key: "finance", label: "Open to finance", rewards: ["ready", "finance"] },
  { key: "flexible", label: "Flexible (finance or a plan)", rewards: ["finance", "covered"] },
  { key: "any", label: "Any budget", rewards: [] },
];

const BUDGET_BY_KEY = new Map(BUDGET_CATALOG.map((b) => [b.key, b]));

export function budgetDef(key: string | null | undefined): BudgetDef | undefined {
  return key ? BUDGET_BY_KEY.get(key as TargetBudgetKey) : undefined;
}

export function budgetLabel(key: string | null | undefined): string {
  return budgetDef(key)?.label ?? "Any budget";
}

export const BUDGET_KEYS: string[] = BUDGET_CATALOG.map((b) => b.key);

/** Whether a Q_BUDGET answer matches the campaign's target budget band. */
export function budgetMatches(targetBudget: string | null | undefined, answer: string | null | undefined): boolean {
  if (!answer) return false;
  const def = budgetDef(targetBudget);
  return def ? def.rewards.includes(answer) : false;
}

// ---------------------------------------------------------------------------
// Slug: the URL-safe campaign identifier (the bit after /assess/<client>/).
// ---------------------------------------------------------------------------

const SLUG_MAX = 60;
// Slugs we never let an owner take, because they would shadow the generic quiz or
// a future static child route under /assess/<client>/.
const RESERVED_SLUGS = new Set(["", "api", "assess", "new", "edit", "admin"]);

/**
 * Normalise an owner-supplied name (or slug) into a safe URL slug: lowercase,
 * spaces/underscores -> dashes, strip anything but [a-z0-9-], collapse repeats,
 * trim dashes, cap length. Returns "" if nothing usable remains (caller rejects).
 */
export function slugify(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, ""); // re-trim if the slice landed on a dash
  return s;
}

/** A slug is valid if it normalises to itself and is not reserved. */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && !RESERVED_SLUGS.has(slug) && slugify(slug) === slug;
}

// ---------------------------------------------------------------------------
// Domain types.
// ---------------------------------------------------------------------------

export type CampaignStatus = "active" | "paused";

/** The full smile_assessment_campaign row (internal). */
export interface Campaign {
  id: string;
  clientId: string;
  siteId: string;
  slug: string;
  name: string;
  goal: string;
  goalNote: string | null;
  idealCustomer: string | null;
  targetBudget: string;
  headline: string | null;
  intro: string | null;
  status: CampaignStatus;
  /**
   * The authored funnel graph, EXACTLY as it sits in the jsonb column: raw and
   * unchecked. null for every campaign that has never had one, which is every
   * campaign until an owner draws one.
   *
   * Deliberately `unknown` and NOT a coerced FlowGraph, which is where this
   * differs from rowToForm/normaliseFormConfig (onboarding/form-repository.ts:44).
   * A funnel has two ways to be unusable - the blob is not readable as a graph, or
   * it is readable but breaks one of the eleven routing rules - and only the
   * SECOND can be reported to anyone. Coercing on read collapses them into a
   * silent null. So the raw value travels, and every consumer goes through
   * normaliseAndValidateFlow, which names which of the two happened and why.
   */
  flow: unknown;
  /** Monotonic save counter. 0 = never saved. */
  flowVersion: number;
  /** Whether the public runtime may use `flow` at all. See migration 0078. */
  flowPublished: boolean;
  /**
   * The colour scheme the public page wears: a key from PALETTES
   * (src/lib/assess/palette.ts), or null for "the default look", which is also
   * every campaign created before 0079 and every campaign on a database where
   * 0079 has not been applied. Never trusted on read — paletteFor() matches it
   * against the closed list again and falls back rather than handing an
   * unrecognised value to a style attribute on a public page.
   */
  theme: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The ONLY fields the public landing page is allowed to see. Deliberately omits
 * idealCustomer, goalNote, createdBy, ids and timestamps (internal targeting data)
 * AND `name` (documented as the internal worklist label) — public framing uses the
 * patient-facing headline/intro only.
 */
export interface PublicCampaign {
  slug: string;
  goal: string;
  goalLabel: string;
  headline: string | null;
  intro: string | null;
  /**
   * The chosen colour scheme's KEY — never the colours themselves. Safe to be
   * public by construction: it is one of a closed list of names the page would
   * have to resolve anyway, it reveals nothing about targeting or scoring, and
   * whatever it says the renderer still matches it against PALETTES before a
   * single character reaches a style attribute.
   */
  theme: string | null;
}

export function toPublicCampaign(c: Campaign): PublicCampaign {
  return {
    slug: c.slug,
    goal: c.goal,
    goalLabel: goalLabel(c.goal),
    headline: c.headline,
    intro: c.intro,
    theme: c.theme,
  };
}

// ---------------------------------------------------------------------------
// The public funnel payload.
// ---------------------------------------------------------------------------

/**
 * A question as the patient's browser is allowed to see it: id, prompt, and the
 * option values and labels. This is byte-for-byte the shape `questionPayload`
 * already returns from the adaptive funnel (api/smile-assessment/next/route.ts:75),
 * which is the point - the two modes must not ship the browser different things
 * about the same question.
 *
 * WHAT IS MISSING FROM IT IS THE FEATURE. QuizOption carries a `weight`
 * (quiz.ts:17-21): the practice's intent/fit scoring model, and the reason a lead
 * bands high or low. It is never sent. Publishing it would let anyone reverse the
 * qualification model straight out of the page source, and would hand a competitor
 * the one genuinely proprietary thing in the funnel. So the strip happens HERE, on
 * the server, once, rather than being remembered by each component.
 */
export interface PublicFlowQuestion {
  id: string;
  prompt: string;
  options: { value: string; label: string }[];
}

/**
 * Everything the deterministic runtime needs and nothing it does not: the routing
 * graph (ids, authored copy, option values) plus the wording for exactly the
 * questions this funnel asks. A question in the bank that this funnel never asks
 * is not sent either.
 *
 * CONTENT BLOCKS AND ANSWER-CARD PICTURES TRAVEL ON THE GRAPH, not on the
 * questions. That is deliberate: they are per-NODE authoring (the same bank
 * question can appear on two branches wearing different pictures), while a
 * PublicFlowQuestion is per-QUESTION and is byte-for-byte the shape the adaptive
 * funnel already sends. Widening it would fork the two modes' payloads for a
 * cosmetic field and reopen the question of which one wins on a shared question.
 * So the renderer reads node.blocks / node.optionImages and resolves picture keys
 * through src/lib/assess/image-library.ts, which carries no weights either.
 */
export interface PublicFlow {
  graph: FlowGraph;
  questions: PublicFlowQuestion[];
}

/**
 * Build the public payload for a VALIDATED graph.
 *
 * Returns null when any question node names an id that is not in the bank. That
 * cannot happen after validateFlow (rule 2 catches it), and the null is still
 * here on purpose: it means a caller that forgets to validate gets no funnel and
 * falls back to the adaptive one, rather than serving a patient a question screen
 * with a missing prompt. Loud failure, working quiz.
 */
export function toPublicFlow(graph: FlowGraph): PublicFlow | null {
  const questions: PublicFlowQuestion[] = [];
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind !== "question" || seen.has(n.questionId)) continue;
    const q = questionById(n.questionId);
    if (!q) return null;
    seen.add(n.questionId);
    questions.push({
      id: q.id,
      prompt: q.prompt,
      // Mapped field by field, never spread: a spread would carry `weight` the
      // moment anyone adds a field to QuizOption, and nobody would notice.
      options: q.options.map((o) => ({ value: o.value, label: o.label })),
    });
  }
  // A fresh graph, so nothing downstream can mutate the campaign row's copy of it.
  // cloneFlowGraph rather than a per-node spread: a spread shares the `blocks` and
  // `optionImages` ARRAYS with the stored graph, which would make that promise
  // quietly false for exactly the fields added in A2.
  return { graph: cloneFlowGraph(graph), questions };
}

export { Q_TREATMENT };
