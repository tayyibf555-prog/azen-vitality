import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { paymentPlansForPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/payment_plans?patient_id=
// Kept for shape-fidelity with the real Dentally endpoint. The sync reads the
// outstanding amount from the treatment plan itself, so this is informational;
// it returns matching per-plan outstanding rows where any exist (else empty).
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id") ?? "";
  const payment_plans = patientId ? paymentPlansForPatient(patientId) : [];

  return Response.json({ payment_plans });
}
