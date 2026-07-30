import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { allPayments } from "@/app/api/mock-dentally/_finance-fixtures";
import { resolveMockSiteId } from "@/app/api/mock-dentally/_fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/payments?site_id=&page=&per_page=
//
// Mirrors the real /v1/payments, verified against live 2026-07-30, INCLUDING its
// most awkward behaviour:
//
//   - DATE FILTERS ARE IGNORED. filter[from], from and dated_on_from all come
//     back with the full set on live. This mock ignores them too, on purpose. A
//     mock that quietly honoured a filter the real API drops would hide the one
//     constraint the whole takings design is built around: a period total has to
//     be assembled by paging backwards from today until the boundary is passed.
//     That is cheap for today and yesterday and far too slow for ninety days,
//     which is why the long periods are served from the stored daily rollup.
//   - site_id IS honoured (on live it drops the set from 40,243 to 7,784).
//   - Results come back NEWEST FIRST.
//
// Amounts are STRINGS ("27.9"), dates are bare YYYY-MM-DD, and `deleted` is a
// boolean. One fixture row carries a malformed amount so callers must prove they
// drop it rather than counting it as zero.
export async function GET(request: Request): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const siteId = resolveMockSiteId(url.searchParams.get("site_id"));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);

  // Deliberately NOT read: filter[from], from, dated_on_from, before, after.
  // The live API ignores them, so this one does too.
  const rows = siteId ? allPayments().filter((p) => p.site_id === siteId) : allPayments();
  const start = (page - 1) * perPage;

  return Response.json({ payments: rows.slice(start, start + perPage) });
}
