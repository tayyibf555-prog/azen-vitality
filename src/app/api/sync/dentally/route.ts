import { cronUnauthorized } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ===========================================================================
// RETIRED 2026-07-26. This route no longer does anything, on purpose.
//
// It was the original whole-practice treatment-plan pull, written before the
// four per-module syncs existed. It is superseded by /api/sync/coordinator,
// which writes the SAME treatment_opportunity rows, and every reason to keep it
// has gone:
//
//   * It read `amount_outstanding` off the plan. That field does not exist on
//     live Dentally treatment plans, so against the real API it mapped every
//     plan to 0 outstanding and produced nothing at all.
//   * It had NO backfill cursor. Dentally's plan index is unordered, so it
//     jumped its high-water mark to the newest updated_at among the first 300
//     plans it happened to see and then permanently excluded everything older.
//     It could never have loaded the historic 84,806 plans.
//   * It spent one getPatient call PER PLAN purely to site-scope the row.
//   * Two writers on one table with different mappings is worse than one
//     correct writer: whichever ran last won, with different numbers.
//   * Its site-discovery block mirrored /v1/sites into a `dentally_site` table
//     that nothing in the product ever reads, and the real site UUIDs are now
//     hard-coded in SITES.
//   * Its pg_cron job is disabled and last ran on 2026-07-05.
//
// It answers 410 Gone rather than quietly succeeding, so that re-enabling the
// old cron job fails visibly instead of looking healthy while doing nothing.
// The cron-contract lines below (auth guard, GET = POST, maxDuration) are kept
// deliberately: the shared static test in src/lib/cron.area4-cron-auth.test.ts
// enumerates this path, and removing the FILE needs that list edited too.
//
// To finish the job (one small change in a file this module does not own):
//   1. drop "src/app/api/sync/dentally/route.ts" from SHARED_GUARD_ROUTES in
//      src/lib/cron.area4-cron-auth.test.ts,
//   2. delete this file, its sibling test, and the now-orphaned
//      src/lib/dentally/normalise.ts,
//   3. unregister the app-sync-dentally pg_cron job.
// ===========================================================================

export async function POST(request: Request) {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  console.error(
    "[sync-dentally] RETIRED endpoint was called. Treatment plans are synced by " +
      "/api/sync/coordinator; unregister the app-sync-dentally cron job.",
  );
  return Response.json(
    {
      ok: false,
      retired: true,
      supersededBy: "/api/sync/coordinator",
      reason:
        "The whole-practice treatment-plan pull is superseded by the per-module coordinator sync. " +
        "It read an amount_outstanding field that does not exist on live Dentally plans and had no backfill cursor.",
    },
    { status: 410 },
  );
}

// Vercel Cron triggers with GET; reuse the same handler.
export const GET = POST;
