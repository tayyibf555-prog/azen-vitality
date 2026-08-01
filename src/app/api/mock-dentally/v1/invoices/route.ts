import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
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
//     the outstanding scan reads. Real Dentally may ignore site_id here and return the
//     whole group; this mock likewise ignores it. Paged properly rather than dumped on
//     page 1: the index now runs to roughly a thousand rows, and a caller that asked
//     for a hundred should be handed a hundred, exactly as live would.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);
  const start = (page - 1) * perPage;
  const patientId = url.searchParams.get("patient_id");
  // The per-patient branch pages too. It used to return every matching row on every
  // page, which is not what live does and which would make a paging caller loop on
  // duplicates: the mock has to be at least as strict as the API it stands in for,
  // or a paging bug is invisible until production.
  if (patientId) {
    const own = invoiceIndex().filter((i) => i.patient_id === patientId);
    return Response.json({ invoices: own.slice(start, start + perPage) });
  }
  return Response.json({ invoices: invoiceIndex().slice(start, start + perPage) });
}
