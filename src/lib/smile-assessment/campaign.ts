// Smile Assessment CAMPAIGNS — the practice owner's configuration for a targeted
// assessment: its goal (treatment focus), ideal customer, budget band and public
// copy. Each campaign has a custom public URL (/assess/<client>/<slug>) used as an
// ad destination. The goal/budget feed the scoring tuning and the AI first-contact.
//
// Pure data + helpers only (no I/O), so it is shared by the public landing page,
// the submit endpoint, the scoring engine and the internal management UI.

import { Q_TREATMENT } from "./quiz";

// ---------------------------------------------------------------------------
// Goal catalogue. A goal maps to the Q_TREATMENT option value it targets (or null
// for a general assessment that targets no specific treatment).
// ---------------------------------------------------------------------------

export type AssessmentGoalKey =
  | "invisalign"
  | "implants"
  | "veneers"
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
}

export function toPublicCampaign(c: Campaign): PublicCampaign {
  return {
    slug: c.slug,
    goal: c.goal,
    goalLabel: goalLabel(c.goal),
    headline: c.headline,
    intro: c.intro,
  };
}

export { Q_TREATMENT };
