import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import { MOCK_TREATMENT_CATEGORIES } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 100;

// GET /api/mock-dentally/v1/treatment_categories?page=&per_page=
// Mirrors a Dentally list response: { treatment_categories: [...], meta: { total, page } }.
//
// Practice-wide like the catalogue itself, so no site or patient filter and no
// resolveMockSiteId call. Paged for real.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"), DEFAULT_PER_PAGE);

  const total = MOCK_TREATMENT_CATEGORIES.length;
  const start = (page - 1) * perPage;
  const treatment_categories = MOCK_TREATMENT_CATEGORIES.slice(start, start + perPage);

  return Response.json({ treatment_categories, meta: { total, page } });
}
