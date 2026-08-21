import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import { allInvoices } from "@/app/api/mock-dentally/_fixtures";
import { generatedInvoices } from "@/app/api/mock-dentally/_dashboard-fixtures";

export const dynamic = "force-dynamic";

/** The hand-written invoices (undated, giving a few patients a balance) plus the
 *  generated dated ones the dashboard's INVOICED panel totals over a window. */
function invoiceIndex() {
  return [...allInvoices(), ...generatedInvoices()];
}

// GET /api/mock-dentally/v1/invoices?patient_id=  -> one patient's invoices.
// GET /api/mock-dentally/v1/invoices?page=&per_page= -> the practice index, the shape
//     the invoiced-in-window and outstanding scans read. Paged properly rather than
//     dumped on page 1: a caller that asked for a hundred should be handed a hundred,
//     exactly as live would.
//
// FILTERS, calibrated by live read-only probe 2026-08-21 (group total 34,201):
//   - `created_after` / `created_before` ARE HONOURED, on `created_at`.
//     created_after=2026-08-01 -> 597 and created_before=2026-08-01 -> 33,604, which
//     sum to the unfiltered total exactly: `after` is inclusive of the boundary day,
//     `before` exclusive of it. Callers pad both edges because created_at is an
//     instant, not a day.
//   - `paid` IS honoured, and matters: live is 30,348 paid against 3,853 unpaid, so
//     an unfiltered bounded scan of this index is almost entirely settled rows.
//   - `start_date`/`end_date`, `from`/`to`, `after`/`before`, `date_from`/`date_to`
//     and `on` are ALL IGNORED — the date parameter is named differently on each of
//     payments, nhs_claims and invoices, so this mock drops the wrong names on the
//     floor exactly as live does.
//   - `meta` carries `total` and `total_pages` but NO `total_amount`.
//   - per_page is CAPPED AT 100, and asking for more silently returns 25 rather
//     than 100 (see _paging.ts). `total_pages` is reported against the page size
//     live would ACTUALLY have served, not the one that was asked for.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"));
  const start = (page - 1) * perPage;
  const patientId = url.searchParams.get("patient_id");
  // The per-patient branch pages too. It used to return every matching row on every
  // page, which is not what live does and which would make a paging caller loop on
  // duplicates: the mock has to be at least as strict as the API it stands in for,
  // or a paging bug is invisible until production.
  if (patientId) {
    const own = invoiceIndex().filter((i) => i.patient_id === patientId);
    return Response.json({ invoices: own.slice(start, start + perPage), meta: meta(own.length, page, perPage) });
  }

  let rows: ReadonlyArray<Record<string, unknown>> = invoiceIndex() as never;
  const paid = url.searchParams.get("paid");
  if (paid === "true" || paid === "false") rows = rows.filter((i) => (i["paid"] === true) === (paid === "true"));
  const createdAfter = url.searchParams.get("created_after");
  const createdBefore = url.searchParams.get("created_before");
  // An invoice with no created_at cannot be placed on either side of a boundary, so a
  // date-filtered request excludes it rather than guessing. (The hand-written fixtures
  // are deliberately undated, which is what the INVOICED panel's "undated" counter is
  // for; they still reach the unfiltered and paid=false reads.)
  if (createdAfter) rows = rows.filter((i) => day(i["created_at"]) !== null && day(i["created_at"])! >= createdAfter);
  if (createdBefore) rows = rows.filter((i) => day(i["created_at"]) !== null && day(i["created_at"])! < createdBefore);

  return Response.json({ invoices: rows.slice(start, start + perPage), meta: meta(rows.length, page, perPage) });
}

function meta(total: number, page: number, perPage: number) {
  return { total, current_page: page, total_pages: Math.ceil(total / perPage) };
}

/** The London calendar day of an ISO instant or day key, or null when there is none. */
function day(value: unknown): string | null {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}
