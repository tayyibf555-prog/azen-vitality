import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { allPayments } from "@/app/api/mock-dentally/_finance-fixtures";
import { resolveMockSiteId } from "@/app/api/mock-dentally/_fixtures";

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
//   - per_page is capped at 100 on live.
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
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);
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
      total_amount: sumAmounts(rows.map((p) => p.amount)),
    },
  });
}

/**
 * Sum decimal money strings EXACTLY and render the total the way Dentally does.
 *
 * In whole pence, never floats: a mock that answered 2724089.9999999995 would let a
 * caller's own rounding bug pass locally and fail on the practice's real takings.
 * A value the grammar does not recognise contributes nothing — the one deliberately
 * malformed fixture row is dropped from the aggregate exactly as a caller drops it
 * from a row-by-row total.
 */
function sumAmounts(amounts: readonly string[]): string {
  let pence = 0;
  for (const raw of amounts) {
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
    if (!match) continue;
    const magnitude = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
    pence += match[1] === "-" ? -magnitude : magnitude;
  }
  const fixed = (pence / 100).toFixed(2);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}
