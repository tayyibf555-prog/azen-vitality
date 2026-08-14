import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { listApprovedAbsence } from "@/lib/absence/repository";
import { notificationIsStale, validateShiftEdit, type ShiftEditInput } from "@/lib/rota/edit";
import {
  getShift,
  listShifts,
  listStaff,
  tombstoneShift,
  updateShift,
  type UpdateShiftInput,
} from "@/lib/rota/repository";
import type { Absence } from "@/lib/absence/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// PATCH  /api/rota/shift/[id]   move or amend one shift.
// DELETE /api/rota/shift/[id]   TOMBSTONE one shift. Never a hard delete.
//
// ---------------------------------------------------------------------------
// WHY DELETE DOES NOT DELETE.
// ---------------------------------------------------------------------------
// A removed row is indistinguishable from a slot that was never generated, and the
// generator runs on every sweep tick. So a hard delete un-deletes itself, quietly,
// within the hour: the manager takes somebody off Tuesday, and by the afternoon
// they are back on Tuesday. `status='removed'` is the record that a PERSON decided,
// and `generateShifts` both refuses to re-create that slot and counts it as covered
// so no replacement is invented in its place either.
//
// PATCH always flips `origin` to 'manual' for the same reason: a moved shift that
// stayed 'generated' would be re-derived from the config and moved straight back.
//
// GUARD: requireUser -> requireClientAccess -> requireApproverRole (campaign 6
// widening; the practice manager is the rota's primary user, and the clinician and
// the staff role are both refused).
// ===========================================================================

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { id } = await params;

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
  // ---------------------------------------------------------------------------
  // THE CAPABILITY SWAP LANDED (orchestrator decision 7).
  // ---------------------------------------------------------------------------
  // `rota.edit` is in the catalog and enforced here. The role guard STAYS beside
  // it: the API module-guard sweep reads role/module tokens as the proof a route
  // is locked, so a capability alone would read to that sweep as no lock at all.
  // Net effect — an owner can revoke this from one named person and it bites;
  // granting it outside APPROVER_ROLES does not, yet.
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "rota.edit");
  if (capDenied) return capDenied;

  // Read it FIRST, scoped to the client: an id belonging to another practice must
  // read as absent, not as a shift somebody nearly edited.
  const current = await getShift(id, client.id);
  if (!current) return bad("Shift not found", 404);

  // The edit, as the person means it: their changes on top of what is there now, so
  // the rules judge the RESULT rather than the delta.
  const merged: ShiftEditInput = {
    id,
    siteId: str(body.siteId, 60) ?? current.siteId,
    staffId: str(body.staffId, 60) ?? current.staffId,
    shiftDate: str(body.shiftDate, 10) ?? current.shiftDate,
    startTime: str(body.startTime, 5) ?? current.startTime,
    endTime: str(body.endTime, 5) ?? current.endTime,
    role: str(body.role, 60) ?? current.role,
    pairedStaffId:
      body.pairedStaffId === undefined
        ? (current.pairedStaffId ?? null)
        : (str(body.pairedStaffId, 60) ?? null),
    note: body.note === undefined ? (current.note ?? null) : (str(body.note, 500) ?? null),
  };

  const staff = await listStaff(client.id);
  const staffIds = new Set(staff.map((s) => s.id));
  if (!staffIds.has(merged.staffId)) return bad("That staff member is not on this practice's rota", 404);
  if (merged.pairedStaffId && !staffIds.has(merged.pairedStaffId)) {
    return bad("The person you paired them with is not on this practice's rota", 404);
  }
  const scope = await getViewScope(client.id);
  if (!scope.siteIds.includes(merged.siteId)) return bad("That site is not one you are viewing", 400);

  const dayShifts = await listShifts(client.id, merged.shiftDate, merged.shiftDate);
  let absences: Absence[] = [];
  try {
    absences = await listApprovedAbsence(client.id, merged.shiftDate, merged.shiftDate);
  } catch {
    absences = [];
  }
  const validation = validateShiftEdit(merged, dayShifts, absences, new Date());
  if (!validation.ok) {
    return Response.json(
      { ok: false, error: validation.issues.find((i) => i.level === "error")!.message, issues: validation.issues },
      { status: 400 },
    );
  }

  const fields: UpdateShiftInput = {
    siteId: merged.siteId,
    staffId: merged.staffId,
    shiftDate: merged.shiftDate,
    startTime: merged.startTime,
    endTime: merged.endTime,
    role: merged.role,
    pairedStaffId: merged.pairedStaffId ?? null,
    note: merged.note ?? null,
  };
  // A MOVE INVALIDATES THE LAST TEXT, so it goes back in front of the sweep. The
  // rule is in `./edit` under test, not decided here: a note change must not text
  // the whole team, and a time change must.
  const stale = notificationIsStale(current, merged);
  const updated = await updateShift(id, client.id, fields, stale);
  if (!updated) return bad("Shift not found", 404);

  const shift = await getShift(id, client.id);
  return Response.json({
    ok: true,
    shift,
    // Said out loud so the screen can: the staff member will be re-told, because
    // what they were told is now wrong.
    reNotify: stale,
    warnings: validation.issues.filter((i) => i.level === "warning"),
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { id } = await params;

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // No/invalid body is fine for DELETE; fall back to the query param.
  }

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  // ---------------------------------------------------------------------------
  // THE CAPABILITY SWAP LANDED (orchestrator decision 7).
  // ---------------------------------------------------------------------------
  // `rota.edit` is in the catalog and enforced here. The role guard STAYS beside
  // it: the API module-guard sweep reads role/module tokens as the proof a route
  // is locked, so a capability alone would read to that sweep as no lock at all.
  // Net effect — an owner can revoke this from one named person and it bites;
  // granting it outside APPROVER_ROLES does not, yet.
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "rota.edit");
  if (capDenied) return capDenied;

  const current = await getShift(id, client.id);
  if (!current) return bad("Shift not found", 404);

  const removed = await tombstoneShift(id, client.id);
  if (!removed) return bad("Shift not found", 404);

  // Said out loud, because "deleted" and "tombstoned" behave differently and the
  // person pressing the button should know which one they got: the slot stays empty
  // rather than being auto-filled by the next generation.
  return Response.json({
    ok: true,
    tombstoned: true,
    wasPublished: Boolean(current.publishedVersion),
  });
}
