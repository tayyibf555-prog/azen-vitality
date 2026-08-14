import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { listStaff, getStaff } from "@/lib/rota/repository";
import { findStaffByAppUser } from "@/lib/clock/repository";
import { listAbsence, createAbsence } from "@/lib/absence/repository";
import {
  addDayKey,
  canRequest,
  decorateAbsences,
  findOverlapping,
  isAbsenceKind,
  isDayKey,
  summariseAbsences,
  validateRequest,
} from "@/lib/absence/rules";
import { londonDayKey } from "@/lib/time/london";
import type { AbsenceStatus } from "@/lib/absence/types";
import { ABSENCE_STATUSES } from "@/lib/absence/types";
import type { RotaStaff } from "@/lib/rota/types";

export const dynamic = "force-dynamic";

// Holiday and absence: list (GET) and request (POST).
//
// ===========================================================================
// TWO CALLERS, TWO PATHS, ONE ENDPOINT — the shape api/staff-check-in already
// uses, and for the same reason.
//
//   MANAGER. An approver (owner, agency admin, practice manager) sees the whole
//   team's absence and may record it for anybody. Unchanged in every respect.
//
//   SELF SERVICE. Everybody else — the clinician, and now the `client_staff`
//   receptionist or nurse — sees exactly their OWN rows and may request exactly
//   their OWN time off. The staff record is resolved from the caller's verified
//   session via `findStaffByAppUser` (rota_staff.app_user_id), NEVER from the
//   request body: an endpoint that trusted a body-supplied staffId would let
//   anybody book anybody's holiday.
//
// WHAT THIS FIXED. Both methods used to call `requireApproverRole`
// unconditionally, so `client_clinician` — a role that CAN see the Holiday page,
// because "absence" is in CLINICIAN_SLUGS — got a 403 from every call the page
// made. The page rendered and did nothing. The self-request rule in
// `canRequest` existed the whole time and was unreachable; the old comment in
// this file admitted as much. The role guard is now on the branch that needs it
// (recording somebody ELSE's absence) rather than across the door.
//
// THE NARROWING IS AT THE QUERY, not in the response and certainly not in the
// UI: `listAbsence` is given the caller's own staff id, so a non-approver's
// direct call returns no more than their page shows. Same discipline as
// api/staff-check-in/route.ts, which narrows its staff list on `canManage`.
//
// Every decision the UI renders (may I approve this, does it clash, has it
// finished) is computed by @/lib/absence/rules here and shipped to the client as
// data. The components hold no conditions of their own.
// ===========================================================================

/** How far back and forward the list reaches when the caller gives no window. */
const DEFAULT_PAST_DAYS = 30;
const DEFAULT_FUTURE_DAYS = 180;

/**
 * What a self-service caller is told when their login has no staff record.
 *
 * Word for word the clocking route's sentence (api/staff-check-in/route.ts), so
 * a person who meets this twice meets the same wording twice.
 */
const NO_STAFF_LINK =
  "Your login is not linked to a staff record, so you cannot request time off. Ask the practice manager to link you on the rota.";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** A database that has not had migration 0067 applied yet fails here, not at render. */
