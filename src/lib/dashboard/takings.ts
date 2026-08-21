// ---------------------------------------------------------------------------
// The takings strip: TODAY / YESTERDAY / LAST 7 DAYS / LAST 30 DAYS / LAST 90
// DAYS, each a money total with an appointment count beneath it.
//
// THERE ARE TWO WAYS TO TOTAL A PERIOD HERE, AND ONE OF THEM IS EXACT.
//
// THE EXACT ONE — `windowTotals`. /v1/payments takes `start_date` and `end_date`
// (both inclusive, both on `dated_on`) and answers with meta.total_amount, the
// exact sum of the window, and meta.total, its exact row count. One request per
// site per period. Verified by live read-only probe on 2026-08-21; the parameter
// names and the arithmetic traps are recorded on listPayments in
// src/lib/dentally/client.ts. When the caller supplies windowTotals, the money on
// this strip IS Dentally's own aggregate — the same number the practice reads off
// Dentally — and no row order, page budget or coverage span can shorten it.
//
// THE OLD ONE — `payments` + `paymentsCoverage`. It totals rows the caller
// scanned, and it is kept for the callers that have rows (fixtures, the rollup
// path, anything holding a normalised set already). It is NOT the live path any
// more, and this is why:
//
//   The file used to state that "Dentally IGNORES every date filter on
//   /v1/payments ... and returns newest first", so the only honest total was to
//   page backwards from today until past the boundary. BOTH HALVES WERE FALSE.
//   The filter works, and the rows are ordered by id, not by date, so a backdated
//   payment sits wherever its id falls — on site N15 page 20 spans 2023 to 2026.
//   A backwards walk therefore stopped early AND skipped in-window rows deeper in
//   the index, while the coverage span it reported claimed the window was fully
//   covered. The practice owner found the result: last 30 days read £16,997.10
//   against Dentally's £27,240.90, and last 90 days £17,012.10 against
//   £114,429.78. Today and last-7 looked right only because the newest payments
//   happen to cluster on page 1.
//
// Coverage still does its job on the row path: a set that only reaches back a
// fortnight must not be totalled for ninety days, because a wrong takings figure
// is worse than a blank one. It just no longer has to carry the live path.
//
// The stored daily rollup remains a third source, via
// computeTakingsStripFromRollup, and applies the same rule: every day of every
// site in the window must be present and complete, or the cell is blank.
//
// Pure functions only: no I/O, callers pass `now`.
// ---------------------------------------------------------------------------

import type { DashboardAppointment, DashboardPayment, NormaliseResult } from "@/lib/dashboard/normalise";
import {
  coversWindow,
  daysInWindow,
  isDayInWindow,
  isDayKey,
  periodWindow,
  DASHBOARD_PERIODS,
  type DashboardPeriod,
  type DayCoverage,
  type DayWindow,
} from "@/lib/dashboard/period";

/**
 * The EXACT money and count for ONE site over ONE period, read from Dentally's own
 * aggregate (`meta.total_amount` / `meta.total` on a `start_date`+`end_date` query).
 *
 * Per SITE and not per group, because the group total has to be able to tell
 * "every site answered" from "two sites answered and one read failed" — summing
 * whatever arrived would understate the practice by a whole site in silence, which
 * is the exact failure mode this whole change exists to remove.
 */
export interface TakingsWindowTotal {
  /** Whole pence taken in the window at this site. A real zero is a real answer. */
  totalPence: number;
  /** Payments counted in that total. */
  paymentCount: number;
}

/** Keyed by takingsWindowKey(siteId, period). A missing key means UNREAD, not zero. */
export type TakingsWindowTotals = ReadonlyMap<string, TakingsWindowTotal>;

/** The key a per-site, per-period total is filed under. */
export function takingsWindowKey(siteId: string, period: DashboardPeriod): string {
  return `${siteId}|${period}`;
}

/** One cell of the strip. A null figure means "not sourceable", never zero. */
export interface TakingsCell {
  period: DashboardPeriod;
  window: DayWindow;
  /** Whole pence taken in the window, or null when it cannot be sourced. */
  totalPence: number | null;
  /** Payments counted toward the total, or null when the total is unavailable. */
  paymentCount: number | null;
  /** Appointments in the window, or null when it cannot be sourced. */
  appointmentCount: number | null;
  /** Plain British English reason the money total is missing, for the panel to show. */
  unavailableReason: string | null;
  /** Plain British English reason the appointment count is missing. Tracked apart
   *  from the money, because one can be sourceable while the other is not. */
  appointmentUnavailableReason: string | null;
}

