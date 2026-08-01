import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { notesForPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/patient_notes?patient_id=&page=&per_page=
// Mirrors a Dentally patient-notes list, newest first, PAGED: the read that calls it
// pages until a short page, and a mock that ignores page would hand it the same rows
// forever. The mock has to be at least as strict as the API it stands in for.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);
  const start = (page - 1) * perPage;
  const rows = patientId ? notesForPatient(patientId) : [];
  return Response.json({ patient_notes: rows.slice(start, start + perPage) });
}
