// ---------------------------------------------------------------------------
// REPORT B — payment allocation, the report Blerta pays dentists from.
//
// Her definition, verbatim: "every dentist that has COMPLETED a treatment and
// the patient has PAID for it and an invoice has been GENERATED and the treatment
// has been CLOSED. That is when the dentist gets paid... it has to be perfect."
//
// That is a four-way join — dentist → completed & closed treatment → invoice →
// payment. THE JOIN IS NOT WIRED. Dentally's own Payment Allocations report holds
// it, but no endpoint this repo reads exposes it: payments carry a practitioner
// and an amount but no invoice or treatment link; invoices carry no practitioner
// and no treatment link; treatment_plan_items carry completed + practitioner but
// no invoice_id and no paid flag, and only per-patient.
//
// So this report does the one thing the brief demands when a figure cannot be
// computed exactly: it SAYS SO, per row. It shows the only honest computable
// figure — payments RECEIVED, grouped by the practitioner ON THE PAYMENT record —
// clearly labelled as NOT the amount due, and against every line it states which
// of the four conditions it cannot verify. No line is ever marked payable,
// because not one of them can be confirmed from the wired data. Shipping this as
// "the pay report" would be the wrong-number-she-pays-from failure the brief
// forbids; shipping it as a labelled, honestly-caveated proxy is not.
//
// Pure functions only: no I/O, no clock reads.
// ---------------------------------------------------------------------------

import type { DashboardPayment } from "@/lib/dashboard/normalise";
import { isDayInWindow, type DayWindow } from "@/lib/dashboard/period";

/** Can we stand behind this condition for a given row, from the data we read? */
export type Verify = "verified" | "unverified" | "partial";

/** The four conditions Blerta requires before a dentist is paid. */
export interface AllocationConditions {
  /** The treatment was clinically completed. */
  completed: Verify;
  /** The course of treatment was closed. */
  closed: Verify;
  /** An invoice was generated for it. */
  invoiced: Verify;
  /** The patient paid it. */
  paid: Verify;
}

export const ALLOCATION_CONDITION_LABELS: Record<keyof AllocationConditions, string> = {
  completed: "Treatment completed",
  closed: "Course of treatment closed",
  invoiced: "Invoice generated",
  paid: "Patient paid",
};

/** Plain British English for why each condition cannot be stood behind today. */
export const ALLOCATION_CONDITION_NOTES: Record<keyof AllocationConditions, string> = {
  completed:
    "No wired source links a payment to a completed treatment. Clinical completion lives on treatment_plan_items, which the API only exposes per patient, and it is not calibrated against live data.",
  closed:
    "The course-of-treatment closed state is not carried on any endpoint this report reads.",
  invoiced:
    "No allocation link joins a payment to the invoice it settled. Dentally holds this in its Payment Allocations report, which is not on the API we read.",
  paid: "A payment exists against this practitioner, but it cannot be tied to a completed, closed, invoiced treatment — so 'paid for THIS work' is only partial.",
};

/**
 * The conditions as they stand with the currently-wired data. Constant, because
 * the join simply is not there: completed / closed / invoiced have no source at
 * all, and paid is only PARTIAL (a payment exists on the practitioner, but not
 * one provably settling a completed, closed, invoiced treatment). Injectable so a
 * future allocation endpoint can lift a condition to "verified" without a rewrite.
 */
export function wiredAllocationConditions(): AllocationConditions {
  return { completed: "unverified", closed: "unverified", invoiced: "unverified", paid: "partial" };
}

/** The conditions not fully verified — what the row cannot stand behind. */
export function unverifiedConditions(c: AllocationConditions): (keyof AllocationConditions)[] {
  return (Object.keys(c) as (keyof AllocationConditions)[]).filter((k) => c[k] !== "verified");
}

/** A dentist is only confirmed payable when all four conditions are verified. */
export function isPayable(c: AllocationConditions): boolean {
  return unverifiedConditions(c).length === 0;
}

export interface PractitionerPayLine {
  practitionerId: string | null;
  /** Whole pence RECEIVED, from payments whose practitioner_id is this one. NOT
   *  the amount due: it gates on none of completed/closed/invoiced. */
  paymentsReceivedPence: number;
  paymentCount: number;
  conditions: AllocationConditions;
  /** Always false with the wired data — see conditions for which are unverified. */
  payableConfirmed: boolean;
}

export interface PaymentAllocationReport {
  lines: PractitionerPayLine[];
  totalPence: number;
  totalCount: number;
  /** Deleted (voided) payments excluded from every figure. */
  deletedExcluded: number;
  /** Payments with no site, excluded when the report is scoped to one site. */
  unattributedExcluded: number;
  /** The conditions applied to every line (constant with the wired data). */
  conditions: AllocationConditions;
  /** True only if any line could be confirmed payable — false with wired data. */
  anyPayableConfirmed: boolean;
  filters: { window: DayWindow | null; siteId: string | null };
}

export interface PaymentAllocationInput {
  payments: readonly DashboardPayment[];
  window?: DayWindow | null;
  siteId?: string | null;
  /** Override the per-row conditions (e.g. once an allocation endpoint exists). */
  conditions?: AllocationConditions;
}

/**
 * Build Report B: payments received per practitioner-on-payment, with every line
 * flagged for the allocation conditions it cannot confirm. Deleted payments are
 * excluded and counted; when scoped to a site, payments with no site are excluded
 * and counted rather than folded in. Refunds (negative) are kept — they genuinely
 * reduce what was received.
 */
export function computePaymentAllocation(input: PaymentAllocationInput): PaymentAllocationReport {
  const window = input.window ?? null;
  const siteId = input.siteId ?? null;
  const conditions = input.conditions ?? wiredAllocationConditions();
  const payable = isPayable(conditions);

  const byPractitioner = new Map<string | null, { pence: number; count: number }>();
  let totalPence = 0;
  let totalCount = 0;
  let deletedExcluded = 0;
  let unattributedExcluded = 0;

  for (const p of input.payments) {
    if (p.deleted) {
      deletedExcluded += 1;
      continue;
    }
    if (siteId !== null) {
      if (p.siteId === null) {
        unattributedExcluded += 1;
        continue;
      }
      if (p.siteId !== siteId) continue;
    }
    if (window !== null && !isDayInWindow(p.day, window)) continue;

    const entry = byPractitioner.get(p.practitionerId) ?? { pence: 0, count: 0 };
    entry.pence += p.amountPence;
    entry.count += 1;
    byPractitioner.set(p.practitionerId, entry);
    totalPence += p.amountPence;
    totalCount += 1;
  }

  const lines: PractitionerPayLine[] = [...byPractitioner.entries()].map(
    ([practitionerId, { pence, count }]) => ({
      practitionerId,
      paymentsReceivedPence: pence,
      paymentCount: count,
      conditions,
      payableConfirmed: payable,
    }),
  );
  lines.sort((a, b) => {
    if (b.paymentsReceivedPence !== a.paymentsReceivedPence) {
      return b.paymentsReceivedPence - a.paymentsReceivedPence;
    }
    const ida = a.practitionerId ?? "";
    const idb = b.practitionerId ?? "";
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });

  return {
    lines,
    totalPence,
    totalCount,
    deletedExcluded,
    unattributedExcluded,
    conditions,
    anyPayableConfirmed: lines.some((l) => l.payableConfirmed),
    filters: { window, siteId },
  };
}
