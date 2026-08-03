// ---------------------------------------------------------------------------
// A payment as the ALLOCATION report needs it: with its explanations[] legs.
//
// This is a PARALLEL normaliser to `normalisePayment` in
// src/lib/dashboard/normalise.ts, deliberately NOT an extension of it. The takings
// strip, the daily rollup and the debtors panel all consume `DashboardPayment`;
// widening that row to carry allocation legs would put a report-shaped concern in
// the hot path of every dashboard read. The two share their money and day grammar
// (parseMoneyPence, isDayKey) and nothing else.
//
// PROVENANCE — read-only GETs against api.dentally.co on 2026-08-03, 2,052
// payments across the 60 days to that date:
//
//   - `explanations[]` is present on every payment row; each entry carries
//     { id, amount, comments, invoice_id, invoice_reference, payment_id,
//       payment_reference, user_id }.
//   - 1,777/2,052 (86.6%) carried at least one explanation.
//   - `fully_explained: true` on 1,712/2,052 (83.4%).
//   - Σ explanations[].amount == payment.amount on 1,713/2,052.
//
// THOSE LAST TWO NUMBERS DISAGREE BY ONE ROW, and that is why this module carries
// `amountUnexplainedPence` as a REPORTED FIELD and never as arithmetic. The report
// derives the unexplained residual from the legs it actually processed
// (amount − Σ legs), so the "no money vanishes" identity is closed by construction
// rather than by trusting two Dentally fields to agree with each other. They
// measurably do not.
//
// A leg whose amount cannot be read DROPS THE WHOLE PAYMENT (and is counted), it
// does not drop the leg: dropping one leg would move real, allocated money into
// the report's "Not allocated in Dentally" row, which is a lie about the practice
// rather than about the read. The house contract holds — null means DROP AND
// COUNT, never "treat as zero".
//
// Pure functions only: no I/O, no clock reads.
// ---------------------------------------------------------------------------

import { parseMoneyPence } from "@/lib/dashboard/money";
import { isDayKey } from "@/lib/dashboard/period";
import type { NormaliseResult } from "@/lib/dashboard/normalise";

/** One allocation leg: money from this payment settling one invoice. */
export interface AllocationExplanation {
  /** The invoice this leg settled, or null when Dentally recorded none (1.75% of money). */
  invoiceId: string | null;
  /** Whole pence of the payment allocated by this leg. Negative on a refund. */
  amountPence: number;
}

/** A payment with everything the allocation report reads off it. */
export interface AllocationPayment {
  id: string;
  /** The practice's own calendar day, from `dated_on`. */
  day: string;
  /** Whole pence received. Negative for a refund. */
  amountPence: number;
  /**
   * Dentally's own `amount_unexplained`, REPORTED ONLY. Null when the field was
   * absent or unreadable. Never used to compute a bucket — see the header.
   */
  amountUnexplainedPence: number | null;
  /** Dentally's own `fully_explained`. Reported only, for the same reason. */
  fullyExplained: boolean | null;
  siteId: string | null;
  patientId: string | null;
  /**
   * The practitioner on the PAYMENT record — who took the money, which measurably
   * differs from the treating clinician on 7.0% of legs. The report attributes by
   * the INVOICE LINE and uses this only to count and surface the disagreement.
   */
  paymentPractitionerId: string | null;
  /** Dentally's soft-delete flag. Deleted payments are excluded and counted. */
  deleted: boolean;
  explanations: AllocationExplanation[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Normalise one /v1/payments record for the allocation report.
 *
 * Returns null — DROP AND COUNT — when the row's id, amount or day is unreadable,
 * or when ANY explanation leg carries an unreadable amount. A payment with no
 * `explanations` key at all is NOT a failure: it reads as zero legs, which the
 * report shows as fully unallocated. That is exactly what Dentally means by it.
 */
export function normaliseAllocationPayment(raw: unknown): AllocationPayment | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const id = asId(r["id"]);
  if (id === null) return null;
  const amountPence = parseMoneyPence(r["amount"]);
  if (amountPence === null) return null;
  const day = r["dated_on"];
  if (!isDayKey(day)) return null;

  const rawLegs = r["explanations"];
  const explanations: AllocationExplanation[] = [];
  if (Array.isArray(rawLegs)) {
    for (const rawLeg of rawLegs) {
      const leg = asRecord(rawLeg);
      if (leg === null) return null;
      const legPence = parseMoneyPence(leg["amount"]);
      if (legPence === null) return null;
      explanations.push({ invoiceId: asId(leg["invoice_id"]), amountPence: legPence });
    }
  } else if (rawLegs !== undefined && rawLegs !== null) {
    // Present but not an array: a shape we do not understand. Refuse it rather
    // than read it as "no allocation", which would move real money into the
    // unallocated row.
    return null;
  }

  const unexplainedRaw = r["amount_unexplained"];
  const fullyExplained = r["fully_explained"];

  return {
    id,
    day,
    amountPence,
    amountUnexplainedPence:
      unexplainedRaw === undefined || unexplainedRaw === null ? null : parseMoneyPence(unexplainedRaw),
    fullyExplained: typeof fullyExplained === "boolean" ? fullyExplained : null,
    siteId: asId(r["site_id"]),
    patientId: asId(r["patient_id"]),
    paymentPractitionerId: asId(r["practitioner_id"]),
    deleted: r["deleted"] === true,
    explanations,
  };
}

export function normaliseAllocationPayments(
  raw: readonly unknown[],
): NormaliseResult<AllocationPayment> {
  const rows: AllocationPayment[] = [];
  let dropped = 0;
  for (const item of raw) {
    const row = normaliseAllocationPayment(item);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  return { rows, dropped };
}

/** Whole pence this payment's legs allocate, summed. */
export function explainedPence(payment: AllocationPayment): number {
  return payment.explanations.reduce((total, leg) => total + leg.amountPence, 0);
}

/**
 * The part of a payment no leg accounts for, DERIVED from the legs this report
 * actually processed rather than read from Dentally's `amount_unexplained`. The
 * two disagree on live data (1,712 vs 1,713 of 2,052 rows), and only the derived
 * figure closes the no-money-vanishes identity.
 *
 * Can be negative when the legs over-explain the payment; that is surfaced, not
 * clamped, because clamping would invent money.
 */
export function derivedUnexplainedPence(payment: AllocationPayment): number {
  return payment.amountPence - explainedPence(payment);
}

/** Distinct, non-null invoice ids across a batch of payments' legs, in first-seen order. */
export function distinctInvoiceIds(payments: readonly AllocationPayment[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const payment of payments) {
    for (const leg of payment.explanations) {
      if (leg.invoiceId === null || seen.has(leg.invoiceId)) continue;
      seen.add(leg.invoiceId);
      ids.push(leg.invoiceId);
    }
  }
  return ids;
}
