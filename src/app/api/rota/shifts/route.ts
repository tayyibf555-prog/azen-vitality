import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import { resolveSelfStaff, selfServiceRequested } from "@/lib/self-service/read";
import type { AuthedUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { isDayKey, inclusiveDays } from "@/lib/absence/rules";
import { listApprovedAbsence } from "@/lib/absence/repository";
import { validateShiftEdit, type ShiftEditInput } from "@/lib/rota/edit";
import { createManualShift, getConfig, listShifts, listStaff } from "@/lib/rota/repository";
import type { Absence } from "@/lib/absence/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// GET  /api/rota/shifts?client=&from=&to=   READ the stored rota.
// POST /api/rota/shifts                     CREATE one shift by hand.
//
// ---------------------------------------------------------------------------
// THE READ ROUTE IS THE POINT, AND IT DID NOT EXIST.
// ---------------------------------------------------------------------------
// Until now the rota page read the week by POSTing the GENERATOR
// (`rota-this-week.tsx` -> POST /api/rota/generate) and rendering the generator's
// in-memory output. Three things followed from that, and all three were bugs:
//
//   * the shifts on screen had NO id (the grid fell back to a composite key), so
//     nothing could be clicked, moved or deleted -- manual editing was impossible
//     to bolt on;
//   * their status was always 'scheduled', because the generator invents it, so the
//     "Notified" figure on the page was permanently 0 and the green notified state
//     never rendered once;
//   * opening the page WROTE to the database. Every visit re-ran generation.
//
// This route returns the stored rows, with their real ids and their real statuses,
// tombstones included so the grid can show a deleted shift as deleted rather than
// as a gap it might helpfully fill.
//
// GUARD: requireUser -> requireClientAccess -> requireApproverRole. The practice
// manager is a client_coordinator and is the rota's primary user; the clinician and
// the staff role are refused. See the campaign 6 widening note on the sibling routes.
//
// ---------------------------------------------------------------------------
// ...EXCEPT ON `mine=1`, WHERE THE CALLER IS ASKING ABOUT THEMSELVES.
// ---------------------------------------------------------------------------
// My work's "My rota" tab is the whole reason the `client_staff` role exists, and
// every guard on the line above refuses that role. So `?mine=1` takes a different
// branch: no approver guard, no `rota.view` capability (a nurse holds neither),
// and in their place the two locks that actually fit the question being asked —
//
//   * the staff row comes from `resolveSelfStaff`, which takes the session and no
//     staff id at all, so a `staffId` in the query is not read and cannot be;
//   * the read is narrowed AT THE QUERY to that one staff id, and to PUBLISHED
//     shifts only, so a draft week never reaches the person who would have to
//     work it.
//
// It is not site-scoped, deliberately, exactly as /api/absence's self branch is
// not: your own shifts are yours wherever the top bar happens to be pointing.
// Recorded platform-wide as a `kind:"self-service"` entry in
// src/app/api/client-api-module-guard-coverage.test.ts, with a structural check.
// ===========================================================================

/** The widest window one request may read. A month view needs ~31 days; 62 is slack. */
const MAX_WINDOW_DAYS = 62;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
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
  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!isDayKey(from) || !isDayKey(to)) return bad("from and to must be YYYY-MM-DD dates");
  if (to < from) return bad("to cannot be before from");
  if (inclusiveDays(from, to) > MAX_WINDOW_DAYS) {
    return bad(`Ask for at most ${MAX_WINDOW_DAYS} days at a time`);
  }

  // ---- SELF SERVICE (`mine=1`) --------------------------------------------
  // Taken BEFORE the manager guards, because those guards refuse this branch's
  // entire audience. Everything it returns is the caller's own and published.
  if (selfServiceRequested(url)) {
    const self = await resolveSelfStaff(client.id, auth, "there are no shifts to show");
    if (!self.ok) return self.response;
    const shifts = await listShifts(client.id, from, to, {
      // NARROWED AT THE QUERY on the SESSION's staff id. The `staffId` search
      // param is never read on this branch: a filter that doubled as an access
      // control is the exact bug /api/absence had to be fixed for.
      staffIds: [self.staff.id],
      publishedOnly: true,
    });
    return Response.json({ ok: true, mine: true, from, to, staffId: self.staff.id, shifts });
  }

  // ---------------------------------------------------------------------------
  // THE CAPABILITY SWAP LANDED (orchestrator decision 7).
  // ---------------------------------------------------------------------------
  // `rota.view` is now in the catalog and enforced here. The ROLE GUARD STAYS as
  // well, and that is not belt-and-braces theatre: the API module-guard sweep
  // recognises role/module tokens as the proof a route is locked, and a route
  // whose only lock is a capability reads to that sweep as no lock at all.
  //
  // What the pair means in practice: an owner can REVOKE rota.view from one named
  // person and it takes effect; granting it to somebody outside APPROVER_ROLES
  // does not, until the role guard comes off. The capability is necessary and not
  // sufficient, exactly as `people.absence.request` is.
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "rota.view");
  if (capDenied) return capDenied;

  // Scope to the selected site (N15 by default) plus floating staff, exactly as the
  // staff route does, so a single-site view never shows another practice's team.
  const scope = await getViewScope(client.id);
  const [shifts, staff, config] = await Promise.all([
    listShifts(client.id, from, to, scope.isAllSites ? undefined : { siteIds: scope.siteIds }),
    listStaff(client.id, scope.isAllSites ? undefined : { siteIds: scope.siteIds }),
    getConfig(client.id),
  ]);

  // Approved absence over the same window, so the grid can show a clash without a
  // second round trip. Read defensively: absence is an improvement to the rota view,
  // never a precondition for seeing the rota at all.
  let absences: Absence[] = [];
  try {
    absences = await listApprovedAbsence(client.id, from, to);
  } catch {
    absences = [];
  }

  return Response.json({ ok: true, from, to, shifts, staff, config, absences });
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
  // THE CAPABILITY SWAP LANDED — see the GET above for why the role guard stays.
  // `rota.edit` is DESTRUCTIVE in the catalog, so on an environment with no
  // sign-in configured this refuses with a 503 rather than writing a shift nobody
  // can be held to (the move-service posture).
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "rota.edit");
  if (capDenied) return capDenied;

  const input: ShiftEditInput = {
    siteId: str(body.siteId, 60) ?? "",
    staffId: str(body.staffId, 60) ?? "",
    shiftDate: str(body.shiftDate, 10) ?? "",
    startTime: str(body.startTime, 5) ?? "",
    endTime: str(body.endTime, 5) ?? "",
    role: str(body.role, 60) ?? "",
    pairedStaffId: body.pairedStaffId === undefined ? null : (str(body.pairedStaffId, 60) ?? null),
    note: body.note === undefined ? null : (str(body.note, 500) ?? null),
  };

  // TENANCY, before anything else is believed: the staff member (and the partner)
  // must belong to this practice. The composite FK enforces it at the schema too,
  // but a 400 that says which field is wrong beats a database error.
  const staff = await listStaff(client.id);
  const staffIds = new Set(staff.map((s) => s.id));
  if (!staffIds.has(input.staffId)) return bad("That staff member is not on this practice's rota", 404);
  if (input.pairedStaffId && !staffIds.has(input.pairedStaffId)) {
    return bad("The person you paired them with is not on this practice's rota", 404);
  }
  const scope = await getViewScope(client.id);
  if (!scope.siteIds.includes(input.siteId)) return bad("That site is not one you are viewing", 400);

  // The RULES live in `@/lib/rota/edit`, under test, not in this route and not in a
  // React closure. The route's job is to ask.
  const dayShifts = await listShifts(client.id, input.shiftDate, input.shiftDate);
  let absences: Absence[] = [];
  try {
    absences = await listApprovedAbsence(client.id, input.shiftDate, input.shiftDate);
  } catch {
    absences = [];
  }
  const validation = validateShiftEdit(input, dayShifts, absences, new Date());
  if (!validation.ok) {
    return Response.json(
      { ok: false, error: validation.issues.find((i) => i.level === "error")!.message, issues: validation.issues },
      { status: 400 },
    );
  }

  const shift = await createManualShift({
    clientId: client.id,
    siteId: input.siteId,
    staffId: input.staffId,
    shiftDate: input.shiftDate,
    startTime: input.startTime,
    endTime: input.endTime,
    role: input.role,
    pairedStaffId: input.pairedStaffId ?? null,
    note: input.note ?? null,
  });

  // Warnings travel WITH the success, never instead of it: the shift was added, and
  // the manager still needs telling that the person had agreed time off that day.
  return Response.json(
    { ok: true, shift, warnings: validation.issues.filter((i) => i.level === "warning") },
    { status: 201 },
  );
}
