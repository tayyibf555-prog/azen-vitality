import { getClient, getSites } from "@/lib/mock/clients";
import {
  requireApproverRole,
  requireClientAccess,
  requireSiteAccess,
  requireUser,
} from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { buildTodayView, validateClock } from "@/lib/clock/pairing";
import { findStaffByAppUser, listEvents, listEventsForDay, recordEvent } from "@/lib/clock/repository";
import type { ClockKind, ClockStaff, RosteredShift } from "@/lib/clock/types";
import { getStaff, listShifts, listStaff } from "@/lib/rota/repository";
import { getViewScope } from "@/lib/site-view";
import { londonDayStartIso } from "@/lib/calendar/availability";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// ===========================================================================
// Staff clocking in and out.
//
// GET  -> today's state for everyone the caller may see, already computed.
// POST -> record one clock event, after the SERVER re-checks that it is a legal
//         tap. The UI only ever offers the valid action, but a button is a
//         suggestion; validateClock is the rule.
//
// TWO CALLERS, TWO PATHS, ONE ENDPOINT:
//
//   Self service. No staffId in the body. The staff record is resolved from the
//   caller's verified session (rota_staff.app_user_id, added in 0068), never
//   from the request. An endpoint that trusted a body-supplied staffId would let
//   anybody clock anybody in, which is the whole reason B6 was raised.
//
//   Manager recorded. A staffId in the body for somebody else. Gated on
//   requireApproverRole, stamped with source 'admin' and recorded_by, so the log
//   says who pressed the button as well as who it was about.
//
// The tap is always stamped with the SERVER clock. There is deliberately no
// caller-supplied timestamp: backdating an event is a correction, corrections
// have their own ordering problems, and none of that is needed to clock in.
// ===========================================================================

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Add whole days to a `YYYY-MM-DD` key (noon anchored, so a DST hour cannot roll it). */
function addDays(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** Staff rows reduced to what the clocking rules need. */
function toClockStaff(rows: { id: string; name: string; role: string; siteId: string | null }[]): ClockStaff[] {
  return rows.map((s) => ({ id: s.id, name: s.name, role: s.role, siteId: s.siteId }));
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

  // Approvers (owner, agency admin, practice manager) see the whole team.
  // Anybody else sees exactly one row: their own. The list is narrowed here
  // rather than hidden in the UI, so a direct call returns no more than the page.
  const canManage = requireApproverRole(auth) === null;

  const now = new Date();
  const dayParam = url.searchParams.get("day") ?? "";
  const dayKey = DAY_KEY.test(dayParam) ? dayParam : londonDayKey(now);

  const scope = await getViewScope(client.id);
  const me = auth ? await findStaffByAppUser(client.id, auth.id) : null;

  const allStaff = await listStaff(
    client.id,
    scope.isAllSites ? { activeOnly: true } : { activeOnly: true, siteIds: scope.siteIds },
  );
  const visible = canManage ? toClockStaff(allStaff) : toClockStaff(allStaff.filter((s) => s.id === me?.id));

  const { ready, events } = await listEventsForDay(client.id, dayKey, {
    staffIds: visible.map((s) => s.id),
    siteIds: scope.isAllSites ? undefined : scope.siteIds,
  });

  // Today's rota, so the view can say who is expected as well as who is here.
  const visibleIds = new Set(visible.map((s) => s.id));
  const shifts: RosteredShift[] = (await listShifts(client.id, dayKey, dayKey)).filter(
    (s) => visibleIds.has(s.staffId) && (scope.isAllSites || scope.siteIds.includes(s.siteId)),
  );

  const view = buildTodayView({ staff: visible, events, shifts, now, dayKey });

  return Response.json({
    ok: true,
    // False only while migration 0068 is unapplied. The page says so out loud
    // rather than rendering an empty day as though nobody turned up.
    ready,
    canManage,
    me,
    view,
    scope: { label: scope.label, isAllSites: scope.isAllSites },
  });
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

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const kind = str(body.kind, 8);
  if (kind !== "in" && kind !== "out") return bad("kind must be 'in' or 'out'");

  const me = auth ? await findStaffByAppUser(client.id, auth.id) : null;
  const askedFor = str(body.staffId, 60);
  const targetId = askedFor ?? me?.id;

  if (!targetId) {
    return bad(
      "Your login is not linked to a staff record, so you cannot clock yourself in. Ask the practice manager to record it.",
      409,
    );
  }

  // Recording somebody ELSE's attendance is the practice manager's job, and the
  // event is marked as theirs.
  //
  // TWO DIFFERENT CAPABILITIES, because they are two different acts. Clocking
  // yourself in is something everybody who works here does; recording it for
  // somebody else is a manager's act that writes into another person's pay-
  // relevant record. The branch already existed for the ROLE check — this adds
  // the per-person one on the same fork, so an owner can withhold either from
  // one named individual without touching the other.
  const onBehalf = targetId !== me?.id;
  if (onBehalf) {
    const roleDenied = requireApproverRole(auth);
    if (roleDenied) return roleDenied;
    const capabilityDenied = await requireCapability(auth, "people.clock.record-for-other");
    if (capabilityDenied) return capabilityDenied;
  } else {
    const capabilityDenied = await requireCapability(auth, "people.clock.self");
    if (capabilityDenied) return capabilityDenied;
  }

  const staff = await getStaff(targetId, client.id);
  if (!staff || !staff.active) return bad("Unknown staff member", 404);

  // Where the tap is recorded: an explicit site, else the staff member's home
  // site, else whichever site the view is on (a floating nurse covering today).
  // Checked against THIS CLIENT'S sites, not just the caller's access: an agency
  // admin spans every client, so requireSiteAccess alone would let a site id from
  // another practice be stamped onto this practice's event.
  const scope = await getViewScope(client.id);
  const siteId = str(body.siteId, 60) ?? staff.siteId ?? scope.siteIds[0];
  if (!siteId || !getSites(client.id).some((s) => s.id === siteId)) {
    return bad("No site to record this against");
  }
  const siteDenied = requireSiteAccess(auth, siteId);
  if (siteDenied) return siteDenied;

  const now = new Date();

  // The validation window starts YESTERDAY, not this morning. A late list that
  // finishes at half past midnight is one session, and reading only today's
  // events would show no open clock-in and refuse the clock-out that closes it.
  const { ready, events } = await listEvents(client.id, {
    fromIso: londonDayStartIso(addDays(londonDayKey(now), -1)),
    toIso: now.toISOString(),
    staffIds: [targetId],
  });
  if (!ready) {
    return bad("Clocking is not switched on for this practice yet.", 503);
  }

  // The rule, re-checked server side on every write.
  const check = validateClock(events, kind as ClockKind, now, now);
  if (!check.ok) return bad(check.reason, 409);

  const event = await recordEvent({
    clientId: client.id,
    siteId,
    staffId: targetId,
    kind: kind as ClockKind,
    occurredAt: now.toISOString(),
    source: onBehalf ? "admin" : "manual",
    recordedBy: auth?.id ?? null,
    note: str(body.note, 300) ?? null,
  });

  return Response.json({ ok: true, event }, { status: 201 });
}
