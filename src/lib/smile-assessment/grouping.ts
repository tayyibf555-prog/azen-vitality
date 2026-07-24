// Groups Smile Assessment CAMPAIGNS by their goal (treatment focus), for the
// per-goal tabs in the internal Assessments section. Mirrors
// groupRowsByTreatment in src/lib/landing/overview.ts (same shape: one group per
// key, order preserved by first appearance) so the two treatment-tabbed Growth
// sections (Landing pages, Smile Assessment) behave identically. Pure (no I/O),
// so it is fully unit-testable and has no dependency on how campaigns were
// fetched (the admin API's shape, or the raw Campaign domain type).

import { goalLabel } from "./campaign";

/** One goal's campaigns, for the per-goal tabs in the Assessments section. */
export interface CampaignGoalGroup<T> {
  /** The campaign's goal key (e.g. "invisalign", "bonding", "general"). */
  key: string;
  /** Display label via goalLabel(), e.g. "Composite bonding". */
  label: string;
  campaigns: T[];
}

/**
 * Group campaigns by goal, preserving the incoming order: the first time a goal
 * appears fixes its tab position and label (so, e.g., the goal with the most
 * recently created campaign — listCampaigns/the admin API both return newest
 * first — leads). A missing/blank goal falls back to "general", the same
 * bucket a campaign explicitly created with goal "general" lands in, so the
 * tabs never fragment into a same-meaning duplicate.
 */
export function groupCampaignsByGoal<T extends { goal: string }>(
  campaigns: T[],
): CampaignGoalGroup<T>[] {
  const groups: CampaignGoalGroup<T>[] = [];
  const byKey = new Map<string, CampaignGoalGroup<T>>();
  for (const c of campaigns) {
    const key = c.goal || "general";
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: goalLabel(key), campaigns: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.campaigns.push(c);
  }
  return groups;
}
