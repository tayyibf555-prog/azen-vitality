// ---------------------------------------------------------------------------
// REPORT B — payment allocation, the report Blerta pays dentists from.
//
// Her definition, verbatim: "every dentist that has COMPLETED a treatment and
// the patient has PAID for it and an invoice has been GENERATED and the treatment
// has been CLOSED. That is when the dentist gets paid... it has to be perfect."
//
// That is a four-way join. THREE OF THE FOUR ARE NOW WIRED. Read-only probes of
// live Dentally on 2026-08-03 (2,052 payments, 235 invoices, 258 allocation legs)
// established the chain the report walks:
//
//     payment → explanation.invoice_id → GET /v1/invoices/{id}
//             → invoice_items[].practitioner_id
//
//   - it resolved for 256/258 legs (99.2%);
//   - every invoice line carried a practitioner_id (256/256);
//   - Σ invoice_items.total_price == invoice.amount (256/256);
//   - so money is attributed to the TREATING clinician on the invoice line, never
//     to whoever took the payment. Those two disagree on 17/242 legs (7.0% of
//     legs, 3.67% of money) and the disagreement is COUNTED AND SHOWN, not
//     reconciled away.
//
// The earlier route through treatment_plan_items was measured and REJECTED: only
// 5.0% of recent plan items carry an invoice_id, and the endpoint ignores an
// invoice_id filter entirely (it returns all 989k rows), so that chain can only be
// walked by a per-patient page scan and yields strictly less.
//
// TWO THINGS THIS REPORT STILL CANNOT DO, and neither is fixable in code:
//
//   1. 20.63% of the money the practice received in the 60 days to 2026-08-03 is
//      not allocated to anything inside Dentally at all. That is a data-entry
//      reality in the practice's own records, not an API gap, and it is the hard
//      ceiling on what any report can attribute. It is shown as its own row.
//
//   2. DENTALLY EXPOSES NO "CLOSED" FIELD. /v1/treatment_plans carries completed,
//      completed_at, created_at, end_date, id, import_id, last_completed_at,
//      nhs_completed_uda_value, nhs_uda_value, nickname, patient_id,
//      payment_plan_id, practitioner_id, private_treatment_value, start_date and
//      updated_at — and nothing else (probed 2026-08-03). end_date is set on
//      238/238 completed plans and only 6/62 incomplete ones, so it marks
//      completion, not a distinct closure. Dentally's own reporting ships a
//      "Completed but Not Closed" report, so the two demonstrably differ and this
//      report cannot see the difference. Until someone asks Blerta what "closed"
//      means in her workflow, or asks Dentally which field carries it, `closed`
//      stays permanently unverified — which is why NO LINE IS EVER MARKED PAYABLE.
//
// So the figures here are MONEY RECEIVED AND ATTRIBUTED. They are never money
// owed, never approved, and never split NHS versus private (invoice.nhs_amount
// was null on 256/256 and item nhs_charge 0 on 728/728 — that split is not
// readable this way).
//
// Pure functions only: no I/O, no clock reads. The fold lives in
// allocation-report.ts and the money rule in allocation-split.ts.
// ---------------------------------------------------------------------------

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

/**
 * Plain British English for what each condition does and does not stand on. Every
 * sentence names a measurement taken on 2026-08-03, and says plainly whether the
 * limit is this report's or Dentally's — the two are not the same, and getting
 * that the wrong way round closes a question that should stay open.
 */
export const ALLOCATION_CONDITION_NOTES: Record<keyof AllocationConditions, string> = {
  completed:
    "Completion is inferred, not read. Every invoice line this report attributes by links back to a treatment_plan_item_id (256/256 sampled invoices), and on plan items `charged` mirrors `invoice_id` exactly (25/25), so an invoiced line is a charged line. But this report does not read `completed` on the plan item itself, so it is partial, not verified.",
  closed:
    "Dentally's API exposes no `closed` field on a course of treatment. treatment_plans carries completed, completed_at, end_date, start_date, last_completed_at and nothing else (probed 2026-08-03); end_date is set on 238/238 completed plans and 6/62 incomplete ones, so it marks completion rather than closure. Dentally's own reporting ships a 'Completed but Not Closed' report, so the two differ and this cannot see the difference. It stays unverified until someone answers what 'closed' means here — and because of it, no line is ever payable.",
  invoiced:
    "Verified for every attributed line. The payment's own explanations[] name the invoice it settled, that invoice was read from /v1/invoices/{id}, and its lines carried the clinician. The chain resolved for 99.2% of allocation legs live (256/258); anything it did not resolve is shown as its own row rather than attributed.",
  paid: "Verified. Payments are the source of truth for this one: every figure here starts from money the practice actually received, with voided payments excluded and refunds left in to reduce the line.",
};

/**
 * The conditions as they stand with what this report now reads.
 *
 * `invoiced` and `paid` are the first honest lift this report has earned: the
 * allocation chain is wired and measured. `completed` is PARTIAL because
 * completion is inferred from the invoice line rather than read. `closed` is
 * permanently UNVERIFIED — the field does not exist on the API (see the header),
 * so isPayable() returns false for every row and will keep doing so until a human
 * answers what "closed" means in this practice's workflow.
 *
 * Injectable at the compute layer so a future answer can lift it without a rewrite.
 */
export function wiredAllocationConditions(): AllocationConditions {
  return { completed: "partial", closed: "unverified", invoiced: "verified", paid: "verified" };
}

/** The conditions not fully verified — what the row cannot stand behind. */
export function unverifiedConditions(c: AllocationConditions): (keyof AllocationConditions)[] {
  return (Object.keys(c) as (keyof AllocationConditions)[]).filter((k) => c[k] !== "verified");
}

/** A dentist is only confirmed payable when all four conditions are verified. */
export function isPayable(c: AllocationConditions): boolean {
  return unverifiedConditions(c).length === 0;
}
