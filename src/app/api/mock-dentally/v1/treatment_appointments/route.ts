import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import {
  MOCK_TREATMENT_APPOINTMENTS,
  treatmentAppointmentsForPatient,
  treatmentAppointmentsForPlan,
} from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 100;

// GET /api/mock-dentally/v1/treatment_appointments?patient_id=&treatment_plan_id=&page=&per_page=
// Mirrors a Dentally list response: { treatment_appointments: [...], meta: { total, page } }.
//
// GET ONLY, and there is no sibling POST/PUT/DELETE handler in this directory on
// purpose. Dentally publishes no create route on this resource (DENTALLY.md, checked
// 2026-08-01), so a mock that accepted a write would let `+ add appointment` be wired
// locally, pass every local test, and 404 the first time it ran against live — after
// a clinician had already been shown the card appearing.
//
// NO site_id, and no resolveMockSiteId call, matching treatment_plan_items: the panel
// read sends patient_id ALONE (see DentallyClient.listTreatmentAppointments), so there
// is no site parameter to map, and accepting one would suggest a scoping this route
// does not perform.
//
// PAGES FOR REAL, for the same reason the items route does: a route that ignored
// `page` would hand the read layer the same rows forever, and the walk would only
// stop at its ceiling — which the panel then reports as a TRUNCATED read on a patient
// whose plan is complete.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const patientId = url.searchParams.get("patient_id");
  const planId = url.searchParams.get("treatment_plan_id");
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"), DEFAULT_PER_PAGE);

  // Both filters COMPOSE, as on treatment_plan_items. A mock that returned more than
  // it was asked for hides a missing filter upstream.
  let all = MOCK_TREATMENT_APPOINTMENTS;
  if (patientId) all = treatmentAppointmentsForPatient(patientId);
  if (planId) {
    all = patientId
      ? all.filter((t) => t.treatment_plan_id === planId)
      : treatmentAppointmentsForPlan(planId);
  }

  const total = all.length;
  const start = (page - 1) * perPage;
  const treatment_appointments = all.slice(start, start + perPage);

  return Response.json({ treatment_appointments, meta: { total, page } });
}
