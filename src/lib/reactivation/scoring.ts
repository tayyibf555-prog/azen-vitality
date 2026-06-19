import type { ReactivationTarget } from "./types";

const DAY = 86_400_000;

export function winnability(t: ReactivationTarget, now: Date): number {
  const anchorIso = t.recallDueAt ?? t.lastVisitAt;
  const sinceDays = anchorIso
    ? Math.max(0, (now.getTime() - new Date(anchorIso).getTime()) / DAY)
    : 365;
  const recencyWeight = Math.max(0.5, 1.5 - sinceDays / 365); // 1.5 fresh .. 0.5 old
  const attemptsPenalty = Math.max(0.5, 1 - t.priorAttempts * 0.2);
  const raw = recencyWeight * attemptsPenalty;
  return Math.min(1.5, Math.max(0.25, raw));
}

export function reactivationScore(t: ReactivationTarget, now: Date): number {
  return t.recoverableValue * winnability(t, now);
}

export function rankTargets(items: ReactivationTarget[], now: Date): ReactivationTarget[] {
  return items
    .map((t) => ({ ...t, reactivationScore: reactivationScore(t, now) }))
    .sort((a, b) => b.reactivationScore - a.reactivationScore);
}
