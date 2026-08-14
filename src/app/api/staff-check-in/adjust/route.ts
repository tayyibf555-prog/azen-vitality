import { getClient, getSites } from "@/lib/mock/clients";
import {
  requireApproverRole,
  requireClientAccess,
  requireSiteAccess,
  requireUser,
} from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getStaff } from "@/lib/rota/repository";
import { listEvents, recordEvent } from "@/lib/clock/repository";
import { validateAdjustment } from "@/lib/hours/adjust";
import type { ClockKind } from "@/lib/clock/types";
import { getViewScope } from "@/lib/site-view";

export const dynamic = "force-dynamic";

// ===========================================================================
// RECORDING A CORRECTION TO SOMEBODY'S ATTENDANCE.
//
// WHY THIS IS A SEPARATE ROUTE AND NOT A FLAG ON THE CLOCKING ONE.
// POST /api/staff-check-in stamps every tap with the SERVER clock and accepts no
// caller-supplied time, deliberately: backdating is not needed in order to clock
// in, and allowing it there would let anybody write yesterday into their own
// attendance. But a practice manager genuinely does need to record "she actually
// left at half past five yesterday" when somebody forgets to clock out, or the
// month can never be honestly finalised. So the correction is a DIFFERENT ACT,
// with a different guard, a mandatory reason, and its own route. The clocking
// route is untouched.
//
// APPEND ONLY, WHICH IS THE POINT. src/lib/clock/repository.ts states there is
// deliberately no update and no delete: a mistaken tap is corrected by RECORDING
// the correction (source 'admin', recorded_by stamped), never by editing the
// original away, so the pairing rules show the practice manager both the mistake
// and the correction. This route inserts one event. It changes nothing.
//
// EVERY RULE IS IN src/lib/hours/adjust.ts, where it is tested: not in the
// future, not further back than the correction window, a reason that is really a
// reason, no duplicate, and no correction that would leave two arrivals or two
// departures in a row. `validateClock` is deliberately NOT reused — it answers
// "what is the next legal tap right now", which is the wrong question for an
// event being inserted into the past.
// ===========================================================================

/**
 * How far either side of the correction the surrounding stream is read, so the
 * alternation rule can see the neighbours it judges against. A week clears any
 * ordinary gap between one shift and the next.
 */
const NEIGHBOUR_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

export async function POST(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const client = getClient(
    str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "",
  );
  if (!client) return bad("Unknown client", 404);

  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return clientDenied;

  // Recording attendance on somebody's behalf is the practice manager's act, and
  // a correction is always on somebody's behalf: there is no self-service form of
  // this. Owner, agency and the practice manager.
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  // The person is ALWAYS explicit here. There is no "resolve from my session"
  // path: a correction is by definition about somebody else's record, and an
  // endpoint that silently defaulted to the caller would be a way to quietly
  // write your own hours.
  const staffId = str(body.staffId, 60);
  if (!staffId) return bad("staffId is required");

  const kind = str(body.kind, 8);
  if (kind !== "in" && kind !== "out") return bad("kind must be 'in' or 'out'");

  const occurredAt = str(body.occurredAt, 40);
  if (!occurredAt) return bad("occurredAt is required: say when it actually happened.");

  const reason = str(body.reason, 400);
  if (!reason) return bad("Say why this is being recorded. The reason is kept with the entry.");

  const staff = await getStaff(staffId, client.id);
  if (!staff) return bad("Unknown staff member", 404);

  // Where it is recorded: an explicit site, else their home site, else the site
  // the view is on. Checked against THIS CLIENT'S sites, not merely the caller's
  // access: an agency admin spans every client, so requireSiteAccess alone would
  // let another practice's site id be stamped onto this practice's event.
  const scope = await getViewScope(client.id);
  const siteId = str(body.siteId, 60) ?? staff.siteId ?? scope.siteIds[0];
  if (!siteId || !getSites(client.id).some((s) => s.id === siteId)) {
    return bad("No site to record this against");
  }
  const siteDenied = requireSiteAccess(auth, siteId);
  if (siteDenied) return siteDenied;

  const now = new Date();
  const at = Date.parse(occurredAt);
  if (Number.isNaN(at)) return bad("That time could not be read.");

  const { ready, events } = await listEvents(client.id, {
    fromIso: new Date(at - NEIGHBOUR_WINDOW_DAYS * DAY_MS).toISOString(),
    toIso: new Date(Math.max(at, now.getTime()) + NEIGHBOUR_WINDOW_DAYS * DAY_MS).toISOString(),
    staffIds: [staffId],
  });
  if (!ready) return bad("Clocking is not switched on for this practice yet.", 503);

  const check = validateAdjustment({ staffId, kind: kind as ClockKind, occurredAt, reason }, events, now);
  if (!check.ok) return bad(check.reason, 409);

  const event = await recordEvent({
    clientId: client.id,
    siteId,
    staffId,
    kind: kind as ClockKind,
    // THE EXPLICIT TIME. This is the one thing the clocking route will not do.
    occurredAt: new Date(at).toISOString(),
    // 'admin' marks it as recorded by a manager rather than tapped by the person,
    // so the log distinguishes what happened from what was written down later.
    source: "admin",
    recordedBy: auth?.id ?? null,
    // The reason travels WITH the entry. A hand-written attendance record with no
    // explanation is the thing an employment dispute asks about first.
    note: reason,
  });

  return Response.json({ ok: true, event }, { status: 201 });
}
