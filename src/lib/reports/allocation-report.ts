// ---------------------------------------------------------------------------
// REPORT B, folded: every payment in the window, split into what each clinician
// earned and what nobody can be credited for.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE — NO MONEY VANISHES:
//
//   attributed + unallocatedInDentally + explainedNoInvoiceLink
//     + sharedInvoiceUndetermined + noAttributableLines + linkUnavailable
//     === Σ payment.amountPence in the window
//
// Every bucket is a FIRST-CLASS FIELD and renders as a ROW IN THE SAME TABLE, not
// a footnote. Blerta has to see the whole reconcile on one surface or the report
// is not the thing she pays from: a clinician total that quietly excludes a fifth
// of the money looks exactly like a clinician total that does not.
//
// If the identity ever fails, `balanced` is false and the caller renders the
// report UNAVAILABLE. A total that does not reconcile is worse than no total.
//
// The residual per payment is DERIVED (`amount − Σ legs`), never read from
// Dentally's `amount_unexplained`: those two measurably disagree on live data
// (1,712 vs 1,713 of 2,052 rows). Deriving it is what closes the identity.
//
// Pure functions only: no I/O, no clock reads.
// ---------------------------------------------------------------------------

import { isDayInWindow, windowLength, type DayWindow } from "@/lib/dashboard/period";
import {
  invoiceSundryLineCount,
  type InvoiceWithItems,
} from "@/lib/dentally/invoice-shape";
import {
  splitAllocationLeg,
  type AllocationBasis,
} from "@/lib/reports/allocation-split";
import {
  derivedUnexplainedPence,
  type AllocationPayment,
} from "@/lib/reports/payment-explanations";
import {
  isPayable,
  wiredAllocationConditions,
  type AllocationConditions,
} from "@/lib/reports/payment-allocation";

/** One clinician's attributed total for the window. */
export interface PractitionerAllocationLine {
  practitionerId: string;
  /** Whole pence attributed to this clinician BY THE INVOICE LINE, not by the payment. */
  attributedPence: number;
  /** How many explanation legs contributed. */
  legCount: number;
  /** Which bases produced this line's money, so the chip can say how it was derived. */
  bases: AllocationBasis[];
  conditions: AllocationConditions;
  /** Always false: `closed` cannot be read from Dentally at all (probed 2026-08-03). */
  payableConfirmed: boolean;
}

/** The buckets, in the order they render under the clinician lines. */
export const ALLOCATION_BUCKET_KEYS = [
  "unallocatedInDentally",
  "explainedNoInvoiceLink",
  "sharedInvoiceUndetermined",
  "noAttributableLines",
  "linkUnavailable",
] as const;

export type AllocationBucketKey = (typeof ALLOCATION_BUCKET_KEYS)[number];

/** Rendered VERBATIM as the row's name. Each says what is missing, plainly. */
export const ALLOCATION_BUCKET_LABELS: Record<AllocationBucketKey, string> = {
  unallocatedInDentally: "Not allocated in Dentally",
  explainedNoInvoiceLink: "Paid, but not linked to an invoice",
  sharedInvoiceUndetermined: "Shared invoice, part payment — which clinician is not recorded",
  noAttributableLines: "Invoiced, but no clinician on the invoice lines",
  linkUnavailable: "Could not read the invoice — this money is unaccounted for in this run",
};

/** The second line of each bucket row: why it cannot reach a clinician. */
export const ALLOCATION_BUCKET_NOTES: Record<AllocationBucketKey, string> = {
  unallocatedInDentally:
    "Money the practice received that is not allocated to anything inside Dentally. No report can attribute it — it is a data-entry gap in the practice's own records, not a limit of the API. Measured at 20.6% of the money taken in the 60 days to 3 August 2026.",
  explainedNoInvoiceLink:
    "The payment was allocated in Dentally, but the allocation names no invoice, so there is no line and no clinician to follow it to.",
  sharedInvoiceUndetermined:
    "A part payment against an invoice covering more than one clinician. Dentally records which INVOICE the money settled, never which LINE, so splitting it would invent an allocation the practice never made.",
  noAttributableLines:
    "The invoice was read, but no clinician is recorded against the lines this money paid for. It is never credited to whoever took the payment.",
  linkUnavailable:
    "The invoice could not be read from Dentally on this run, even after a retry. The run is marked incomplete rather than the money being dropped.",
};

export interface AllocationBucketRow {
  key: AllocationBucketKey;
  label: string;
  note: string;
  pence: number;
}

export interface AllocationReport {
  lines: PractitionerAllocationLine[];

  /** Σ of every payment in scope. The figure every bucket must add back up to. */
  totalReceivedPence: number;
  totalCount: number;

  attributedPence: number;
  unallocatedInDentallyPence: number;
  explainedNoInvoiceLinkPence: number;
  sharedInvoiceUndeterminedPence: number;
  noAttributableLinesPence: number;
  linkUnavailablePence: number;

