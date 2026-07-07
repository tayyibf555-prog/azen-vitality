import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { invoicesForPatient, allInvoices } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/invoices?patient_id=  -> one patient's invoices.
// GET /api/mock-dentally/v1/invoices?page=        -> the practice index (paged), the
//     shape the outstanding scan reads. Real Dentally may ignore site_id here and
//     return the group; this mock likewise returns every invoice on page 1 and an
//     empty page after, so a paging caller terminates.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id");
  if (patientId) return Response.json({ invoices: invoicesForPatient(patientId) });
  const page = Number(url.searchParams.get("page") ?? "1") || 1;
  return Response.json({ invoices: page === 1 ? allInvoices() : [] });
}
