import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { mockPage, mockPerPage } from "@/app/api/mock-dentally/_paging";
import { allNhsClaims } from "@/app/api/mock-dentally/_finance-fixtures";
import { resolveMockSiteId } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/nhs_claims?site_id=&page=&per_page=
//
// Mirrors the real /v1/nhs_claims, field names and types verified against live
// 2026-07-30: expected_uda and awarded_uda are STRINGS ("1.56"), submitted_date
// is a bare YYYY-MM-DD, and 52,875 rows exist.
//
// DATE FILTERING, re-calibrated by live read-only probe 2026-08-21. This route used
// to drop every date filter "matching the pessimistic assumption ... confirmed
// ignored on /v1/payments and not confirmed honoured here". The premise was wrong on
// both endpoints, and the mock enforcing it is why the UDA block could total a
// hundredth of the contract year locally and look fine.
//
//   - `after` / `before` ARE HONOURED, filtering on `submitted_date`. `before` is
//     EXCLUSIVE of the day given (live: before=<today> dropped exactly that day's
//     three claims), `after` is inclusive; callers pad both edges anyway.
//   - `start_date` / `end_date` ARE A TRAP and this mock reproduces it: live accepts
//     them and returns ZERO rows for every range, including 2000..2030. A caller that
//     copies the payments parameters onto this endpoint must see the same empty
//     answer here that it would get in production.
//   - `meta` carries `total` and `total_pages` but deliberately NO `total_amount`:
//     live publishes none, so a UDA total cannot be read from the envelope and the
//     rows genuinely have to be paged.
//   - `submitted_date_from`, `date_from`, `from` and `on` are ignored.
//   - per_page is CAPPED AT 100, and 250 silently returns 25 — not 100. Reproduced
//     here (see _paging.ts). It matters most on THIS endpoint: with no total_amount
//     in the envelope a UDA total can only be reached by paging, so a walker handed
//     a quarter-size page it never asked for stops early and calls it a whole year.
//
// site_id is honoured, on the same reasoning that it is honoured on payments.
// practitioner_id is NOT honoured, because it was not verified either: a mock
// that answers an unverified filter is how the last miscalibration got in. The
// per-practitioner UDA breakdown filters in the aggregation layer instead.
// Results come back NEWEST FIRST.
//
// Only "submitted" is a confirmed claim_status. The fixture also emits
// "approved" and "rejected", plus two rows with a status outside every
// recognised set, so callers prove they count an unfamiliar status toward
// neither the completed nor the invalid UDA figure.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const siteId = resolveMockSiteId(url.searchParams.get("site_id"));
  const page = mockPage(url.searchParams.get("page"));
  const perPage = mockPerPage(url.searchParams.get("per_page"));

  const startDate = url.searchParams.get("start_date");
  const endDate = url.searchParams.get("end_date");
  // The trap, reproduced exactly: accepted, and matching nothing.
  if (startDate !== null || endDate !== null) {
    return Response.json({ nhs_claims: [], meta: { total: 0, current_page: page, total_pages: 0 } });
  }

  let rows = siteId ? allNhsClaims().filter((c) => c.site_id === siteId) : allNhsClaims();
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  // submitted_date is a day key in these fixtures and a full ISO instant on live;
  // comparing the first ten characters is correct for both.
  if (after) rows = rows.filter((c) => day(c.submitted_date) >= after);
  if (before) rows = rows.filter((c) => day(c.submitted_date) < before);

  const start = (page - 1) * perPage;
  return Response.json({
    nhs_claims: rows.slice(start, start + perPage),
    meta: {
      total: rows.length,
      current_page: page,
      total_pages: Math.ceil(rows.length / perPage),
    },
  });
}

/** The London calendar day of a bare day key or a full ISO instant. */
function day(value: string): string {
  return value.slice(0, 10);
}
