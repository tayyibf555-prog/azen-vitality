import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { allNhsClaims } from "@/app/api/mock-dentally/_finance-fixtures";
import { resolveMockSiteId } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/nhs_claims?site_id=&page=&per_page=
//
// Mirrors the real /v1/nhs_claims, field names and types verified against live
// 2026-07-30: expected_uda and awarded_uda are STRINGS ("1.56"), submitted_date
// is a bare YYYY-MM-DD, and 52,875 rows exist.
//
// Date filters are IGNORED here, matching the pessimistic assumption. They are
// confirmed ignored on /v1/payments and were not confirmed honoured here, so the
// mock behaves as though they are dropped: a caller built against this mock
// cannot come to depend on server-side date filtering that live may not provide.
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
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);

  const rows = siteId ? allNhsClaims().filter((c) => c.site_id === siteId) : allNhsClaims();
  const start = (page - 1) * perPage;

  return Response.json({ nhs_claims: rows.slice(start, start + perPage) });
}
