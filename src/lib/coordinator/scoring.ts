import type { TreatmentOpportunity } from "./types";

const DAY = 86_400_000;

export function priorityScore(o: TreatmentOpportunity, now: Date): number {
  const acceptedMs = new Date(o.acceptedAt).getTime();
  // An empty/invalid acceptedAt would yield NaN; treat age as 0 so the score
  // stays finite (and the opportunity ranks as freshly accepted).
  const ageDays = Number.isNaN(acceptedMs)
    ? 0
    : Math.max(0, (now.getTime() - acceptedMs) / DAY);
  const recencyWeight = Math.max(0.5, 1 - ageDays / 180);
  const sinceTouchDays = o.lastTouchAt
    ? Math.max(0, (now.getTime() - new Date(o.lastTouchAt).getTime()) / DAY)
    : 30;
  const stalenessWeight = 1 + Math.min(sinceTouchDays, 30) / 30; // 1..2
  const financeBonus = o.financePresented ? 1 : 1.15;
  return o.amountOutstanding * recencyWeight * stalenessWeight * financeBonus;
}

export function rankOpportunities(items: TreatmentOpportunity[], now: Date): TreatmentOpportunity[] {
  return items
    .map((o) => ({ ...o, priorityScore: priorityScore(o, now) }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}
