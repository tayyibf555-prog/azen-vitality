// ===========================================================================
// PAGE SIZING, AS LIVE DENTALLY ACTUALLY DOES IT.
//
// Every list route in this mock used to honour whatever `per_page` it was handed:
// ask for 500 and you got 500. Live does not do that, and the difference is not a
// rounding detail — it is the exact shape of bug this mock exists to catch.
//
// MEASURED AGAINST LIVE, 2026-08-21, read-only key (recorded on listPayments and
// listNhsClaims in src/lib/dentally/client.ts):
//
//     per_page=100   ->  100 rows
//     per_page=200   ->   25 rows
//     per_page=250   ->   25 rows
//     per_page=500   ->   25 rows
//
// THE TRAP IS THE 25, NOT THE CAP. A cap that clamped 500 down to 100 would be
// merely disappointing; a caller that asked for 500 and quietly received 25 has
// been handed a page a QUARTER the size it already expected, with a 200 status and
// no complaint anywhere in the envelope. A pageAll walker reading `rows.length <
// perPage` as "that was the last page" therefore stops after 25 rows of a 30,000
// row index and reports a complete read. That is precisely how the takings and UDA
// figures came to be understated by 38% and 85% while every local test was green.
//
// So the mock reproduces the MEASURED behaviour rather than the tidy one. A mock
// that models an API's limitation has to be right about the limitation: one that is
// looser than live lets tests pass on behaviour live will refuse, and one that is
// tidier than live (clamping to 100) hides the very cliff a caller falls off.
//
// Below the cap nothing is second-guessed — per_page=1 means one row, which is what
// makes the single-request windowed total on /v1/payments possible.
// ===========================================================================

/** The largest page live Dentally will actually serve. */
export const DENTALLY_PER_PAGE_CAP = 100;

/**
 * What live silently falls back to when `per_page` exceeds the cap. It is the API's
 * own default page size, handed back with no indication that the request was not
 * honoured.
 */
export const DENTALLY_OVER_CAP_PER_PAGE = 25;

/**
 * The number of rows live Dentally would put on a page for this `per_page`.
 *
 * `raw` is the query-string value exactly as it arrived (null when absent).
 * `fallback` is the page size to use when it is absent or unreadable; every route
 * here uses 100, matching what DentallyClient sends on every list read.
 *
 * Anything at or under the cap is honoured. Anything over it collapses to 25, which
 * is what live does. Unreadable and non-positive values fall back rather than
 * erroring, because a 400 on a malformed per_page has NOT been observed on live and
 * inventing one would be the same class of mistake in the other direction.
 */
export function mockPerPage(raw: string | null, fallback: number = DENTALLY_PER_PAGE_CAP): number {
  const requested = Math.max(1, Number(raw ?? String(fallback)) || fallback);
  return requested > DENTALLY_PER_PAGE_CAP ? DENTALLY_OVER_CAP_PER_PAGE : requested;
}

/** The 1-based page number a request asked for. Unreadable values mean page 1. */
export function mockPage(raw: string | null): number {
  return Math.max(1, Number(raw ?? "1") || 1);
}
