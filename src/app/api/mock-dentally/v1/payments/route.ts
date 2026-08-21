import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import { allPayments } from "@/app/api/mock-dentally/_finance-fixtures";
import { resolveMockSiteId } from "@/app/api/mock-dentally/_fixtures";
import { penceToDentallyAmount, sumAmountsPence } from "@/app/api/mock-dentally/_money";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/payments?site_id=&start_date=&end_date=&page=&per_page=
//
// Mirrors the real /v1/payments, RE-CALIBRATED against live by read-only probe on
// 2026-08-21. What this route asserted until then — "DATE FILTERS ARE IGNORED ...
// This mock ignores them too, on purpose" — was false, and because the mock enforced
// the false belief, no amount of local testing could ever have caught the takings
// bug it produced. A mock that models an API's limitation has to be right about the
// limitation.
//
//   - start_date / end_date ARE HONOURED, both edges INCLUSIVE, filtering on
//     `dated_on`. (filter[from], from and dated_on_from really are ignored; those
//     are the parameters the original calibration tried.)
//   - `meta` carries `total` (the exact row count for the filtered set) and
//     `total_amount` (their exact sum, as a decimal STRING). This is what lets a
//     caller total a window in ONE request, and it is present on every response
//     including paged ones.
//   - site_id IS honoured. Results come back NEWEST FIRST — but callers must not
//     depend on that, because live orders by id and a backdated payment lands
//     wherever its id falls.
//   - per_page is capped at 100 on live, and asking for MORE silently returns 25
//     rather than 100. Reproduced here; see _paging.ts for why the 25 is the part
//     worth modelling.
//
// Amounts are STRINGS ("27.9"), dates are bare YYYY-MM-DD, and `deleted` is a
// boolean. One fixture row carries a malformed amount so callers must prove they
// drop it rather than counting it as zero; it contributes nothing to total_amount,
// which is the closest a fixture can get to live, where such a row does not exist.
// Deleted rows ARE included in total_amount, because live offers no way to exclude
// them (deleted=true and deleted=false both return the unfiltered set) and a mock
// must not invent a capability the real endpoint lacks.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const siteId = resolveMockSiteId(url.searchParams.get("site_id"));
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"));
  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");

  let rows = siteId ? allPayments().filter((p) => p.site_id === siteId) : allPayments();
  if (startDate) rows = rows.filter((p) => p.dated_on >= startDate);
  if (endDate) rows = rows.filter((p) => p.dated_on <= endDate);

  const start = (page - 1) * perPage;
  return Response.json({
    payments: rows.slice(start, start + perPage),
    meta: {
      total: rows.length,
      current_page: page,
      // The APP'S own money grammar, not a copy of it — see _money.ts.
      total_amount: penceToDentallyAmount(sumAmountsPence(rows.map((p) => p.amount))),
    },
  });
}
