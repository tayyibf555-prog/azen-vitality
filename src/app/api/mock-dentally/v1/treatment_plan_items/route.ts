import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import {
  MOCK_TREATMENT_PLAN_ITEMS,
  treatmentPlanItemsForPatient,
  treatmentPlanItemsForPlan,
} from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 100;

// GET /api/mock-dentally/v1/treatment_plan_items?patient_id=&treatment_plan_id=&page=&per_page=
// Mirrors a Dentally list response: { treatment_plan_items: [...], meta: { total, page } }.
//
// NO site_id, and no resolveMockSiteId call. The other mock routes need it because
// the app sends the real Dentally site UUID while the fixtures are keyed on our
// internal id, and without the mapping every site-scoped read is empty in dev while
// working against live. This endpoint is different: the chart read sends patient_id
// ALONE (see DentallyClient.listTreatmentPlanItems for why), so there is no site
// parameter to map and accepting one would suggest a scoping this route does not do.
//
// PAGES FOR REAL. The read layer walks pages until a short one; a route that ignored
// `page` would hand it the same rows forever and the walk would only stop at its
// ceiling, which the chart then reports as a TRUNCATED read on a patient whose chart
// is complete.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id");
  const planId = url.searchParams.get("treatment_plan_id");
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(
    1,
    Number(url.searchParams.get("per_page") ?? String(DEFAULT_PER_PAGE)) || DEFAULT_PER_PAGE,
  );

  // Both filters COMPOSE. Applying only the first would return a superset for a
  // caller that asked for one plan's items on one patient, and a mock that returns
  // more than it was asked for hides a missing filter upstream.
  let all = MOCK_TREATMENT_PLAN_ITEMS;
  if (patientId) all = treatmentPlanItemsForPatient(patientId);
  if (planId) {
    all = patientId ? all.filter((i) => i.treatment_plan_id === planId) : treatmentPlanItemsForPlan(planId);
  }

  const total = all.length;
  const start = (page - 1) * perPage;
  const treatment_plan_items = all.slice(start, start + perPage);

  return Response.json({ treatment_plan_items, meta: { total, page } });
}
