import { getClient } from "@/lib/mock/clients";
import { requireApproverRole, requireClientAccess, requireUser } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { detectAnomalies, pairEvents } from "@/lib/clock/pairing";
import { listEvents } from "@/lib/clock/repository";
import type { RosteredShift } from "@/lib/clock/types";
import { listShifts, listStaff } from "@/lib/rota/repository";
import { getViewScope } from "@/lib/site-view";
import { londonDayEndIso, londonDayStartIso } from "@/lib/calendar/availability";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// ===========================================================================
// The practice manager's view of the clock: the raw taps over a window, the
// sessions they pair into, and the exceptions worth a look.
//
// APPROVER ONLY (requireUser -> requireClientAccess -> requireApproverRole).
// A staff member's own state comes back from GET /api/staff-check-in; this is
// the oversight surface, and oversight of other people's attendance is the
// practice manager's job, not everybody's.
//
// Everything a human reads is computed HERE, from the pure rules, so the
// component that renders it holds no opinion about what a session is.
// ===========================================================================

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** A window wider than this is a report, not a review screen. */
const MAX_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** Add whole days to a `YYYY-MM-DD` key (noon anchored, so DST cannot roll it). */
function addDays(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const url = new URL(request.url);
  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  const now = new Date();
  const today = londonDayKey(now);
  const toParam = url.searchParams.get("to") ?? "";
  const fromParam = url.searchParams.get("from") ?? "";
  const to = DAY_KEY.test(toParam) ? toParam : today;
  const requested = DAY_KEY.test(fromParam) ? fromParam : addDays(to, -6);
  // Clamp rather than refuse: a stale bookmark should still show a week.
  const earliest = addDays(to, -(MAX_WINDOW_DAYS - 1));
  const from = requested < earliest ? earliest : requested > to ? to : requested;

  const scope = await getViewScope(client.id);
  const staff = await listStaff(
    client.id,
    scope.isAllSites ? undefined : { siteIds: scope.siteIds },
  );
  const staffIds = staff.map((s) => s.id);

  const { ready, events } = await listEvents(client.id, {
    fromIso: londonDayStartIso(from),
    toIso: londonDayEndIso(to),
    staffIds,
    siteIds: scope.isAllSites ? undefined : scope.siteIds,
  });

  const shifts: RosteredShift[] = (await listShifts(client.id, from, to)).filter(
    (s) => scope.isAllSites || scope.siteIds.includes(s.siteId),
  );

  const sessions = pairEvents(events, now);
  const notes = detectAnomalies(sessions, shifts, now);

  return Response.json({
    ok: true,
    ready,
    from,
    to,
    events,
    sessions,
    notes,
    // Names for the ids, so the list does not have to fetch the rota itself.
    staff: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, siteId: s.siteId })),
  });
}
