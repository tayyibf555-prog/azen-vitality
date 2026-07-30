// ---------------------------------------------------------------------------
// The takings strip: TODAY / YESTERDAY / LAST 7 DAYS / LAST 30 DAYS / LAST 90
// DAYS, each a money total with an appointment count beneath it.
//
// Why this file is shaped around "coverage":
//
// Dentally IGNORES every date filter on /v1/payments (filter[from], from and
// dated_on_from all return the full 40,243 rows) and returns newest first. It
// does honour site_id. So the only honest way to total a period live is to page
// from today backwards and stop once past the boundary. That is cheap for today
// and yesterday, and far too slow on a page load for ninety days.
//
// Which means a caller will sometimes hand us a set that only reaches back a
// fortnight. Totalling that set for "last 90 days" would print a real-looking
// number that is simply wrong, and a wrong takings figure is worse than a blank
// one. So the caller declares how far back its scan genuinely reached, and any
// period reaching further back is reported as unavailable with a reason.
//
// The long periods are meant to be served from the stored daily rollup instead,
// via computeTakingsStripFromRollup, which applies the same rule: every day of
// every site in the window must be present and complete, or the cell is blank.
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
}

const NO_PAYMENT_DATA = "Takings unavailable for this period.";
const SHORT_SCAN = "Takings unavailable: the live scan does not reach back this far.";
const NO_APPOINTMENT_DATA = "Appointment count unavailable for this period.";

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

    if (!input.paymentsCoverage) {
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
