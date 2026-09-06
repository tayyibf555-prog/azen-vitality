import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { DentallyClient } from "@/lib/dentally/client";
import { dentallyReadKey } from "@/lib/dentally/read";
import { requireClientAccess, requireOwnerRole, requireUser } from "@/lib/auth/guard";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { getClient } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";
import { miningRunSentence } from "@/lib/triage/mining";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import { runMiningSweep } from "../_mining";

// ===========================================================================
// THE OWNER'S DOOR ONTO THE IMPLANT-INTEREST MINING SCAN (ruling W3/8).
//
// "A feature with no caller is not shipped." The scan, its caveats, its coverage
// bookkeeping and its panel were all built and good, and NOTHING invoked them:
// no cron registration, no button, no runbook row. The pre-visit screen printed
// "This list has not been built yet" permanently, on a feature the practice
// owner asked for by name.
//
// So there are two doors onto one engine. The scheduler's (../mining-sweep) is
// gated on CRON_SECRET; this one is gated on the owner's session, and they share
// the lease so a click during a scheduled run is answered rather than doubling
// the practice's Dentally reads.
//
// OWNER-ONLY, which is narrower than the module's page. The page is owner +
// practice manager because she runs the interest lists; STARTING a scan spends
// the practice's shared Dentally budget on historical book, so it sits with the
// same role that edits the question banks. `requireOwnerRole` is also what both
// API coverage sweeps accept as a lock in its own right, so this route needs no
// module slug on top of it.
//
// SWITCH-GATED, DELIBERATELY. Ruling W2-C/4 named the surfaces the pre-visit
// kill switch does NOT halt — the bank editor, /api/previsit/bank and the module
// page — as a closed list with a citation, because they are preparation and
// cannot send. This is not preparation: it reads 51,000 real patients' history
// and grows a list. Not on the named list means gated, which is the fail
// direction this programme keeps. An owner who has switched the module off is
// told so plainly rather than finding the list grew anyway.
//
// BACKGROUND priority even though a person is waiting, because the alternative
// is a button that outranks the diary somebody else is booking into. A refusal
// is reported honestly instead: the scan is resumable, so "not now" costs a
// click, not a result.
// ===========================================================================

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const result = await requireUser();
  if (result instanceof Response) return result;

  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return bad("Unknown practice", 404);

  const denied = requireClientAccess(result, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(result);
  if (roleDenied) return roleDenied;

  if (!(await isSystemEnabled(client.id, TRIAGE_SYSTEM_SLUG))) {
    return Response.json({
      ok: false,
      skipped: "system off",
      message: "Pre-visit questions is switched off, so the list is not being built.",
    });
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) return bad("The practice management system is not connected here.", 503);

  // The lease name and duration are LITERALS, not the exported MINING_LOCK
  // constant, because src/lib/sweep-leases.area-b.test.ts reads them statically:
  // a lease hidden behind a variable is a lease it cannot prove outlives
  // maxDuration. Both doors must still name the SAME lease, which is pinned at
  // runtime instead — the route tests assert this call against MINING_LOCK.
  if (!(await acquireCronLock("sweep-previsit-mining", 310))) {
    return Response.json({
      ok: true,
      skipped: "another run in progress",
      message: "This list is already being built. Give it a minute and refresh.",
    });
  }

  try {
    const dentally = new DentallyClient({
      apiKey,
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      readOnly: true,
    });
    const report = await runMiningSweep({ clientId: client.id, client: dentally, now: new Date() });
    return Response.json({
      ok: true,
      ...report,
      // What the owner should be told, in the platform's own words rather than by
      // reading a counter — including the two things a bare total hides: a site
      // that stopped on its own even share of the run (W3/25), and the patients
      // the scan could not look up at all. The sentence is composed in
      // src/lib/triage/mining.ts so the rule can be tested without a route.
      message: miningRunSentence(report),
    });
  } catch (err) {
    console.error("[previsit/mining-run] scan failed", err);
    return bad("The list could not be built just now.", 500);
  } finally {
    await releaseCronLock("sweep-previsit-mining");
  }
}

export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}
