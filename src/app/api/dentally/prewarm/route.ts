import { cronUnauthorized } from "@/lib/cron";
import {
  readDentallyConsumption,
  runWithDentallyPriority,
} from "@/lib/dentally/budget";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { CLIENTS, getSites } from "@/lib/mock/clients";
import { dentallyReadKey, prewarmOutstanding, OUTSTANDING_TTL_MS } from "@/lib/dentally/read";
import { DASHBOARD_TTL_MS, prewarmPracticeDashboard } from "@/lib/dashboard/read";

export const dynamic = "force-dynamic";
// The compute is the FULL cold assembly (six 90-day dashboard scans + the outstanding
// book scan) per client, so it is bounded by the same 300s ceiling the Dentally syncs
// use. The cron lease below OUTLIVES this (maxDuration + 10) so the lock is never
// released by expiry before the platform force-kills a run at the ceiling — which
// would otherwise let the next tick start on top of a dying one.
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// DENTALLY DISPLAY-CACHE PRE-WARM  (scheduler-only; CRON_SECRET-gated)
// ---------------------------------------------------------------------------
// Eliminates the last cold load. The L2 display cache + stale-while-revalidate mean
// no user waits ONCE a row exists; this job makes sure a row always exists, for every
// active client, so even the first read of the day is a warm read. For each live
// client it recomputes the two heavy DISPLAY reads — the practice dashboard and the
// outstanding book — and stamps them into L2 with a ttl that OUTLIVES the cron
// interval, so the pre-warmed rows stay FRESH between runs (a normal read is then a
// fresh L2 hit, not a stale-serve + background re-page).
//
// BUDGET. THE PARAGRAPH THAT USED TO BE HERE SAID THIS JOB SAT "COMFORTABLY INSIDE
// THE 3,600/HOUR DENTALLY BUDGET". IT DID NOT, AND ON 2026-08-20 IT TOOK THE WHOLE
// PRACTICE OFFLINE: every Dentally read from production answered
// 403 "Rate limit exceeded" for the working day, because this job ran FOUR TIMES AN
// HOUR and each run re-paged three sites x six 90-day scans (up to 40 pages of 100
// rows each) plus the outstanding book. That is on the order of 2,400 requests an
// hour spent on a cache nobody was waiting for. The job was disabled by hand to stop
// the bleeding.
//
// Three things changed so it cannot do that again:
//
//   1. CADENCE. HOURLY, not every fifteen minutes (register file:
//      supabase/ops/register-dentally-prewarm-cron.sql). One assembly per live
//      client per hour, with the arithmetic in that file.
//   2. CLASS. The whole handler runs inside runWithDentallyPriority("background"),
//      so it draws from the class that is refused FIRST — at 60% of the hour's
//      budget. However expensive this job becomes, it can no longer be the reason a
//      practice manager's dashboard or a patient's booking calendar goes blank; it
//      simply gets refused and the L2 rows are served stale instead.
//   3. PURPOSE. It no longer tries to keep the rows FRESH between runs. An expired
//      L2 row is still SERVED (stale-while-revalidate, see display-cache.ts), so
//      freshness costs nothing to guarantee and everything to pre-pay. What actually
//      needs guaranteeing is that a row EXISTS at all, because only a MISSING row
//      makes someone wait through a synchronous cold assembly. So this job warms to
//      the SAME ttl the reader's own refresh uses, and freshness beyond that is paid
//      by the reads that actually happen — cost following attention.
//
// The run reports the practice's current hourly consumption in its response body so
// a human can see what the platform is spending without reading Dentally's headers.
//
// GET and POST both run it: public.trigger_app_cron() drives the other jobs by POST,
// and the scout specified a GET route, so both verbs share one handler and either
// trigger works. Fail-closed on CRON_SECRET, exactly like the sync routes.
// ---------------------------------------------------------------------------

