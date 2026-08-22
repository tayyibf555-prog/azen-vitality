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
//
// AND `meta.total` HONOURS `patient_id`, WHICH IS NOW PROVEN RATHER THAN ASSUMED.
// The check above is only safe if the count describes THIS REQUEST'S result set. Had
// Dentally published the whole index's count against a patient-scoped request, every
// patient alive would have come back short of ~34,000 and the closer would have
// refused every single one of them, for ever — a silent, total shutdown of the
// collection sweep that no test could have caught, because the mock publishes an
// honest per-request count.
//
// Probed live, read-only GET, 2026-08-22: /v1/invoices reports meta.total 34,209
// unfiltered, 3,854 for `paid=false`, and 1 for a sampled `patient_id` — with the one
// returned row belonging to that patient. The total is filter-honouring on all three,
// so `expected` is authoritative here and the completeness gate is sound.
//
// IT WALKS ON THE SHARED PAGER NOW, NOT A PRIVATE COPY OF IT. This held pageAll's
// contract minus two of its stops: it never abandoned a walk Dentally had already
// said was too big for the bound (page one carries the count), and it never stopped
// on reaching that count, so a patient with exactly MAX_PAGES x PER_PAGE invoices
// paged to the cap and was reported TRUNCATED — a complete history refused as a
// partial one, which costs a real conversation. Both stops are pageAll's, tested
// there, and this file now gets them by using it rather than by re-deriving them.

import { pageAll } from "@/lib/reports/scan";
import { dentallyFromEnv } from "@/lib/dentally/read";

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
 * counts toward the walk.
 */
export async function readPatientInvoices(patientId: string): Promise<PatientInvoiceRead> {
  const client = dentallyFromEnv();

  // A budget refusal PROPAGATES straight out of here — there is no catch, and that
  // is the point. pageAll does not swallow anything, and neither does this: the
  // alternative is an empty invoice list, which reads as "this patient owes
  // nothing" and would stop a live conversation on a read nobody made.
  const read = await pageAll(
    async (page, perPage) => {
      const res = await client.listInvoices({ patientId, page, perPage });
      return { rows: res.invoices ?? [], meta: res.meta };
    },
    PER_PAGE,
    MAX_PAGES,
  );

  // The patient filter runs on the RAW rows, AFTER the walk, so completeness is
  // measured like for like against a total that describes this request's own result
  // set. Comparing the filtered rows against it would report every response that
  // carried somebody else's row as truncated for ever.
  const rows = read.raw
    .map((raw) => raw as Record<string, unknown>)
    // String() both sides: Dentally ids arrive as numbers from live and as strings
    // from the mock, and a type mismatch here would drop every row.
    .filter((r) => String(r.patient_id ?? "") === String(patientId));

  return { rows, truncated: !read.complete };
}
