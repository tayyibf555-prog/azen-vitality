import "server-only";
import { dentallyFromEnv } from "@/lib/dentally/read";
import { invoiceFromEnvelope, type InvoiceWithItems } from "@/lib/dentally/invoice-shape";
import type { DayWindow } from "@/lib/dashboard/period";
import {
  computeAllocationReport,
  inAllocationScope,
  ALLOCATION_IDENTITY_UNAVAILABLE,
  type AllocationReport,
} from "@/lib/reports/allocation-report";
import {
  distinctInvoiceIds,
  normaliseAllocationPayments,
} from "@/lib/reports/payment-explanations";

// ---------------------------------------------------------------------------
// The invoice fan-out behind Report B. ORCHESTRATION ONLY — every rule lives in
// allocation-split.ts / allocation-report.ts and is tested there.
//
// The payments pass is unchanged: flagship-read.ts still pages /v1/payments
// backwards with scanBackwards / REPORTS_PER_PAGE and still reports coverage the
// same way, and it hands the RAW rows here. Doing it that way means the window is
// scanned once, not twice, and the two SCAN_* unavailable reasons stay exactly
// where they were.
//
// WHY THIS COSTS SO MANY REQUESTS. Dentally exposes invoice lines on the DETAIL
// route only: the index carries none and `include=invoice_items` is ignored
// (probed 2026-08-03). Attribution is therefore one GET per invoice settled in
// the period — roughly 1,900 for a 60-day all-sites run, inside the observed
// 3,600/hour rate limit but nowhere near free. So:
//
//   - the fetch is capped at INVOICE_FETCH_BUDGET and a run that would exceed it
//     returns an honest unavailable reason. IT NEVER TRUNCATES: a clinician total
//     computed from the invoices that happened to fit is a wrong number wearing a
//     right number's clothes.
//   - each invoice is fetched ONCE per request, however many payments settled it;
//   - at most INVOICE_FETCH_CONCURRENCY are in flight;
//   - a non-200 is retried EXACTLY ONCE (measured 1 failure in 235, and the retry
//     succeeded — it is transient), after which the invoice is reported unreadable
//     and its money lands in the report's own visible "Could not read the invoice"
//     row rather than being dropped;
//   - a 200 whose SHAPE is unrecognised is NOT retried. That is deterministic, not
//     transient, and re-asking would only cost another request.
// ---------------------------------------------------------------------------

/**
 * The most live invoice reads one run may make. A 60-day all-sites period measured
 * ~1,900 distinct invoices, so this deliberately does NOT cover the longest window
 * the API could serve: it covers what fits in one request, and says so otherwise.
 */
export const INVOICE_FETCH_BUDGET = 1200;

/** Invoice GETs in flight at once. Kept well under the 3,600/hour rate limit. */
export const INVOICE_FETCH_CONCURRENCY = 6;

export const INVOICE_BUDGET_UNAVAILABLE =
  `Unavailable: attributing this period to clinicians needs one live invoice read for every invoice settled in it, and this period settled more than the ${INVOICE_FETCH_BUDGET.toLocaleString("en-GB")} a single run is allowed. Dentally publishes invoice lines on the per-invoice route only — the index carries none — so there is no bulk read to fall back on. The figures are not shown from a partial read. Choose a shorter period.`;

export interface AllocationPassResult {
  report: AllocationReport | null;
  unavailableReason: string | null;
  /** Payment rows that could not be read at all, excluded and counted. */
  droppedPayments: number;
  /** Distinct invoices the legs pointed at. */
  invoicesRequested: number;
  /** Invoices read and understood. */
  invoicesRead: number;
  /** Invoices that failed after their retry, or came back in a shape we refuse. */
  invoicesUnreadable: number;
  /** How many reads needed their one retry. */
  invoiceRetries: number;
}

/** Run `work` over `items`, at most `limit` at a time, in order of completion. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Read one invoice, retrying a failure exactly once. Returns null when it still
 * cannot be read, or when the envelope is a shape invoice-shape.ts refuses.
 */
async function readInvoiceOnce(
  client: ReturnType<typeof dentallyFromEnv>,
  id: string,
): Promise<{ invoice: InvoiceWithItems | null; retried: boolean }> {
  let retried = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const envelope = await client.getInvoice(id);
      // A shape failure is deterministic — do not spend the retry on it.
      return { invoice: invoiceFromEnvelope(envelope), retried };
    } catch (err) {
      if (attempt === 0) {
        retried = true;
        continue;
      }
      console.error(`[reports] invoice read failed after retry for ${id}`, err);
    }
  }
  return { invoice: null, retried };
}

/**
 * Turn the raw payment rows of a scanned window into the allocation report.
 *
 * The invoice budget is spent only on payments that are actually IN SCOPE (not
 * voided, in the window, in the selected site) — the scan reaches past the window
 * boundary by design, and fetching those invoices would burn the budget on money
 * this report never shows.
 */
export async function readAllocationPass(args: {
  rawPayments: readonly unknown[];
  window: DayWindow;
  siteId: string | null;
}): Promise<AllocationPassResult> {
  const { rawPayments, window, siteId } = args;
  const { rows: payments, dropped } = normaliseAllocationPayments(rawPayments);

  const inScope = payments.filter((p) => inAllocationScope(p, window, siteId));
  const invoiceIds = distinctInvoiceIds(inScope);

  if (invoiceIds.length > INVOICE_FETCH_BUDGET) {
    return {
      report: null,
      unavailableReason: INVOICE_BUDGET_UNAVAILABLE,
      droppedPayments: dropped,
      invoicesRequested: invoiceIds.length,
      invoicesRead: 0,
      invoicesUnreadable: 0,
      invoiceRetries: 0,
    };
  }

  const client = dentallyFromEnv();
  const fetched = await mapWithConcurrency(invoiceIds, INVOICE_FETCH_CONCURRENCY, (id) =>
    readInvoiceOnce(client, id),
  );

  const invoices = new Map<string, InvoiceWithItems>();
  let invoicesUnreadable = 0;
  let invoiceRetries = 0;
  fetched.forEach((result, i) => {
    if (result.retried) invoiceRetries += 1;
    if (result.invoice === null) {
      invoicesUnreadable += 1;
      return;
    }
    // Key by the id we ASKED for: the report looks legs up by the id on the
    // explanation, and an invoice that answered under a different id is a
    // mismatch we would rather surface as unreadable than quietly accept.
    invoices.set(invoiceIds[i], result.invoice);
  });

  const report = computeAllocationReport({ payments, invoices, window, siteId });

  // The identity is the last gate: a report that does not reconcile is not shown.
  if (!report.balanced) {
    console.error("[reports] allocation identity failed", {
      totalReceivedPence: report.totalReceivedPence,
      attributedPence: report.attributedPence,
    });
    return {
      report: null,
      unavailableReason: ALLOCATION_IDENTITY_UNAVAILABLE,
      droppedPayments: dropped,
      invoicesRequested: invoiceIds.length,
      invoicesRead: invoices.size,
      invoicesUnreadable,
      invoiceRetries,
    };
  }

  return {
    report,
    unavailableReason: null,
    droppedPayments: dropped,
    invoicesRequested: invoiceIds.length,
    invoicesRead: invoices.size,
    invoicesUnreadable,
    invoiceRetries,
  };
}
