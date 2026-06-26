// Daily brief domain types.
//
// The daily brief is a READ view: it is computed on read by composing the
// already-built module read functions, never snapshotted and never written.
//
// `BriefItem` is the shape the Overview dashboard already renders, so the
// generator re-uses it verbatim for the dashboard headline. The richer types
// below describe the full staff-facing page.

import type { BriefItem, Role } from "@/lib/types";

// Re-export so dashboard + generator share one source of truth.
export type { BriefItem } from "@/lib/types";

export type BriefPriority = BriefItem["priority"]; // "high" | "medium" | "low"

/** What we are composing the brief for: a client, its sites, the role, and now. */
export interface BriefContext {
  clientId: string;
  siteIds: string[];
  role: Role;
  now: Date;
}

/** One actionable line within a section of the full brief. */
export interface BriefLine {
  title: string;
  detail: string;
  priority: BriefPriority;
  /** A countable quantity behind the line (e.g. 4 appointments). */
  count?: number;
  /** A money figure behind the line, GBP. */
  value?: number;
  /** Deep link into the owning module, when one applies. */
  href?: string;
}

/** A themed group of brief lines (today's diary, who to chase, money, ...). */
export interface BriefSection {
  key: string;
  title: string;
  items: BriefLine[];
}

/** The full computed brief for the staff-facing page. */
export interface DailyBrief {
  generatedAt: string; // ISO
  role: Role;
  appointmentsToday: number;
  sections: BriefSection[];
  /** The top few prioritised items, in the dashboard's BriefItem shape. */
  headline: BriefItem[];
}