export interface TakingsStrip {
  cells: TakingsCell[];
  /** Payment records the normaliser could not read at all. */
  droppedPayments: number;
  /** Readable payments with no site_id, which a per-site view cannot attribute. */
  unattributedPayments: number;
  /** Deleted payments excluded from every total. */
  deletedPayments: number;
  /** The site the strip is scoped to, or null for all sites. */
  siteId: string | null;
}

export interface TakingsStripInput {
  /** Normalised payments, newest-first or otherwise; order is irrelevant here. */
  payments: readonly DashboardPayment[];
  /** How far back the payment scan genuinely reached. Null means nothing is sourceable. */
  paymentsCoverage: DayCoverage | null;
  /** Rows the payment normaliser dropped, carried through for the panel to disclose. */
  paymentsDropped?: number;
  /** Normalised appointments, or null when the caller could not fetch them. */
  appointments?: readonly DashboardAppointment[] | null;
  appointmentsCoverage?: DayCoverage | null;
  now: Date;
  /** Scope to one site, or null/undefined for the whole group (the all-sites toggle). */
  siteId?: string | null;
  periods?: readonly DashboardPeriod[];
  /**
   * EXACT per-site, per-period totals from Dentally's own aggregate. When present,
   * these ARE the money on the strip and `payments`/`paymentsCoverage` are not
   * consulted for it at all.
   */
  windowTotals?: TakingsWindowTotals | null;
  /**
   * TRUE when the PLATFORM declined to make the reads at all — the shared Dentally
   * budget guard refused the assembly (see refusedDashboardView in
   * src/lib/dashboard/read.ts).
   *
   * It exists because a refusal arrives here looking exactly like a site outage: an
   * empty `windowTotals` with sites in scope, which the branch below reads as "one of
   * your practices could not be read". That sentence sends a practice manager to ring
   * a surgery about a fault that is ours and is already over — nothing is wrong with
   * her practices, the platform paused its own reads for a moment. Checked BEFORE the
   * exact and row paths, because when it is set there is nothing to check them
   * against: no read was made.
   */
  refused?: boolean;
  /**
   * Every site the current scope covers. REQUIRED alongside windowTotals for the
   * all-sites scope, and it is what makes a missing site detectable: without the
   * list, "site-rv's read failed" and "site-rv took nothing" are the same empty
   * map, and the group total would quietly drop a practice.
   */
  siteIdsInScope?: readonly string[];
}

const NO_PAYMENT_DATA = "Takings unavailable for this period.";
const SHORT_SCAN = "Takings unavailable: the live scan does not reach back this far.";
const NO_APPOINTMENT_DATA = "Appointment count unavailable for this period.";
/**
 * A site in the scope did not answer, so the group total would be short by a whole
 * practice. Named for the SITE, not for the period, because that is the fact the
 * practice manager needs: the figure is not late or partial, one of her practices
 * is missing from it.
 *
 * TWO SENTENCES, BECAUSE THE SCOPE HAS TWO SHAPES. "One of the sites in this view"
 * is plainly wrong on a single-site scope, where there is only ever one site and it
 * is the one she is looking at; read on that screen it implies some other practice
 * is at fault and hers is fine.
 */
const SITE_UNREAD = "Takings unavailable: one of the sites in this view could not be read.";
const ONLY_SITE_UNREAD = "Takings unavailable: this site could not be read.";
/**
 * The PLATFORM refused to make the read — see `refused` on TakingsStripInput. Worded
 * as what it is: temporary, ours, and about to fix itself.
 */
const READS_PAUSED =
  "Takings unavailable: live reads were paused for a moment; this will refresh shortly.";

/**
 * Build the five-cell strip from a live payment scan.
 *
 * Deleted payments are excluded. Refunds (negative amounts) are kept, because a
 * refund genuinely reduces the day's takings. When scoped to one site, payments
 * carrying no site_id are excluded and counted separately rather than being
 * quietly folded into that site's total.
 */