// TTL stamped on the pre-warmed rows: the SAME freshness contract a reader's own
// refresh uses (DASHBOARD_TTL_MS, 15 minutes), deliberately SHORTER than the hourly
// interval rather than longer than it.
//
// The old rule was "ttl must outlive the interval so the row is always fresh", and
// it is the rule that made this job expensive: keeping a row fresh means re-paying
// the assembly on a schedule whether or not anyone looks at it. It is also
// unnecessary. A row that has expired has NOT gone: display-cache serves it stale,
// immediately, carrying its own honest "Stats updated" stamp, and refreshes behind
// the response. Only a MISSING row costs a human a synchronous wait, and a row goes
// missing only on a true first assembly or after an invalidation — which is the
// narrow job this cron actually has.
//
// DERIVED, not repeated. The two used to be separate numbers kept in step by a
// comment, and the comment is what drifted: the pre-warm stamped twenty minutes
// while a reader's own refresh stamped sixty seconds, so the moment a cron tick was
// skipped the shared row expired every minute and every instance re-paged the book.
// One constant cannot drift from itself.
const PREWARM_TTL_MS = DASHBOARD_TTL_MS;

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  const apiKey = dentallyReadKey();
  if (!apiKey) {
    return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });
  }
  // A run can take tens of seconds; the lease stops the next tick starting a second
  // one on top of it. Fail-safe: a held lease skips this tick (the next one retries),
  // never doubles the Dentally load. Lease = maxDuration + 10, so it outlives a
  // force-killed run (repo invariant: sweep-leases.area-b.test.ts).
  if (!(await acquireCronLock("dentally-prewarm", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const results: Array<{ clientId: string; dashboard: string; outstanding: string }> = [];
    // Only LIVE clients: an onboarding/paused practice has no one reading its
    // dashboard, so warming it would spend the budget for nothing.
    for (const client of CLIENTS.filter((c) => c.status === "live")) {
      const siteIds = getSites(client.id).map((s) => s.id);
      const now = new Date();
      // The two reads are independent; one failing must not lose the other, and one
      // client failing must not abort the loop. allSettled keeps every warm we can get.
      const [dash, out] = await Promise.allSettled([
        prewarmPracticeDashboard(client.id, now, PREWARM_TTL_MS),
        // Stamped with the OUTSTANDING read's own constant, not the dashboard's.
        // They are the same fifteen minutes today; deriving each from the read it
        // warms is what stops a future change to one silently re-stamping the other
        // back onto the expiry treadmill.
        prewarmOutstanding(siteIds, OUTSTANDING_TTL_MS),
      ]);
      if (dash.status === "rejected") {
        console.error(`[dentally-prewarm] dashboard warm failed for ${client.id}`, dash.reason);
      }
      if (out.status === "rejected") {
        console.error(`[dentally-prewarm] outstanding warm failed for ${client.id}`, out.reason);
      }
      results.push({ clientId: client.id, dashboard: dash.status, outstanding: out.status });
    }
    // Emit what the platform has spent of the practice's hourly Dentally quota, so
    // the answer to "are we near the ceiling again" is in the cron log rather than
    // in Dentally's response headers, which nobody reads until reads start failing.
    const budget = await readDentallyConsumption();
    return Response.json({ ok: true, ttlMs: PREWARM_TTL_MS, warmed: results, budget });
  } catch (err) {
    console.error("[dentally-prewarm] run failed", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  } finally {
    await releaseCronLock("dentally-prewarm");
  }
}

// THE PRE-WARM IS BACKGROUND WORK, AND THAT IS THE WHOLE POINT.
//
// This job, at */15, is what emptied the practice's Dentally quota on 2026-08-20 and
// left every read 403ing for the working day. Running it inside the background scope
// means it now spends from the class that is refused FIRST — at 60% consumption —
// so however expensive it becomes, it can never again outcompete a practice manager
// opening the diary or a patient loading the booking calendar. A refusal ends this
// run cleanly (the scans throw, allSettled records it, the L2 rows simply age); the
// next hour's tick warms them instead.
//
// THAT SENTENCE IS NOW TRUE. It was written as the intent and was not what happened:
// every scan in dashboard/read.ts and the outstanding scan absorbed the refusal and
// returned a complete BLANK, which prewarmPracticeDashboard / prewarmOutstanding then
// stamped over the practice's good cached figures with a fresh TTL — four blank
// dashboards a day, every busy afternoon, because background is the class refused
// first. The refusal now propagates (DentallyBudgetExceededError, see
// src/lib/dentally/client.ts rethrowIfBudgetRefused), so the warm functions never
// reach their write, allSettled records "rejected", and the existing rows are left
// untouched and keep being served. src/lib/dashboard/budget-refusal-not-cached.test.ts
// pins it.
export function GET(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

export function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}
