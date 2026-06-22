import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { notesForPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/patient_notes?patient_id=
// Mirrors a Dentally patient-notes list, newest first.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const patientId = new URL(request.url).searchParams.get("patient_id") ?? "";
  return Response.json({ patient_notes: patientId ? notesForPatient(patientId) : [] });
}
