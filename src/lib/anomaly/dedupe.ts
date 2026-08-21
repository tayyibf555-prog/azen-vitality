// ---------------------------------------------------------------------------
// Dedupe: what to do when a detector raises a condition that already has a row.
//
// The requirement is "the same condition does not ping daily", and the shape
// that delivers it is: one row per (client, dedupe key), raised once, refreshed
// silently while it persists, resolved when it clears, and allowed to raise
// again only after a cooldown.
//
// The cooldown is the part that is easy to leave out and expensive to omit. A
// condition that flaps — an approval queue that crosses ten every afternoon and
// is cleared every morning — would otherwise resolve and re-raise every single
// day, which is precisely the daily ping the dedupe key exists to prevent. So a
// key that resolved recently is HELD rather than re-raised.
//
// Pure: no clock read, no I/O. The sweep passes `now`.
// ---------------------------------------------------------------------------

import { RERAISE_COOLDOWN_HOURS, type Alert, type AlertKind, type AlertSeverity } from "./types";

const HOUR_MS = 3_600_000;

/** One persisted alert row, as the repository reads it back. */
export interface StoredAlert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  dedupeKey: string;
  sentence: string;
  href: string | null;
  at: string;
  firstRaisedAt: string;
  lastSeenAt: string;
  /** Null while the condition is still true. */
  resolvedAt: string | null;
}

/**
 * insert   no row for this key: raise it, and the owner sees it.
 * refresh  the row is already open: bump last-seen and take the newer wording,
 *          but do NOT re-raise. This is the branch that stops the daily ping.
 * reraise  the row was resolved long enough ago that the condition returning is
 *          news again.
 * hold     the row was resolved very recently: the condition is flapping, so say
 *          nothing and leave it resolved.
 */
export type RaiseDecision = "insert" | "refresh" | "reraise" | "hold";

/** What to do with `alert` given whatever row already exists for its key. */
export function decideRaise(existing: StoredAlert | null, now: Date): RaiseDecision {
  if (existing === null) return "insert";
  if (existing.resolvedAt === null) return "refresh";

  const resolvedAt = Date.parse(existing.resolvedAt);
  // An unparseable resolved_at is treated as "resolved just now": holding is the
  // conservative direction, because the failure mode of the other branch is an
  // alert the owner has already dealt with reappearing on their screen.
  if (Number.isNaN(resolvedAt)) return "hold";

  return now.getTime() - resolvedAt >= RERAISE_COOLDOWN_HOURS * HOUR_MS ? "reraise" : "hold";
}

/**
 * Open rows whose condition the latest pass looked for and did not find, so they
 * should be marked resolved.
 *
 * `unproven` is the honesty rule applied to CLEARING an alert, which is the half
 * that is easy to forget. Silence has two causes — the condition went away, and
 * we could not check — and only the first is grounds for closing an alert. A
 * detector whose reading was unavailable contributes its dedupe-key PREFIXES
 * here (e.g. "takings_trend:", or "outbox_stuck:recall" when one table's read
 * failed), and every open row under those prefixes is left exactly as it was.
 *
 * Without this, one failed database read would quietly resolve a real, live
 * alert off the owner's screen — and the cooldown would then hold it closed for
 * a day after the read recovered. Silence about a problem is worse than silence
 * about a number, because nobody goes looking for it.
 */
export function keysToResolve(
  open: readonly StoredAlert[],
  raised: readonly Alert[],
  unproven: readonly string[] = [],
): string[] {
  const seen = new Set(raised.map((a) => a.dedupeKey));
  return open
    .filter((row) => row.resolvedAt === null)
    .filter((row) => !seen.has(row.dedupeKey))
    .filter((row) => !unproven.some((prefix) => row.dedupeKey.startsWith(prefix)))
    .map((row) => row.dedupeKey);
}

/** Everything one pass intends to do, decided before anything is written. */
export interface PassPlan {
  insert: Alert[];
  refresh: Alert[];
  reraise: Alert[];
  /** Raised, but held back because the same condition resolved too recently. */
  hold: Alert[];
  resolve: string[];
}

/**
 * The whole of a pass's decision-making, as a pure function of what the
 * detectors raised and what is already stored.
 *
 * Separated from the route so the interesting behaviour — a persistent condition
 * refreshing instead of pinging, a flapping one being held, an unprovable one
 * being left alone — is testable without a database anywhere near it.
 */
export function planPass(
  raised: readonly Alert[],
  stored: readonly StoredAlert[],
  unproven: readonly string[],
  now: Date,
): PassPlan {
  const byKey = new Map(stored.map((row) => [row.dedupeKey, row]));
  const plan: PassPlan = { insert: [], refresh: [], reraise: [], hold: [], resolve: [] };

  for (const alert of raised) {
    switch (decideRaise(byKey.get(alert.dedupeKey) ?? null, now)) {
      case "insert":
        plan.insert.push(alert);
        break;
      case "refresh":
        plan.refresh.push(alert);
        break;
      case "reraise":
        plan.reraise.push(alert);
        break;
      case "hold":
        plan.hold.push(alert);
        break;
    }
  }

  plan.resolve = keysToResolve(stored, raised, unproven);
  return plan;
}