  /** Payments whose payer is not among the clinicians credited (7.0% of legs live). */
  paymentTakerDifferedCount: number;
  refundCount: number;
  deletedExcluded: number;
  unattributedExcluded: number;

  /** Explanation legs seen, and how many walked the full chain to invoice lines. */
  legCount: number;
  legsChainResolved: number;
  /** Legs whose invoice could not be read after a retry. > 0 marks the run incomplete. */
  legsLinkUnavailable: number;
  runIncomplete: boolean;

  basisCounts: Record<AllocationBasis, number>;
  /** Sundry lines on the invoices this report read. 0/256 live — an untested path. */
  sundryLineCount: number;

  /** THE INVARIANT. False means the report must render unavailable, never a total. */
  balanced: boolean;

  conditions: AllocationConditions;
  anyPayableConfirmed: boolean;
  filters: { window: DayWindow | null; siteId: string | null };
}

export interface AllocationReportInput {
  payments: readonly AllocationPayment[];
  /** Invoices successfully read, by id. Anything absent is treated as unreadable. */
  invoices: ReadonlyMap<string, InvoiceWithItems>;
  window?: DayWindow | null;
  siteId?: string | null;
  conditions?: AllocationConditions;
}

/** The longest window this report will run. See the route's fetch budget. */
export const ALLOCATION_MAX_WINDOW_DAYS = 60;

export const ALLOCATION_WINDOW_UNAVAILABLE =
  `Unavailable: this period is longer than ${ALLOCATION_MAX_WINDOW_DAYS} days. Attributing money to a clinician needs one live invoice read per invoice settled in the period, and a longer window cannot be read inside a single request. Choose a shorter period.`;

export const ALLOCATION_IDENTITY_UNAVAILABLE =
  "Unavailable: this run's figures did not reconcile — the clinician totals plus the unattributed rows did not add back up to the money received. A total that does not reconcile is not shown.";

/** True when the window is longer than this report can honestly read in one go. */
export function allocationWindowTooLong(window: DayWindow): boolean {
  return windowLength(window) > ALLOCATION_MAX_WINDOW_DAYS;
}

/**
 * Whether a payment counts toward this run at all: not voided, in the window, and
 * in the selected site. Exported so the READ layer can decide which invoices to
 * spend its fetch budget on using the SAME predicate the report folds by — a read
 * that fetched a different set from the one it totals would burn budget on money
 * the report never shows.
 */
export function inAllocationScope(
  payment: AllocationPayment,
  window: DayWindow | null,
  siteId: string | null,
): boolean {
  if (payment.deleted) return false;
  if (siteId !== null && payment.siteId !== siteId) return false;
  if (window !== null && !isDayInWindow(payment.day, window)) return false;
  return true;
}

function emptyBasisCounts(): Record<AllocationBasis, number> {
  return {
    sole_practitioner: 0,
    pro_rata_full_settlement: 0,
    shared_invoice_part_payment: 0,
    no_attributable_lines: 0,
  };
}

/**
 * Fold the window's payments into clinician lines plus the honesty buckets.
 *
 * Deleted payments are excluded and counted. When scoped to one site, payments
 * with no site are excluded and counted rather than folded in. Refunds (negative)
 * are kept: they genuinely reduce what a clinician earned.
 */
