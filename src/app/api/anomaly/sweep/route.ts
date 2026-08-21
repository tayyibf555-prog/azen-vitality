import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { isSystemEnabled } from "@/lib/systems/repository";
import { collectReadings } from "@/lib/anomaly/collect";
import { detectAnomalies } from "@/lib/anomaly/detect";
import { planPass } from "@/lib/anomaly/dedupe";
import {
  insertAlert,
  listAlerts,
  refreshAlert,
  reraiseAlert,
  resolveAlerts,
} from "@/lib/anomaly/repository";

// ===========================================================================
// THE ANOMALY PASS. It looks, it decides, and it writes one row per condition.
//
// IT SENDS NOTHING. There is no outbox in this module, no drain source, no
// Twilio call and no email. The only delivery is the in-app notifications feed,
// which reads the alert table on page load. If an owner SMS or email channel is
// ever wanted, it goes through the shared drain with its own toggle and its own
// per-module outbox tables, like every other sending surface in this platform —
// and it is deliberately not built here, because a monitoring system that can
// wake somebody at 3am is a different product with different consent questions.
//
// IT MAKES NO DECISION A HUMAN CANNOT UNDO. Every write lands in `anomaly_alert`
// and nowhere else: no patient record, no diary, no cadence, no touch, no
// outbox. Switching the system off stops the pass entirely, and the alerts it
// already raised stop being read by the feed on the same flip.
//
// GATED THREE WAYS, DELIBERATELY:
//   1. CRON_SECRET, fail-closed in production (src/lib/cron.ts).
//   2. A cron lease, so two ticks cannot both raise the same condition.
//   3. 'anomaly-alerts' is defaultEnabled:false in the systems catalog, so the
//      ABSENCE of a toggle row means DISABLED for every client in every database
//      — including one where migration 0093 was never applied. The migration
//      seeds an explicit disabled row as well; the two are independent on
//      purpose, because a seed only covers the clients it was applied to.
// ===========================================================================

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CLIENT_ID = "vitality";

async function handle(request: Request): Promise<Response> {
  const unauthorized = cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  // Read the switch BEFORE taking the lease: a disabled system should cost
  // nothing at all, not a lease plus a no-op.
  if (!(await isSystemEnabled(CLIENT_ID, "anomaly-alerts"))) {
    return Response.json({ ok: true, skipped: "system off" });
  }

  // The lease outlives maxDuration (130 > 120) so a run killed at the platform
  // limit cannot have its lease expire underneath a run that is still going.
  if (!(await acquireCronLock("sweep-anomaly", 130))) {
    return Response.json({ ok: true, skipped: "another run holds the lease" });
  }

  const now = new Date();
  try {
    // The store is read FIRST, and a failure to read it is fatal to the PASS
    // rather than silent: without it there is no way to tell a new condition from
    // one already on the screen, and guessing would mean re-raising everything the
    // owner has already seen.
    //
    // It goes first so the collector can be told which conditions are already
    // open. That is not an optimisation, it is the resolve direction of the
    // honesty rule: a collector whose query cannot reach an open condition any
    // more (a lead aged past speed-to-lead's 48-hour lookback, say) has to either
    // check it directly or declare it unproven, and it can do neither for a row
    // it does not know exists. See collectLeads.
    const stored = await listAlerts(CLIENT_ID);
    const openKeys = stored.filter((row) => row.resolvedAt === null).map((row) => row.dedupeKey);

    const { readings, unproven, refusals } = await collectReadings(CLIENT_ID, now, openKeys);
    const raised = detectAnomalies(readings);

    const plan = planPass(raised, stored, unproven, now);

    for (const alert of plan.insert) await insertAlert(CLIENT_ID, alert, now);
    for (const alert of plan.refresh) await refreshAlert(CLIENT_ID, alert, now);
    for (const alert of plan.reraise) await reraiseAlert(CLIENT_ID, alert, now);
    await resolveAlerts(CLIENT_ID, plan.resolve, now);

    return Response.json({
      ok: true,
      detected: raised.length,
      raised: plan.insert.length + plan.reraise.length,
      refreshed: plan.refresh.length,
      held: plan.hold.length,
      resolved: plan.resolve.length,
      // Named, not swallowed: "nothing is wrong" and "we could not look" have to
      // be tellable apart by whoever is reading the job's output.
      refused: refusals,
    });
  } catch (err) {
    console.error("[anomaly] sweep failed", err);
    return Response.json({ ok: false, error: "sweep failed" }, { status: 500 });
  } finally {
    await releaseCronLock("sweep-anomaly");
  }
}

/**
 * BACKGROUND priority for the whole handler. The one Dentally-touching read in
 * the pass is the shared practice dashboard, and an alerting job must never take
 * quota ahead of a receptionist with a patient on the phone. A refusal from the
 * budget guard is not an error here: it produces an unavailable takings cell, the
 * detector refuses on it, and the run names the refusal instead of a figure.
 */
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handle(request));
}

/** GET is the manual trigger, same guards, same work. */
export async function GET(request: Request): Promise<Response> {
  return POST(request);
}
