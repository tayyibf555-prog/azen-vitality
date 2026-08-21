import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { dentallySmsForPatient } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/sms?patient_id=&page=&per_page=
//
// Dentally's own SMS log — the feed behind the Correspondence tab inside Dentally
// itself. Mirrors the live resource: collection key `sms`, newest first, PAGED, and
// `patient_id` MANDATORY (live has no practice-wide index on this resource, and a
// mock that answered an unfiltered request would let a caller ship code that 422s
// the moment it meets production).
//
// GET ONLY, ON PURPOSE. There is deliberately no POST handler here even though the
// mock is harmless: Dentally sends its SMS through Twilio, so a POST to the live
// path is far more likely to TRANSMIT a text to a real patient than to file a log
// entry. A mock that accepted writes would let a write path be built and tested
// green against a route that must never be written to.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id");
  if (!patientId) {
    // Live answers 422 with this exact complaint. Mirrored so a caller that forgets
    // the filter fails here rather than in production.
    return Response.json({ error: { message: "patient_id is required" } }, { status: 422 });
  }
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);
  const start = (page - 1) * perPage;
  const rows = dentallySmsForPatient(patientId);
  return Response.json({
    sms: rows.slice(start, start + perPage),
    meta: { total: rows.length, current_page: page, total_pages: Math.ceil(rows.length / perPage) },
  });
}
