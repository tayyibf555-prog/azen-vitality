// Pure grouping / sort / dedupe for the notifications feed. No I/O, fully testable.
//
// The DB-reading source builders live in build.ts; this module owns the
// deterministic shaping: dedupe by stable id, then order by urgency (high first)
// and, within an urgency, most recent first.

import type { NotificationItem, NotificationUrgency } from "./types";

/** Lower rank sorts first. */
export const URGENCY_RANK: Record<NotificationUrgency, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Context hook for future tuning (e.g. per-role emphasis). Empty for v1. */
export interface NotificationContext {
  // Reserved: kept so callers have a stable signature as the feed grows.
  now?: Date;
}

/** Milliseconds for an instant; an unparseable `at` sorts last (oldest). */
function atMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Dedupe by stable id (first occurrence wins) then sort: urgency ascending rank
 * (high -> medium -> low), and within the same urgency the most recent `at` first.
 * Pure and deterministic — the same input always yields the same order.
 */
export function orderNotifications(
  items: NotificationItem[],
  _ctx: NotificationContext = {},
): NotificationItem[] {
  void _ctx;

  const byId = new Map<string, NotificationItem>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    return atMillis(b.at) - atMillis(a.at);
  });
}

/** Count items of a given type (for the by-type stat cards). */
export function countByType(items: NotificationItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  return counts;
}
