import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
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
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"), DEFAULT_PER_PAGE);

  const all = siteId ? treatmentPlansForSite(siteId) : [];
  const total = all.length;
  const start = (page - 1) * perPage;
  const treatment_plans = all.slice(start, start + perPage).map((p) => ({
    ...p,
    // REAL DENTALLY'S OWN FIELD NAME, emitted beside the mock's simplification.
    //
    // `planned_private_treatment_value` is this mock's invention (see the note
    // above) and the reactivation and coordinator syncs read it off the wire by
    // that name. Live Dentally calls the field `private_treatment_value`, and that
    // is what the charting reads look for - so with only the mock's name on the
    // wire, the treatment plan panel printed "Not given by Dentally" for the
    // private plan value on EVERY panel in dev. The whole point of that figure is
    // to sit beside our own sum of the rows so a DISAGREEMENT between Dentally and
    // this screen is visible, and it could never be exercised or reviewed locally.
    // A mock tidier than production is how the blank-surfaces bug survived dev.
    private_treatment_value: p.planned_private_treatment_value,

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
