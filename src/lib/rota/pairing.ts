import { isLiveShift, resolvePairRoles, type RotaConfig, type RotaShift } from "./types";

// ---------------------------------------------------------------------------
// Who works with whom.
//
// The generator fills each coverage role INDEPENDENTLY: it books a dentist and it
// books a nurse and it never forms an opinion about whether those two are working
// together. On a real surgery floor that is the first question anybody asks, so the
// pairing has to be a fact the system holds rather than something the team works
// out in the morning.
//
// DETERMINISTIC, and that matters more than being clever. The same day's shifts
// always produce the same pairing, so re-running this after a regeneration does not
// reshuffle who is with whom for no reason. Sorting by staff id (not by name, which
// changes when somebody marries) is what makes that true.
//
// LEAVE UNPAIRED RATHER THAN INVENT A PAIRING. Three dentists and two nurses means
// one dentist has no nurse, and saying so is useful; quietly giving a nurse to two
// dentists is a lie that reads as a staffed day.
// ---------------------------------------------------------------------------

/** One shift and the partner it should be pointed at. */
export interface PairAssignment {
  shiftId: string;
  staffId: string;
  pairedStaffId: string;
}

/** Sort key that is stable across runs and independent of load order. */
function bySiteThenStaff(a: RotaShift, b: RotaShift): number {
  return a.siteId.localeCompare(b.siteId) || a.staffId.localeCompare(b.staffId);
}

/**
 * Pair one day's shifts, clinician to support, per site.
 *
 * Returns assignments for BOTH halves of every pair, so a caller applies the change
 * to two rows and the pairing is mutual by construction. A one-way pairing is a
 * violation (`pairingViolations`), so producing one here would be producing a bug.
 *
 * Shifts already carrying a pairing that still holds are left ALONE and are not
 * re-emitted: whoever set it meant it, and re-deriving it every run would overwrite
 * a manager's deliberate pairing with the alphabetical one. A pairing pointing at
 * somebody not working that day is treated as stale and re-derived.
 */
export function autoPair(dayShifts: RotaShift[], config: RotaConfig): PairAssignment[] {
  const pair = resolvePairRoles(config);
  if (!pair) return [];

  const live = dayShifts.filter((s) => isLiveShift(s) && s.id !== undefined);
  const workingToday = new Set(live.map((s) => s.staffId));

  /** A pairing is honoured only when it is mutual AND both people are actually in. */
  const holds = (shift: RotaShift): boolean => {
    const partnerId = shift.pairedStaffId ?? null;
    if (!partnerId || !workingToday.has(partnerId)) return false;
    const partner = live.find((s) => s.staffId === partnerId);
    return Boolean(partner && partner.siteId === shift.siteId && (partner.pairedStaffId ?? null) === shift.staffId);
  };

  const clinicians = live.filter((s) => s.role === pair.clinical && !holds(s)).sort(bySiteThenStaff);
  const supports = live.filter((s) => s.role === pair.support && !holds(s)).sort(bySiteThenStaff);

  // Support staff still available, bucketed by site: nobody is paired across sites,
  // because they would not be in the same room.
  const availableBySite = new Map<string, RotaShift[]>();
  for (const s of supports) {
    const list = availableBySite.get(s.siteId);
    if (list) list.push(s);
    else availableBySite.set(s.siteId, [s]);
  }

  const out: PairAssignment[] = [];
  for (const clinician of clinicians) {
    const pool = availableBySite.get(clinician.siteId);
    if (!pool || pool.length === 0) continue; // no nurse left at this site: leave them unpaired
    const partner = pool.shift()!;
    out.push({ shiftId: clinician.id!, staffId: clinician.staffId, pairedStaffId: partner.staffId });
    out.push({ shiftId: partner.id!, staffId: partner.staffId, pairedStaffId: clinician.staffId });
  }
  return out;
}

/**
 * The people left without a partner after pairing, as staff ids.
 *
 * Reported so the grid can show it plainly. A day where a dentist has no nurse is
 * not an error and must not be presented as one, but it is the single thing a
 * practice manager most wants to see before the day starts.
 */
export function unpairedAfter(
  dayShifts: RotaShift[],
  assignments: PairAssignment[],
  config: RotaConfig,
): string[] {
  const pair = resolvePairRoles(config);
  if (!pair) return [];
  const assigned = new Set(assignments.map((a) => a.staffId));
  return dayShifts
    .filter(
      (s) =>
        isLiveShift(s) &&
        (s.role === pair.clinical || s.role === pair.support) &&
        !assigned.has(s.staffId) &&
        !(s.pairedStaffId ?? null),
    )
    .map((s) => s.staffId)
    .sort();
}
