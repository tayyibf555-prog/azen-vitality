// ---------------------------------------------------------------------------
// UDAs: "Your UDAs" and "Total UDAs", each as completed and invalid.
//
// Plus the one addition the owner approved on this panel: progress against the
// annual contract target, with pace. Dentally shows the count but never whether
// the practice is on track, and an NHS clawback at year end is the number that
// actually matters to her. Same position, one extra line.
//
// Two deliberate decisions, both because guessing here is expensive:
//
//   1. `claim_status` is a Dentally vocabulary, and only "submitted" is verified
//      against the live API. So the INVALID set is an explicit, injectable list
//      with a documented default, and any status outside the recognised sets is
//      reported in `unknownStatuses` rather than being filed as valid. An
//      unrecognised status counts toward NEITHER completed nor invalid, so it
//      cannot inflate the figure the contract is measured against.
//   2. Completed UDAs are the AWARDED figure, not the expected one. Expected is
//      what the practice asked for; awarded is what the contract credits. Invalid
//      UDAs are the expected figure on rejected claims, which is the work at risk.
//
// UDA arithmetic runs in whole hundredths, then converts once at the boundary,
// so summing tens of thousands of "1.56" values does not drift.
//
// Pure functions only: callers pass `now`.
// ---------------------------------------------------------------------------

import { hundredthsToUda, round2 } from "@/lib/dashboard/money";
import type { DashboardNhsClaim } from "@/lib/dashboard/normalise";
import {
  dayKeyDiff,
  isDayInWindow,
  londonToday,
  type DayWindow,
} from "@/lib/dashboard/period";

