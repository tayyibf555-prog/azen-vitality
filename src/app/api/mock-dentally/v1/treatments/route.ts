import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import { MOCK_TREATMENTS } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 100;

// GET /api/mock-dentally/v1/treatments?page=&per_page=
// Mirrors a Dentally list response: { treatments: [...], meta: { total, page } }.
//
// The catalogue is PRACTICE-WIDE: no site_id and no patient_id, so there is no
// resolveMockSiteId call here (see the treatment_plan_items route for why the other
// mock routes need one). Paged for real, so a pageAll caller terminates on a short
// page rather than on its ceiling.
//
// The fixture list is deliberately spread across first letters so the chart's
// 37-key alphabet rail has BOTH populated and empty buckets in local dev.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"), DEFAULT_PER_PAGE);

  const total = MOCK_TREATMENTS.length;
  const start = (page - 1) * perPage;
  const treatments = MOCK_TREATMENTS.slice(start, start + perPage);

  return Response.json({ treatments, meta: { total, page } });
}
