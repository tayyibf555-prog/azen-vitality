// THE GALLERY'S RULES: what is recommended, what the category rail contains, and
// what a search matches.
//
// WHY NONE OF THIS IS IN THE COMPONENT. vitest collects only src/**\/*.test.ts in
// a node environment, no .tsx at all (vitest.config.ts:4). A filter rule written
// inside JSX is a rule nothing can hold, and the first thing that drifts is the
// one nobody notices: a search that quietly stops matching the goal name, or a
// rail that grows a hand-typed category the goal dropdown next to it does not
// have. So the rules live here, tested, and template-gallery.tsx renders whatever
// it is handed.
//
// THE RAIL IS DERIVED, NEVER TYPED. Its groups come from GOAL_CATALOG
// (campaign.ts:33-41) - the same list the create form's goal field renders - so
// the two cannot disagree. Add an eighth goal and both grow together.
//
// PURE: no React, no I/O, no barrel.

import { GOAL_CATALOG, goalLabel } from "./campaign";
import { FLOW_TEMPLATES, type FlowTemplate } from "./flow-templates";

/** The rail's first entry, and the "no category chosen" value. */
export const ALL_TEMPLATES_CATEGORY = "all";

export const ALL_TEMPLATES_LABEL = "All templates";

// ---------------------------------------------------------------------------
// Recommended.
// ---------------------------------------------------------------------------

/**
 * The curated front row, in order, BY GOAL.
 *
 * Curated rather than computed, because there is nothing to compute from: a new
 * practice has no submissions, so any "most used" ordering would show an empty
 * shelf on the one screen that most needs to suggest something. The order is a
 * product judgement about a UK general practice:
 *
 *   1. invisalign - straightening is the highest-value enquiry the assessment is
 *      built to qualify, and the only one with a picture question behind it
 *      (quiz.ts:149).
 *   2. hygiene    - the highest-VOLUME enquiry, and the shortest funnel, so it is
 *      the one most likely to be switched on first.
 *   3. general    - the safe default when the practice is not running a campaign
 *      for one treatment.
 *
 * Keyed by GOAL and not by template key so that renaming a template cannot empty
 * the row. If a goal here has no template the row is still filled, from the
 * remaining templates in declaration order - and the drift test goes red, which
 * is where that failure belongs.
 */
export const RECOMMENDED_GOALS: readonly string[] = ["invisalign", "hygiene", "general"];

/** How many cards the recommended row shows. */
export const RECOMMENDED_COUNT = 3;

/**
 * The recommended row: the curated goals in their curated order, topped up from
 * the remaining templates (declaration order) if any curated goal is missing, and
 * capped at RECOMMENDED_COUNT.
 */
export function recommendedTemplates(
  templates: readonly FlowTemplate[] = FLOW_TEMPLATES,
): FlowTemplate[] {
  const picked: FlowTemplate[] = [];
  const taken = new Set<string>();

  for (const goal of RECOMMENDED_GOALS) {
    const match = templates.find((t) => t.goal === goal && !taken.has(t.key));
    if (!match) continue;
    taken.add(match.key);
    picked.push(match);
  }
  for (const t of templates) {
    if (picked.length >= RECOMMENDED_COUNT) break;
    if (taken.has(t.key)) continue;
    taken.add(t.key);
    picked.push(t);
  }
  return picked.slice(0, RECOMMENDED_COUNT);
}

// ---------------------------------------------------------------------------
// The category rail.
// ---------------------------------------------------------------------------

export interface TemplateCategory {
  /** ALL_TEMPLATES_CATEGORY, or a GOAL_CATALOG key. */
  key: string;
  label: string;
  count: number;
}

/**
 * The rail: "All templates" and then one group per goal that actually has a
 * template, in GOAL_CATALOG order. A goal with no template is left out rather
 * than shown as an empty group - a category that can only ever say "nothing here"
 * is a dead end, not a filter.
 */
export function templateCategories(
  templates: readonly FlowTemplate[] = FLOW_TEMPLATES,
): TemplateCategory[] {
  const rail: TemplateCategory[] = [
    { key: ALL_TEMPLATES_CATEGORY, label: ALL_TEMPLATES_LABEL, count: templates.length },
  ];
  for (const goal of GOAL_CATALOG) {
    const count = templates.filter((t) => t.goal === goal.key).length;
    if (count === 0) continue;
    rail.push({ key: goal.key, label: goal.label, count });
  }
  return rail;
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

/**
 * A search query as its terms: lower-cased, whitespace-collapsed, empties gone.
 * Exported because "is the search empty" is itself a rule (it decides whether the
 * recommended row shows) and both callers must agree on the answer.
 */
export function searchTerms(query: string | null | undefined): string[] {
  if (typeof query !== "string") return [];
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * What a template is searchable BY: its owner-facing name, its one-line blurb,
 * and its goal in both machine and human form. The goal label matters - an owner
 * types "implants" or "whitening", which is the dropdown's wording, not the
 * template's name.
 */
function haystack(template: FlowTemplate): string {
  return [template.label, template.blurb, template.goal, goalLabel(template.goal)]
    .join(" ")
    .toLowerCase();
}

/** Every term must appear somewhere. AND, not OR: two words should narrow. */
export function matchesTemplateSearch(template: FlowTemplate, query: string): boolean {
  const terms = searchTerms(query);
  if (terms.length === 0) return true;
  const hay = haystack(template);
  return terms.every((term) => hay.includes(term));
}

// ---------------------------------------------------------------------------
// The combined filter, and what it implies for the layout.
// ---------------------------------------------------------------------------

export interface TemplateFilter {
  search?: string;
  /** ALL_TEMPLATES_CATEGORY (or absent) means every category. */
  category?: string;
}

export function filterTemplates(
  templates: readonly FlowTemplate[] = FLOW_TEMPLATES,
  filter: TemplateFilter = {},
): FlowTemplate[] {
  const category = filter.category ?? ALL_TEMPLATES_CATEGORY;
  return templates.filter((t) => {
    if (category !== ALL_TEMPLATES_CATEGORY && t.goal !== category) return false;
    return matchesTemplateSearch(t, filter.search ?? "");
  });
}

/**
 * Whether the recommended row is shown above the grid.
 *
 * Only on the unfiltered view. Once someone has narrowed the shelf, a row of
 * three cards that ignores their filter is not a recommendation, it is the
 * screen arguing with them - and worse, the same card then appears twice with
 * one copy answering a question they did not ask.
 */
export function showRecommendedRow(filter: TemplateFilter = {}): boolean {
  const category = filter.category ?? ALL_TEMPLATES_CATEGORY;
  return category === ALL_TEMPLATES_CATEGORY && searchTerms(filter.search).length === 0;
}

/**
 * The heading over the main grid: the category's own name once one is chosen, so
 * the grid always says what it is showing.
 */
export function gridHeading(
  filter: TemplateFilter = {},
  templates: readonly FlowTemplate[] = FLOW_TEMPLATES,
): string {
  const category = filter.category ?? ALL_TEMPLATES_CATEGORY;
  if (category === ALL_TEMPLATES_CATEGORY) return ALL_TEMPLATES_LABEL;
  return templateCategories(templates).find((c) => c.key === category)?.label ?? ALL_TEMPLATES_LABEL;
}
