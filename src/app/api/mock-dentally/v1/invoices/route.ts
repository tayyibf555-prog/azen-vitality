import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { invoicesForPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/invoices?patient_id=
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id") ?? "";
  return Response.json({ invoices: invoicesForPatient(patientId) });
}
