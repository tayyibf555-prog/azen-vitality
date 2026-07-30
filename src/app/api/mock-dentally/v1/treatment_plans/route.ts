import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { resolveMockSiteId, treatmentPlansForSite } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

const DEFAULT_PER_PAGE = 100;

// GET /api/mock-dentally/v1/treatment_plans?site_id=&page=&per_page=
// Mirrors a Dentally list response: { treatment_plans: [...], meta: { total, page } }.
//
// MOCK SIMPLIFICATION: real Dentally has no clean treatment-plans-with-
// outstanding list (outstanding lives on invoices/accounts). Here each plan
// carries planned_private_treatment_value + amount_outstanding directly.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const siteId = resolveMockSiteId(url.searchParams.get("site_id")) ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(
    1,
    Number(url.searchParams.get("per_page") ?? String(DEFAULT_PER_PAGE)) ||
      DEFAULT_PER_PAGE,
  );

  const all = siteId ? treatmentPlansForSite(siteId) : [];
  const total = all.length;
  const start = (page - 1) * perPage;
  const treatment_plans = all.slice(start, start + perPage).map((p) => ({
    ...p,
    // `completed_at` is emitted on EVERY row, null included. A reader can then tell
    // "no plan finished in this window" (a fact) apart from "this source does not
    // expose finish dates" (unavailable), which the dashboard's finished/open counts
    // depend on. MOCK SIMPLIFICATION: a settled plan (nothing outstanding) is treated
    // as finished when it was last updated.
    completed_at:
      p.completed_at ?? (p.amount_outstanding === 0 ? p.updated_at : null),
  }));

  return Response.json({ treatment_plans, meta: { total, page } });
}
