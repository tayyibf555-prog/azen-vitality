// Outstanding-balance collection agent: the VERIFICATION read.
//
// One narrow job: fetch one patient's own invoices, paged, and hand the raw rows
// to the pure summariser in ./balance.ts. Nothing here interprets money; nothing
// here decides anything.
//
// WHY THIS EXISTS RATHER THAN getPatientDetail.
//
// getPatientDetail already reads a patient's invoices, but it also reads their
// appointments, their treatment plans and their clinical notes — up to thirty-five
// Dentally calls for a record we need one number from. Running that per debtor, at
// BACKGROUND priority, against a shared 3,600/hour quota the front desk is also
// using, would be the sweep spending the practice's afternoon on data it discards.
// This reads invoices and stops.
//
// WHY A SECOND READ AT ALL, given the debtors scan already produced a figure.
//
// Because the debtors scan is not good enough to make a claim to a patient on.
// It is cached for up to a minute, it is bounded by a page cap, and it aggregates
// the whole group's invoice index with a permissive money reader (see the header of
// ./balance.ts). This read is fresh, is scoped to the one patient, walks ALL their
// invoices rather than the unpaid slice, and is parsed strictly. The two figures
// must then agree to the penny, and when they do not, the honest answer is to say
// nothing at all rather than to pick the number we happen to prefer.
//
// A TRUNCATED READ IS AN UNREADABLE ONE. If a patient somehow has more invoices
// than the page bound, we have not seen their account, and the caller must not
// treat a partial history as a whole one. It reports `truncated` and the sweep
// refuses the patient.
//
// AND "TRUNCATED" IS MEASURED, NOT INFERRED FROM A SHORT PAGE. This walk used to
// call itself complete the moment a page came back under PER_PAGE — the one piece
// of evidence a hand-rolled pager has, and not evidence at all on an index that is
// ordered by id rather than by date. /v1/invoices publishes `meta.total`: exactly
// how many rows match this request. So the count is captured on page one and the
// walk is checked against it, the way reports/scan.ts's pageAll checks every read
// that carries a figure. Falling short raises the SAME `truncated` flag the page
// bound does, which is what makes the closer refuse the patient — and refusing is
// the point. The sentence this read gates is one the practice sends to a real
// person, mid-conversation, about money they are said to owe; a balance summed
// over a provably partial list is a claim nobody may make.

import { rethrowIfBudgetRefused } from "@/lib/dentally/client";
import { dentallyFromEnv } from "@/lib/dentally/read";
import { metaTotal } from "@/lib/dentally/paging";

/** Rows per page, matching every other paged read in this repo. */
const PER_PAGE = 100;

/**
 * Pages of ONE patient's invoices. Five hundred invoices is a patient of decades;
 * the real reason for the bound is that an endpoint which ignores `patient_id`
 * would otherwise walk the practice's whole 33k-row index one debtor at a time.
 */
const MAX_PAGES = 5;

export interface PatientInvoiceRead {
  rows: Array<Record<string, unknown>>;
  /** True when the page bound was hit on full pages: the history is INCOMPLETE. */
  truncated: boolean;
}

/**
 * One patient's invoices, paged, with the client-side patient filter kept as a
 * safety net.
 *
 * The filter matters: Dentally is known to ignore `site_id` on the invoice index
 * (the debtors scan in src/lib/dentally/read.ts detects and works around exactly
 * that), so assuming it honours `patient_id` would risk summing somebody else's
 * invoices into this patient's balance. Rows whose patient_id does not match are
 * dropped rather than trusted, and a page that produced NO matching rows still
 * counts toward the bound.
 *
 * A budget refusal PROPAGATES. It must: absorbing it here would produce an empty
 * invoice list, and an empty invoice list reads as "this patient owes nothing",
 * which would stop a live conversation on the strength of a read nobody made.
 */
export async function readPatientInvoices(patientId: string): Promise<PatientInvoiceRead> {
  const client = dentallyFromEnv();
  const rows: Array<Record<string, unknown>> = [];
  let truncated = true;
  /** `meta.total` from page one, or null when the envelope published none. */
  let expected: number | null = null;
  /** RAW rows returned, before the patient filter: the like-for-like left-hand side
   *  of a total that describes this request's own result set. */
  let fetched = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let batch: unknown[];
    try {
      const res = await client.listInvoices({ patientId, page, perPage: PER_PAGE });
      batch = res.invoices ?? [];
      if (page === 1) expected = metaTotal(res.meta);
    } catch (err) {
      // A refusal is not a failed read, it is a read that never happened.
      rethrowIfBudgetRefused(err);
      throw err;
    }
    for (const raw of batch) {
      const r = raw as Record<string, unknown>;
      // String() both sides: Dentally ids arrive as numbers from live and as
      // strings from the mock, and a type mismatch here would drop every row.
      if (String(r.patient_id ?? "") !== String(patientId)) continue;
      rows.push(r);
    }
    fetched += batch.length;
    if (batch.length < PER_PAGE) {
      // Complete ONLY if Dentally agrees. It published a count and we hold fewer
      // rows than it: the history has a hole in it whatever the last page looked
      // like, and `truncated` stays true so the caller refuses to quote.
      truncated = expected !== null && fetched < expected;
      break;
    }
  }

  return { rows, truncated };
}
