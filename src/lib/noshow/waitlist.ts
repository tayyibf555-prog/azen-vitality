// Pure waitlist matching: which waiting patient should be offered a freed slot.
// No I/O, fully unit-tested.

import type { FreedSlot, WaitlistEntry } from "./types";

/** Whether a waitlist entry is eligible to be offered this freed slot. */
export function matches(entry: WaitlistEntry, slot: FreedSlot): boolean {
  if (entry.status !== "waiting") return false;
  if (entry.siteId !== slot.siteId) return false;
  // If both sides name a practitioner, they must agree (a no-preference entry fits any).
  if (entry.practitionerPref && slot.practitioner && entry.practitionerPref !== slot.practitioner) {
    return false;
  }
  // The freed slot must be long enough for what the patient needs.
  if (slot.durationMin > 0 && entry.durationMin > slot.durationMin) return false;
  // Honour the patient's acceptable time window, if set.
  const start = new Date(slot.startAt).getTime();
  if (entry.earliestAt && start < new Date(entry.earliestAt).getTime()) return false;
  if (entry.latestAt && start > new Date(entry.latestAt).getTime()) return false;
  return true;
}

/**
 * Best candidate for a freed slot: the longest-waiting eligible entry, or null.
 * `excludeIds` skips entries already offered this slot (declined/expired).
 */
export function pickCandidate(
  entries: WaitlistEntry[],
  slot: FreedSlot,
  excludeIds: Set<string> = new Set(),
): WaitlistEntry | null {
  // The slot offer is sent by SMS, so only consider candidates who consent to SMS;
  // otherwise we would text someone who never opted in. Skips to the next in line.
  const eligible = entries.filter(
    (e) => !excludeIds.has(e.id) && e.consent?.sms === true && matches(e, slot),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return eligible[0];
}
