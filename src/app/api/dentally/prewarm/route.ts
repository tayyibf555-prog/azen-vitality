import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { CLIENTS, getSites } from "@/lib/mock/clients";
import { dentallyReadKey, prewarmOutstanding } from "@/lib/dentally/read";
import { prewarmPracticeDashboard } from "@/lib/dashboard/read";

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
// BUDGET. This is the ONLY path that now pays the full scan on live Dentally: user
// reads are served from L2, and the per-instance SWR refresh only fires in the gaps
// this job's fresh window leaves. Computed ONCE here (a single cron instance), it does
// not fan out across the fleet the way uncoordinated cold navigations used to — the
// July rate-limit incident this whole cache exists to prevent. Worst case is one full
// assembly per live client per run (early-stopping page walks make it far less in
// practice); at */15 that is comfortably inside the 3,600/hour Dentally budget for the
// single live client, with headroom for the lifecycle sweeps and syncs. If a second
// live client is onboarded, or 429s appear, widen the cadence (register file:
// supabase/ops/register-dentally-prewarm-cron.sql) to */20 or */30 and raise the ttl
// in lockstep so it still outlives the interval.
//
// GET and POST both run it: public.trigger_app_cron() drives the other jobs by POST,
// and the scout specified a GET route, so both verbs share one handler and either
// trigger works. Fail-closed on CRON_SECRET, exactly like the sync routes.
// ---------------------------------------------------------------------------

// TTL stamped on the pre-warmed rows: 20 min > the 15-minute cron interval + a 5 min
// slack for a slow or lock-skipped run, so a pre-warmed row is still fresh when the
// next run writes over it. If the cron stops entirely, the rows simply age into SWR
// territory (served stale + refreshed on read), never back to a synchronous 40s cold
// scan.
const PREWARM_TTL_MS = 20 * 60_000;

async function handle(request: Request): Promise<Response> {
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
        prewarmOutstanding(siteIds, PREWARM_TTL_MS),
      ]);
      if (dash.status === "rejected") {
        console.error(`[dentally-prewarm] dashboard warm failed for ${client.id}`, dash.reason);
      }
      if (out.status === "rejected") {
        console.error(`[dentally-prewarm] outstanding warm failed for ${client.id}`, out.reason);
      }
      results.push({ clientId: client.id, dashboard: dash.status, outstanding: out.status });
    }
    return Response.json({ ok: true, ttlMs: PREWARM_TTL_MS, warmed: results });
  } catch (err) {
    console.error("[dentally-prewarm] run failed", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  } finally {
    await releaseCronLock("dentally-prewarm");
  }
}

export function GET(request: Request): Promise<Response> {
  return handle(request);
}

export function POST(request: Request): Promise<Response> {
  return handle(request);
}
