import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { DentallyClient } from "@/lib/dentally/client";
import { dentallyReadKey } from "@/lib/dentally/read";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import { runMiningSweep } from "../_mining";

// ===========================================================================
// THE SCHEDULER'S DOOR ONTO THE IMPLANT-INTEREST MINING SCAN.
//
// The scan itself lives in ../_mining.ts, because it has a second door: the
// owner's "Build / refresh candidates" action (../mining-run), added under
// ruling W3/8 — "a feature with no caller is not shipped". This file owns the
// cron secret, the kill switch, the lease and the priority scope; the engine
// owns the bounds and the coverage bookkeeping.
//
// NOT REGISTERED IN cron.job AS AT 4 SEP 2026. The runbook carries the exact
// registration SQL (ruling W3/7: the runbook states registration truth) and the
// practice runs it; until then the owner's button is the only caller, which is
// why the button exists.
// ===========================================================================

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLIENT_ID = "vitality";

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const unauth = cronUnauthorized(request);
  if (unauth) return unauth;

  // The kill switch, fail-closed for this default-off slug. Switching the module
  // off stops the list being built as well as the sends: a practice that has
  // turned the feature off should not find its implant list has grown overnight.
  if (!(await isSystemEnabled(CLIENT_ID, TRIAGE_SYSTEM_SLUG))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  // One scan at a time across BOTH doors: the owner's button takes the same
  // lease, so a click during a scheduled run is answered rather than doubling
  // the practice's Dentally reads. The lease outlives maxDuration (300s).
  // The lease name and duration are LITERALS, not the exported MINING_LOCK
  // constant, because src/lib/sweep-leases.area-b.test.ts reads them statically:
  // a lease hidden behind a variable is a lease it cannot prove outlives
  // maxDuration. Both doors must still name the SAME lease, which is pinned at
  // runtime instead — the route tests assert this call against MINING_LOCK.
  if (!(await acquireCronLock("sweep-previsit-mining", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const client = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      readOnly: true,
    });
    const report = await runMiningSweep({ clientId: CLIENT_ID, client, now: new Date() });
    return Response.json({ ok: true, ...report });
  } finally {
    await releaseCronLock("sweep-previsit-mining");
  }
}

export async function POST(request: Request): Promise<Response> {
  // BACKGROUND priority. This is a nightly job walking historical book, and it
  // shares the practice's 3,600/hour budget with everything a person is looking
  // at right now; it must be the first thing refused when the practice is busy.
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

export async function GET(request: Request): Promise<Response> {
  return POST(request);
}