export function computeTakingsStrip(input: TakingsStripInput): TakingsStrip {
  const siteId = input.siteId ?? null;
  const periods = input.periods ?? DASHBOARD_PERIODS;
  const windowTotals = input.windowTotals ?? null;
  // Which sites this scope has to hear from before it may state a number. One site
  // scope: that site. Group scope: every site the caller says is in it — and if the
  // caller named none, the group cannot be verified as whole, so it states nothing.
  const sitesInScope: readonly string[] =
    siteId !== null ? [siteId] : input.siteIdsInScope ?? [];

  let unattributedPayments = 0;
  let deletedPayments = 0;
  const usable: DashboardPayment[] = [];
  for (const p of input.payments) {
    if (p.deleted) {
      deletedPayments += 1;
      continue;
    }
    if (siteId !== null) {
      if (p.siteId === null) {
        unattributedPayments += 1;
        continue;
      }
      if (p.siteId !== siteId) continue;
    }
    usable.push(p);
  }

  const appointments = input.appointments ?? null;
  const scopedAppointments =
    appointments === null
      ? null
      : siteId === null
        ? appointments
        : appointments.filter((a) => a.siteId === siteId);

  const cells = periods.map((period): TakingsCell => {
    const window = periodWindow(period, input.now);

    let totalPence: number | null = null;
    let paymentCount: number | null = null;
    let unavailableReason: string | null = null;

    if (input.refused === true) {
      // BEFORE EVERYTHING ELSE. No read was attempted, so neither the exact path nor
      // the row path has anything to say about this cell — and both of them would
      // blame the practice's own data for the platform's decision.
      unavailableReason = READS_PAUSED;
    } else if (windowTotals !== null) {
      // THE EXACT PATH. Dentally's own aggregate for this exact window, summed over
      // the sites in scope. Every site must be present: a partial sum is the bug.
      let sum = 0;
      let count = 0;
      let whole = sitesInScope.length > 0;
      for (const site of sitesInScope) {
        const total = windowTotals.get(takingsWindowKey(site, period));
        if (total === undefined) {
          whole = false;
          break;
        }
        sum += total.totalPence;
        count += total.paymentCount;
      }
      if (whole) {
        totalPence = sum;
        paymentCount = count;
      } else {
        unavailableReason =
          sitesInScope.length === 0
            ? NO_PAYMENT_DATA
            : sitesInScope.length === 1
              ? ONLY_SITE_UNREAD
              : SITE_UNREAD;
      }
    } else if (!input.paymentsCoverage) {
      unavailableReason = NO_PAYMENT_DATA;
    } else if (!coversWindow(input.paymentsCoverage, window)) {
      unavailableReason = SHORT_SCAN;
    } else {
      let sum = 0;
      let count = 0;
      for (const p of usable) {
        if (!isDayInWindow(p.day, window)) continue;
        sum += p.amountPence;
        count += 1;
      }
      totalPence = sum;
      paymentCount = count;
    }

    let appointmentCount: number | null = null;
    let appointmentUnavailableReason: string | null = NO_APPOINTMENT_DATA;
    if (scopedAppointments !== null && coversWindow(input.appointmentsCoverage ?? null, window)) {
      appointmentCount = scopedAppointments.filter((a) => isDayInWindow(a.day, window)).length;
      appointmentUnavailableReason = null;
    }

    return {
      period,
      window,
      totalPence,
      paymentCount,
      appointmentCount,
      unavailableReason,
      appointmentUnavailableReason,
    };
  });

  return {
    cells,
    droppedPayments: input.paymentsDropped ?? 0,
    unattributedPayments,
    deletedPayments,
    siteId,
  };
}

// --- The stored daily rollup ------------------------------------------------

/**
 * One row of dashboard_daily_rollup: one site, one London day.
 * `sourceComplete` records whether the day was built from a scan that genuinely
 * reached the whole day. An incomplete day is never summed.
 */
export interface DashboardRollupDay {
  siteId: string;
  day: string;
  takingsPence: number;
  paymentCount: number;
  appointmentsTotal: number;
  appointmentsCompleted: number;
  appointmentsCancelled: number;
  appointmentsDna: number;
  udaCompletedHundredths: number;
  udaInvalidHundredths: number;
  sourceComplete: boolean;
  /** Diagnostic counters. Never summed into a headline figure; they exist so a
   *  day that quietly lost rows can be spotted and rebuilt. Default to 0 when
   *  the row predates them. */
  paymentsDropped: number;
  appointmentsUnrecognised: number;
  nhsClaimCount: number;
  nhsClaimsUnrecognised: number;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Normalise one rollup row. A row missing any counted column is dropped, not zeroed. */
export function normaliseRollupDay(raw: unknown): DashboardRollupDay | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const siteId = typeof r["site_id"] === "string" ? r["site_id"] : null;
  const day = r["day"];
  if (siteId === null || siteId.length === 0 || !isDayKey(day)) return null;