/** Reduce a claim status to a comparable key. */
export function claimStatusKey(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Statuses that mean the claim will not be credited. Overridable per contract. */
export const DEFAULT_INVALID_STATUSES: readonly string[] = [
  "invalid",
  "rejected",
  "failed",
  "returned",
  "error",
  "cancelled",
  "deleted",
];

/** Statuses that mean the claim counts toward the contract. */
export const DEFAULT_VALID_STATUSES: readonly string[] = [
  "submitted",
  "approved",
  "accepted",
  "scheduled",
  "paid",
  "closed",
  "complete",
  "completed",
];

export interface UdaTotals {
  /** Awarded UDAs on claims that count. */
  completedUda: number;
  /** Expected UDAs on claims that will not be credited. */
  invalidUda: number;
  claimCount: number;
  invalidClaimCount: number;
  /** Claims whose status matched neither set: counted nowhere, reported here. */
  unrecognisedClaimCount: number;
  unknownStatuses: string[];
}

export interface UdaTotalsInput {
  claims: readonly DashboardNhsClaim[];
  /** Restrict to a window, or omit for every claim supplied. */
  window?: DayWindow | null;
  siteId?: string | null;
  practitionerId?: string | null;
  invalidStatuses?: readonly string[];
  validStatuses?: readonly string[];
}

function scopeClaims(input: UdaTotalsInput): DashboardNhsClaim[] {
  const siteId = input.siteId ?? null;
  const practitionerId = input.practitionerId ?? null;
  const window = input.window ?? null;
  return input.claims.filter((c) => {
    if (siteId !== null && c.siteId !== siteId) return false;
    if (practitionerId !== null && c.practitionerId !== practitionerId) return false;
    if (window !== null) {
      // A claim with no submitted date cannot be placed in a window, so it is
      // excluded from a windowed total rather than assumed to be inside it.
      if (c.day === null || !isDayInWindow(c.day, window)) return false;
    }
    return true;
  });
}

/** Practice-wide (or site-wide, or practitioner-wide) UDA totals. */
export function computeUdaTotals(input: UdaTotalsInput): UdaTotals {
  const invalid = new Set((input.invalidStatuses ?? DEFAULT_INVALID_STATUSES).map(claimStatusKey));
  const valid = new Set((input.validStatuses ?? DEFAULT_VALID_STATUSES).map(claimStatusKey));

  let completedHundredths = 0;
  let invalidHundredths = 0;
  let claimCount = 0;
  let invalidClaimCount = 0;
  let unrecognisedClaimCount = 0;
  const unknown = new Set<string>();

  for (const c of scopeClaims(input)) {
    const key = claimStatusKey(c.status);
    if (invalid.has(key)) {
      invalidHundredths += c.expectedUdaHundredths;
      invalidClaimCount += 1;
      continue;
    }
    if (valid.has(key)) {
      completedHundredths += c.awardedUdaHundredths;
      claimCount += 1;
      continue;
    }
    unrecognisedClaimCount += 1;
    unknown.add(c.status);
  }

  return {
    completedUda: hundredthsToUda(completedHundredths),
    invalidUda: hundredthsToUda(invalidHundredths),
    claimCount,
    invalidClaimCount,
    unrecognisedClaimCount,
    unknownStatuses: [...unknown].sort(),
  };
}

export interface PractitionerUdaTotals extends UdaTotals {
  /** Null for claims carrying no practitioner id, which are grouped together. */
  practitionerId: string | null;
}

/**
 * UDA totals broken down by practitioner: "Your UDAs" is one row of this, and
 * the whole list is what an associate's own figure is checked against.
 * Ordered by completed UDAs descending, then by id, so the list is stable.
 */
export function computeUdaByPractitioner(input: UdaTotalsInput): PractitionerUdaTotals[] {
  const byPractitioner = new Map<string | null, DashboardNhsClaim[]>();
  for (const c of scopeClaims(input)) {
    const list = byPractitioner.get(c.practitionerId);
    if (list) list.push(c);
    else byPractitioner.set(c.practitionerId, [c]);
  }

  const rows = [...byPractitioner.entries()].map(([practitionerId, claims]) => ({
    practitionerId,
    // Scoping is already applied; re-running it over the subset is a no-op.
    ...computeUdaTotals({ ...input, claims }),
  }));

  rows.sort((a, b) => {
    if (b.completedUda !== a.completedUda) return b.completedUda - a.completedUda;
    const idA = a.practitionerId ?? "";
    const idB = b.practitionerId ?? "";
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
  return rows;
}

// --- Progress and pace against the annual contract --------------------------

/** An NHS dental contract year: 1 April to 31 March. */
export interface ContractYear {
  start: string;
  end: string;
}

/** The contract year containing `now`, in Europe/London terms. */
export function nhsContractYear(now: Date): ContractYear {
  const today = londonToday(now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    start: `${String(startYear).padStart(4, "0")}-04-01`,
    end: `${String(startYear + 1).padStart(4, "0")}-03-31`,
  };
}

export interface UdaProgress {
  contractYear: ContractYear;
  /** The annual contracted UDA target, as passed in. */
  targetUda: number;
  completedUda: number;
  /** Completed as a percentage of the annual target. */
  percentOfTarget: number;
  daysElapsed: number;
  daysTotal: number;
  daysRemaining: number;
  /** Where a perfectly even year would be by today. */
  expectedUdaByNow: number;
  /** Completed minus expected. Negative is behind. */
  varianceUda: number;
  /** Achieved UDAs per elapsed day. */
  paceUdaPerDay: number;
  /** UDAs per remaining day needed to hit target. Null once the year has ended. */
  requiredUdaPerDay: number | null;
  /** Year-end total if today's pace holds. */
  projectedYearEndUda: number;
  /** Projected shortfall against target, 0 when projected to meet or beat it. */
  projectedShortfallUda: number;
  /** True when completed is at or above the even-pace expectation. */
  onTrack: boolean;
}

export interface UdaProgressInput {
  /** UDAs completed so far this contract year. */
  completedUda: number;
  /** The annual contracted target. Must be a positive, finite number. */
  targetUda: number;
  now: Date;
  /** Override the contract year, for a practice whose contract runs differently. */
  contractYear?: ContractYear;
}

/**
 * Progress and pace against the annual contract target.
 *
 * Returns null when the target is missing or not positive. There is no sensible
 * fallback: a percentage against an unknown target is a made-up number, and this
 * is the line that tells her whether a clawback is coming.
 */
export function computeUdaProgress(input: UdaProgressInput): UdaProgress | null {
  if (!Number.isFinite(input.targetUda) || input.targetUda <= 0) return null;
  if (!Number.isFinite(input.completedUda)) return null;

  const contractYear = input.contractYear ?? nhsContractYear(input.now);
  const today = londonToday(input.now);

  const span = dayKeyDiff(contractYear.start, contractYear.end);
  if (span === null || span < 0) return null;
  const daysTotal = span + 1;

  const elapsedRaw = dayKeyDiff(contractYear.start, today);
  if (elapsedRaw === null) return null;
  // Clamped: before the year opens it reads as day one, after it closes as the
  // full year, so pace never divides by zero and never exceeds the contract.
  const daysElapsed = Math.min(Math.max(elapsedRaw + 1, 1), daysTotal);
  const daysRemaining = daysTotal - daysElapsed;

  const expectedUdaByNow = (input.targetUda * daysElapsed) / daysTotal;
  const paceUdaPerDay = input.completedUda / daysElapsed;
  const projectedYearEndUda = paceUdaPerDay * daysTotal;
  const shortfall = input.targetUda - input.completedUda;

  return {
    contractYear,
    targetUda: input.targetUda,
    completedUda: input.completedUda,
    percentOfTarget: round2((input.completedUda / input.targetUda) * 100),
    daysElapsed,
    daysTotal,
    daysRemaining,
    expectedUdaByNow: round2(expectedUdaByNow),
    varianceUda: round2(input.completedUda - expectedUdaByNow),
    paceUdaPerDay: round2(paceUdaPerDay),
    requiredUdaPerDay: daysRemaining > 0 ? round2(Math.max(shortfall, 0) / daysRemaining) : null,
    projectedYearEndUda: round2(projectedYearEndUda),
    projectedShortfallUda: round2(Math.max(input.targetUda - projectedYearEndUda, 0)),
    onTrack: input.completedUda >= expectedUdaByNow,
  };
}