export function computeAllocationReport(input: AllocationReportInput): AllocationReport {
  const window = input.window ?? null;
  const siteId = input.siteId ?? null;
  const conditions = input.conditions ?? wiredAllocationConditions();
  const payable = isPayable(conditions);

  const byPractitioner = new Map<string, { pence: number; legs: number; bases: Set<AllocationBasis> }>();
  const invoicesUsed = new Set<string>();
  const basisCounts = emptyBasisCounts();

  let totalReceivedPence = 0;
  let totalCount = 0;
  let attributedPence = 0;
  let unallocatedInDentallyPence = 0;
  let explainedNoInvoiceLinkPence = 0;
  let sharedInvoiceUndeterminedPence = 0;
  let noAttributableLinesPence = 0;
  let linkUnavailablePence = 0;
  let paymentTakerDifferedCount = 0;
  let refundCount = 0;
  let deletedExcluded = 0;
  let unattributedExcluded = 0;
  let legCount = 0;
  let legsChainResolved = 0;
  let legsLinkUnavailable = 0;

  for (const payment of input.payments) {
    if (payment.deleted) {
      deletedExcluded += 1;
      continue;
    }
    if (siteId !== null && payment.siteId === null) {
      unattributedExcluded += 1;
      continue;
    }
    // The same predicate the read layer spends its invoice budget by.
    if (!inAllocationScope(payment, window, siteId)) continue;

    totalReceivedPence += payment.amountPence;
    totalCount += 1;
    if (payment.amountPence < 0) refundCount += 1;

    // The part of the payment no leg accounts for — derived, never read off
    // `amount_unexplained`, which disagrees with the legs on live data.
    unallocatedInDentallyPence += derivedUnexplainedPence(payment);

    const creditedOnThisPayment = new Set<string>();

    for (const leg of payment.explanations) {
      legCount += 1;

      if (leg.invoiceId === null) {
        explainedNoInvoiceLinkPence += leg.amountPence;
        continue;
      }

      const invoice = input.invoices.get(leg.invoiceId);
      if (invoice === undefined) {
        linkUnavailablePence += leg.amountPence;
        legsLinkUnavailable += 1;
        continue;
      }

      legsChainResolved += 1;
      invoicesUsed.add(invoice.id);

      const split = splitAllocationLeg({ legAmountPence: leg.amountPence, invoice });
      basisCounts[split.basis] += 1;

      for (const attribution of split.attributions) {
        const entry = byPractitioner.get(attribution.practitionerId) ?? {
          pence: 0,
          legs: 0,
          bases: new Set<AllocationBasis>(),
        };
        entry.pence += attribution.pence;
        entry.legs += 1;
        entry.bases.add(split.basis);
        byPractitioner.set(attribution.practitionerId, entry);
        attributedPence += attribution.pence;
        creditedOnThisPayment.add(attribution.practitionerId);
      }

      if (split.residual !== 0) {
        if (split.basis === "shared_invoice_part_payment") {
          sharedInvoiceUndeterminedPence += split.residual;
        } else {
          noAttributableLinesPence += split.residual;
        }
      }
    }

    // The receptionist who took the money is often not the clinician credited.
    // Surfaced as a count, never silently reconciled.
    if (
      payment.paymentPractitionerId !== null &&
      creditedOnThisPayment.size > 0 &&
      !creditedOnThisPayment.has(payment.paymentPractitionerId)
    ) {
      paymentTakerDifferedCount += 1;
    }
  }

  let sundryLineCount = 0;
  for (const id of invoicesUsed) {
    const invoice = input.invoices.get(id);
    if (invoice !== undefined) sundryLineCount += invoiceSundryLineCount(invoice);
  }

  const lines: PractitionerAllocationLine[] = [...byPractitioner.entries()]
    .map(([practitionerId, { pence, legs, bases }]) => ({
      practitionerId,
      attributedPence: pence,
      legCount: legs,
      bases: [...bases],
      conditions,
      payableConfirmed: payable,
    }))
    .sort((a, b) =>
      b.attributedPence !== a.attributedPence
        ? b.attributedPence - a.attributedPence
        : a.practitionerId < b.practitionerId
          ? -1
          : a.practitionerId > b.practitionerId
            ? 1
            : 0,
    );

  const balanced =
    attributedPence +
      unallocatedInDentallyPence +
      explainedNoInvoiceLinkPence +
      sharedInvoiceUndeterminedPence +
      noAttributableLinesPence +
      linkUnavailablePence ===
    totalReceivedPence;

  return {
    lines,
    totalReceivedPence,
    totalCount,
    attributedPence,
    unallocatedInDentallyPence,
    explainedNoInvoiceLinkPence,
    sharedInvoiceUndeterminedPence,
    noAttributableLinesPence,
    linkUnavailablePence,
    paymentTakerDifferedCount,
    refundCount,
    deletedExcluded,
    unattributedExcluded,
    legCount,
    legsChainResolved,
    legsLinkUnavailable,
    runIncomplete: legsLinkUnavailable > 0,
    basisCounts,
    sundryLineCount,
    balanced,
    conditions,
    anyPayableConfirmed: lines.some((l) => l.payableConfirmed),
    filters: { window, siteId },
  };
}

/** The bucket rows, in render order. Zero rows are kept out of the table. */
export function allocationBucketRows(report: AllocationReport): AllocationBucketRow[] {
  const pence: Record<AllocationBucketKey, number> = {
    unallocatedInDentally: report.unallocatedInDentallyPence,
    explainedNoInvoiceLink: report.explainedNoInvoiceLinkPence,
    sharedInvoiceUndetermined: report.sharedInvoiceUndeterminedPence,
    noAttributableLines: report.noAttributableLinesPence,
    linkUnavailable: report.linkUnavailablePence,
  };
  return ALLOCATION_BUCKET_KEYS.filter((key) => pence[key] !== 0).map((key) => ({
    key,
    label: ALLOCATION_BUCKET_LABELS[key],
    note: ALLOCATION_BUCKET_NOTES[key],
    pence: pence[key],
  }));
}

/**
 * THIS RUN's own coverage — "£X of £Y attributed to a clinician in this period".
 * Null when nothing was received, because 0/0 is not 100%.
 */
export function attributedShare(report: AllocationReport): number | null {
  if (report.totalReceivedPence === 0) return null;
  return report.attributedPence / report.totalReceivedPence;
}

/**
 * THIS RUN's own chain rate: legs that reached invoice lines, over all legs. The
 * calibration constant describes the method; this describes the run.
 */
export function runChainRate(report: AllocationReport): number | null {
  if (report.legCount === 0) return null;
  return report.legsChainResolved / report.legCount;
}