  const takingsPence = asInt(r["takings_pence"]);
  const paymentCount = asInt(r["payment_count"]);
  const appointmentsTotal = asInt(r["appointments_total"]);
  const appointmentsCompleted = asInt(r["appointments_completed"]);
  const appointmentsCancelled = asInt(r["appointments_cancelled"]);
  const appointmentsDna = asInt(r["appointments_dna"]);
  const udaCompletedHundredths = asInt(r["uda_completed_hundredths"]);
  const udaInvalidHundredths = asInt(r["uda_invalid_hundredths"]);
  if (
    takingsPence === null ||
    paymentCount === null ||
    appointmentsTotal === null ||
    appointmentsCompleted === null ||
    appointmentsCancelled === null ||
    appointmentsDna === null ||
    udaCompletedHundredths === null ||
    udaInvalidHundredths === null
  ) {
    return null;
  }

  return {
    siteId,
    day,
    takingsPence,
    paymentCount,
    appointmentsTotal,
    appointmentsCompleted,
    appointmentsCancelled,
    appointmentsDna,
    udaCompletedHundredths,
    udaInvalidHundredths,
    sourceComplete: r["source_complete"] === true,
    paymentsDropped: asInt(r["payments_dropped"]) ?? 0,
    appointmentsUnrecognised: asInt(r["appointments_unrecognised"]) ?? 0,
    nhsClaimCount: asInt(r["nhs_claim_count"]) ?? 0,
    nhsClaimsUnrecognised: asInt(r["nhs_claims_unrecognised"]) ?? 0,
  };
}

export function normaliseRollupDays(raw: readonly unknown[]): NormaliseResult<DashboardRollupDay> {
  const rows: DashboardRollupDay[] = [];
  let dropped = 0;
  for (const item of raw) {
    const row = normaliseRollupDay(item);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  return { rows, dropped };
}

export interface RollupStripInput {
  rollups: readonly DashboardRollupDay[];
  /**
   * Every site the strip is meant to cover. Required, because "all sites" can
   * only be trusted if we know which sites should have contributed a row: a
   * missing site would otherwise silently understate the group total.
   */
  siteIds: readonly string[];
  now: Date;
  /** Scope to one site, or null for all of `siteIds`. */
  siteId?: string | null;
  periods?: readonly DashboardPeriod[];
}

const ROLLUP_GAP = "Takings unavailable: the daily rollup has not been built for every day yet.";

/**
 * Build the strip from the stored daily rollup, which is how the 7, 30 and 90
 * day cells are served. A period is only reported when every site's row exists
 * and is complete for every day in the window.
 */
export function computeTakingsStripFromRollup(input: RollupStripInput): TakingsStrip {
  const siteId = input.siteId ?? null;
  const periods = input.periods ?? DASHBOARD_PERIODS;
  const wantedSites = siteId === null ? input.siteIds : [siteId];

  const byKey = new Map<string, DashboardRollupDay>();
  for (const row of input.rollups) byKey.set(`${row.siteId}|${row.day}`, row);

  const cells = periods.map((period): TakingsCell => {
    const window = periodWindow(period, input.now);
    const days = daysInWindow(window);

    let totalPence = 0;
    let paymentCount = 0;
    let appointmentCount = 0;
    let complete = wantedSites.length > 0 && days.length > 0;

    for (const day of days) {
      for (const site of wantedSites) {
        const row = byKey.get(`${site}|${day}`);
        if (!row || !row.sourceComplete) {
          complete = false;
          break;
        }
        totalPence += row.takingsPence;
        paymentCount += row.paymentCount;
        appointmentCount += row.appointmentsTotal;
      }
      if (!complete) break;
    }

    return complete
      ? {
          period,
          window,
          totalPence,
          paymentCount,
          appointmentCount,
          unavailableReason: null,
          appointmentUnavailableReason: null,
        }
      : {
          period,
          window,
          totalPence: null,
          paymentCount: null,
          appointmentCount: null,
          unavailableReason: ROLLUP_GAP,
          appointmentUnavailableReason: ROLLUP_GAP,
        };
  });

  return { cells, droppedPayments: 0, unattributedPayments: 0, deletedPayments: 0, siteId };
}
