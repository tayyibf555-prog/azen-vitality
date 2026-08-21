import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import {
  MOCK_TREATMENT_PLAN_ITEMS,
  type MockTreatmentPlanItem,
} from "@/app/api/mock-dentally/_fixtures";
import { clinicalActivityItems } from "@/app/api/mock-dentally/_clinical-activity-fixtures";

export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 100;

// GET /api/mock-dentally/v1/treatment_plan_items
//   ?patient_id=&treatment_plan_id=&practitioner_id=&updated_since=&page=&per_page=
// Mirrors a Dentally list response: { treatment_plan_items: [...], meta: { total, page } }.
//
// TWO CALLERS, ONE ENDPOINT, exactly as live:
//   - the CHARTING panel sends patient_id (and optionally treatment_plan_id);
//   - REPORT C sends practitioner_id + updated_since (never patient_id), and its
//     fallback path sends updated_since alone.
//
// So the pool is the hand-set charting fixtures PLUS the generated clinical-activity
// population, and EVERY filter COMPOSES. A charting read for a demo patient (pat-*)
// still returns only its hand-set items, because the generated rows use cpat-* ids;
// a report scan for a practitioner over a window returns the generated rows plus any
// hand-set row that happens to match. A mock that returned more than it was asked for
// would hide a missing filter upstream.
//
// NO site_id, and no resolveMockSiteId: the live item carries no site_id (per-site
// scope is via the practitioner roster), so accepting one would suggest a scoping
// this route does not do.
//
// PAGES FOR REAL. The report and the chart both walk pages until a short one, so a
// route that ignored `page` would loop until its ceiling and be reported as a
// truncated read on a complete set.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id");
  const planId = url.searchParams.get("treatment_plan_id");
  const practitionerId = url.searchParams.get("practitioner_id");
  const updatedSince = url.searchParams.get("updated_since");
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"), DEFAULT_PER_PAGE);

  let all: MockTreatmentPlanItem[] = [...MOCK_TREATMENT_PLAN_ITEMS, ...clinicalActivityItems()];
  if (patientId) all = all.filter((i) => i.patient_id === patientId);
  if (planId) all = all.filter((i) => i.treatment_plan_id === planId);
  if (practitionerId) all = all.filter((i) => i.practitioner_id === practitionerId);
  if (updatedSince) {
    // Live filters on updated_at >= the bare date. Lexicographic compare of an ISO
    // timestamp against the "YYYY-MM-DD" boundary is correct: any instant on or
    // after the boundary day sorts >= the boundary string.
    all = all.filter((i) => String(i.updated_at) >= updatedSince);
  }

  const total = all.length;
  const start = (page - 1) * perPage;
  const treatment_plan_items = all.slice(start, start + perPage);

  return Response.json({ treatment_plan_items, meta: { total, page } });
}
