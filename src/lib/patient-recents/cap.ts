// ---------------------------------------------------------------------------
// THE RECENTS RULE, IN ONE PURE FUNCTION.
//
// WHY IT IS HERE AND NOT IN THE QUERY OR THE COMPONENT, which are the two places
// it would naturally have ended up.
//
//   IN THE QUERY: `order(viewed_at desc).limit(8)` looks like the whole feature,
//   and the unique constraint in migration 0095 looks like it makes the dedupe
//   unnecessary. Both are true only for as long as they stay true. This rule
//   decides WHICH PATIENT NAMES APPEAR ON A SCREEN, and one of its clauses is a
//   confidentiality boundary (the site scope), so it has to be provable in
//   isolation. A predicate inside a PostgREST chain cannot be run against a table
//   of awkward inputs; this can, and cap.test.ts does exactly that.
//
//   IN THE COMPONENT: the strip would then have to be rendered to be questioned,
//   and every rule below would be tested through JSX rather than as itself.
//
// This module is a plain .ts with no "use client", no server-only and no imports.
// That is deliberate: the record shell and the patients view are SERVER
// components, and a shared module that becomes a client component while a server
// file imports a VALUE from it is the crash this repo already shipped once
// (commit 0958619). Nothing here can drift into that shape.
// ---------------------------------------------------------------------------

/** How many patients the strip shows. Eight is Dentally's own recents depth, and
 *  it is the number that fits on one row at practice screen widths without the
 *  strip becoming a second patients list. */
export const RECENTS_LIMIT = 8;

/**
 * One patient this user opened, as the strip needs it.
 *
 * `viewedAt` is whatever the database handed back, unparsed. PostgREST returns
 * timestamptz as ISO with a numeric offset and microsecond precision
 * ("2026-08-31T10:00:00.123456+00:00"), which is why nothing in this file
 * compares these as strings — see `at()`.
 */
export interface RecentPatientRow {
  patientId: string;
  name: string;
  siteId: string;
  viewedAt: string;
}

/**
 * A recents read, and WHETHER IT SUCCEEDED.
 *
 * The flag is the honesty carrier and it is not optional. "This user has opened
 * no patients" and "we could not read this user's recents" are different facts,
 * and the house rule (PanelEmpty vs PanelFailed, on the patient record) is that
 * they must never render alike. Callers get the flag so that a future empty-state
 * sentence can only ever hang off `ok === true`.
 */
export interface RecentsRead {
  ok: boolean;
  patients: RecentPatientRow[];
}

/**
 * Sortable instant for a stored timestamp, or NEGATIVE INFINITY when it cannot be
 * read.
 *
 * A row whose viewed_at is unparseable sorts OLDEST, never newest. The failure
 * mode being avoided is specific: if an unreadable timestamp scored as "now"
 * (Date.parse -> NaN, and NaN in a comparator quietly means "leave it where it
 * is"), one corrupt row would pin itself to the front of the strip and, because
 * the dedupe keeps whichever copy sorts first, would also win the dedupe against
 * a perfectly good newer reading of the same patient. Sorting it last means the
 * worst a corrupt row can do is fall off the end of an eight-item list.
 */
function at(viewedAt: string): number {
  const t = Date.parse(viewedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * The strip's list: in-scope, newest first, one row per patient, at most
 * RECENTS_LIMIT of them.
 *
 * THE ORDER OF THE THREE STEPS IS THE RULE, not an implementation detail.
 *
 *   1. SCOPE FIRST. `siteIds` is the site-switcher selection (src/lib/site-view.ts).
 *      A patient the user opened at another site is dropped rather than shown,
 *      for two reasons: the record shell notFound()s a patient outside scope, so
 *      the link would be dead; and the NAME ITSELF is the leak, since a strip
 *      that lists names from a site the viewer has scoped away has published them
 *      before any click happens. An EMPTY `siteIds` means nothing is in scope and
 *      returns nothing — fail closed, never "no filter means show everything",
 *      which is the direction this class of bug always fails in.
 *
 *   2. DEDUPE BEFORE CAPPING, which is the clause a naive implementation gets
 *      backwards. Cap-then-dedupe takes eight rows and then collapses them, so a
 *      user who reopened one patient three times would see a six-name strip and
 *      never understand why. Deduping first means a repeated patient costs one
 *      slot however many times it was opened. The database's unique constraint
 *      should make duplicates impossible; this does not TRUST that, because the
 *      cost of being wrong is a silently short list and the cost of the check is
 *      a Set.
 *
 *   3. CAP LAST.
 *
 * The sort is by parsed instant, descending, and Array#sort is stable, so two
 * rows written in the same millisecond keep the order the database returned them
 * in rather than swapping unpredictably between renders.
 */
export function selectRecents(
  rows: readonly RecentPatientRow[],
  siteIds: readonly string[],
): RecentPatientRow[] {
  const inScope = new Set(siteIds);
  // FILTER BEFORE SORT, and not only because it is cheaper. Array#sort is IN
  // PLACE, and `rows` comes straight off a database read the caller may still be
  // holding. `.filter()` returns a fresh array, so sorting its result is safe —
  // which means the safety here is a consequence of the ORDER of these two calls,
  // not of any defensive copy. Swap them and the sort reorders the caller's own
  // rows. (An explicit `.slice()` used to sit between them, with a comment
  // claiming it was the guard; it was dead, because `.filter()` had already
  // copied, and no mutation of it could make a test go red. The rule is pinned by
  // "does not mutate the caller's array" in cap.test.ts instead.)
  const newestFirst = rows
    .filter((r) => inScope.has(r.siteId))
    .sort((a, b) => at(b.viewedAt) - at(a.viewedAt));

  const seen = new Set<string>();
  const deduped: RecentPatientRow[] = [];
  for (const row of newestFirst) {
    if (seen.has(row.patientId)) continue; // an older copy of a patient already taken
    seen.add(row.patientId);
    deduped.push(row);
  }

  return deduped.slice(0, RECENTS_LIMIT);
}
