import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import { notesForPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/notes?patient_id=&page=&per_page=
// Mirrors a Dentally clinical-notes list, newest first, PAGED: the read that calls it
// pages until a short page, and a mock that ignores page would hand it the same rows
// forever. The mock has to be at least as strict as the API it stands in for.
//
// THIS FILE USED TO LIVE AT /v1/patient_notes, a path real Dentally does not have.
// Mocking an invented path is how the 404 on every live patient record stayed hidden:
// dev and the whole suite were green against a route that only existed here. The real
// resource is /v1/notes (verified live 2026-08-03: 200, `{"notes":[],"meta":{...}}`),
// so the collection key and the meta envelope below match what live returns.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id") ?? "";
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"));
  const start = (page - 1) * perPage;
  const rows = patientId ? notesForPatient(patientId) : [];
  return Response.json({
    notes: rows.slice(start, start + perPage),
    meta: { total: rows.length, current_page: page, total_pages: Math.ceil(rows.length / perPage) },
  });
}