function dbUnavailable(): Response {
  return Response.json(
    { ok: false, error: "Holiday and absence is not set up on this database yet." },
    { status: 503 },
  );
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const url = new URL(request.url);
  const clientSlug = url.searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  // Approvers see the whole team. Everybody else sees their own rows and only
  // their own — decided here, applied to the QUERY below. `requireApproverRole`
  // is a no-op on a null user, so the un-enforced pilot demo keeps the manager
  // view exactly as it was.
  const canManage = requireApproverRole(auth) === null;

  const now = new Date();
  const today = londonDayKey(now);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const from = fromParam && isDayKey(fromParam) ? fromParam : addDayKey(today, -DEFAULT_PAST_DAYS);
  const to = toParam && isDayKey(toParam) ? toParam : addDayKey(today, DEFAULT_FUTURE_DAYS);

  const statusParam = url.searchParams.get("status");
  const statuses: AbsenceStatus[] | undefined =
    statusParam && (ABSENCE_STATUSES as readonly string[]).includes(statusParam)
      ? [statusParam as AbsenceStatus]
      : undefined;

  try {
    // The session's own staff record, or null. Read for BOTH callers: a manager
    // who is also on the rota gets `me` too, which is what lets one page show
    // her own holiday beside the team's.
    const me = auth ? await findStaffByAppUser(client.id, auth.id) : null;

    if (!canManage) {
      // ---- SELF SERVICE ----------------------------------------------------
      // No staff link means there is nothing of theirs to show. Answered as an
      // honest, explicit `linked: false` rather than an empty list, so the page
      // says "your login is not linked" instead of "you have no holiday".
      if (!me) {
        return Response.json({
          ok: true,
          canManage: false,
          linked: false,
          me: null,
          window: { from, to },
          absences: [],
          summary: summariseAbsences([]),
          staff: [],
        });
      }

      // NARROWED AT THE QUERY on the SESSION'S staff id. The `staffId` search
      // param is ignored outright for this caller: honouring it would turn a
      // filter into an access-control bypass.
      //
      // Deliberately NOT site-scoped. Their own holiday is theirs wherever the
      // top-bar switcher happens to be pointing, and hiding a person's own
      // approved leave because a manager changed site is a bug, not a policy.
      const absences = await listAbsence(client.id, { from, to, statuses, staffId: me.id });
      const rows = decorateAbsences(absences, { role: auth?.role ?? null, userId: auth?.id ?? null }, now);
      // Their own staff row and nobody else's: the request form needs a name and
      // an id, and the rest of the team is none of their business.
      const own = await getStaff(me.id, client.id);
      return Response.json({
        ok: true,
        canManage: false,
        linked: true,
        me,
        window: { from, to },
        absences: rows,
        summary: summariseAbsences(rows),
        staff: own ? [own] : ([] as RotaStaff[]),
      });
    }

    // ---- MANAGER (unchanged) ----------------------------------------------
    const staffId = str(url.searchParams.get("staffId"), 60);
    // Scope to the selected site plus floating staff, exactly as the rota staff list
    // does, so one practice's view never shows another site's team.
    const scope = await getViewScope(client.id);
    const siteScope = scope.isAllSites ? undefined : scope.siteIds;

    const [absences, staff] = await Promise.all([
      listAbsence(client.id, { from, to, statuses, staffId, siteIds: siteScope }),
      listStaff(client.id, siteScope ? { siteIds: siteScope } : undefined),
    ]);
    const rows = decorateAbsences(absences, { role: auth?.role ?? null, userId: auth?.id ?? null }, now);
    return Response.json({
      ok: true,
      canManage: true,
      linked: me !== null,
      me,
      window: { from, to },
      absences: rows,
      summary: summariseAbsences(rows),
      staff,
    });
  } catch {
    return dbUnavailable();
  }
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
  // THE PER-PERSON GATE on asking for time off. Everybody who works here holds
  // this by default, so on its own it changes nothing — its value is as a REVOKE
  // (one person's requests go through their manager in person instead). It is
  // checked BEFORE the role fork so it covers the manager and the self-service
  // caller alike.
  const capabilityDenied = await requireCapability(auth, "people.absence.request");
  if (capabilityDenied) return capabilityDenied;

  const canManage = requireApproverRole(auth) === null;

  let me;
  try {
    me = auth ? await findStaffByAppUser(client.id, auth.id) : null;
  } catch {
    return dbUnavailable();
  }

  // WHOSE ABSENCE THIS IS. A manager may name anybody. A non-approver may not
  // name anybody at all: their staff id comes from the session and the body's
  // `staffId` is not read on that branch, so there is nothing to spoof.
  const staffId = canManage ? (str(body.staffId, 60) ?? me?.id ?? "") : (me?.id ?? "");
  if (!canManage && !staffId) return bad(NO_STAFF_LINK, 409);

  const kind = body.kind;
  if (!isAbsenceKind(kind)) return bad("Choose a type of absence.");

  const input = {
    staffId,
    kind,
    startDate: str(body.startDate, 10) ?? "",
    endDate: str(body.endDate, 10) ?? "",
    note: str(body.note, 500) ?? null,
  };

  const valid = validateRequest(input, new Date());
  if (!valid.ok) return bad(valid.reason);

  // The staff member must belong to THIS client. getStaff is client-scoped, so a
  // foreign id reads as missing rather than leaking that it exists elsewhere.
  let staff;
  try {
    staff = await getStaff(staffId, client.id);
  } catch {
    return dbUnavailable();
  }
  if (!staff) return bad("Staff member not found", 404);

  // Belt and braces on top of the fork above: an approver may record absence for
  // anyone; a clinician or a member of staff only for themselves. `selfStaffId`
  // is the SESSION'S staff id, so the rule is checked against a value the caller
  // cannot influence.
  if (auth && !canRequest(auth.role, staffId, me?.id ?? null)) {
    return bad("You cannot request absence for this person", 403);
  }

  try {
    // Read the person's existing absence over the requested dates BEFORE inserting, so
    // the new row cannot appear in its own clash list.
    const existing = await listAbsence(client.id, {
      staffId,
      from: input.startDate,
      to: input.endDate,
      statuses: ["pending", "approved"],
    });

    const absence = await createAbsence({
      clientId: client.id,
      siteId: staff.siteId,
      staffId,
      kind: input.kind,
      startDate: input.startDate,
      endDate: input.endDate,
      note: input.note,
      requestedBy: auth?.id ?? null,
    });

    // A clash does NOT refuse the request: the manager is the one who decides, and
    // they need to see the conflict rather than be told "no" by the form. The clash
    // is reported so it can be surfaced beside the pending row.
    const overlaps = findOverlapping(existing, absence);
    return Response.json({ ok: true, absence, overlapIds: overlaps.map((o) => o.id) }, { status: 201 });
  } catch {
    return dbUnavailable();
  }
}
