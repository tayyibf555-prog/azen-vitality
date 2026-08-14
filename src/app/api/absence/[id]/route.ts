import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
import type { AuthedUser } from "@/lib/auth/session";
import { findStaffByAppUser } from "@/lib/clock/repository";
import { getAbsence, listAbsence, decideAbsence, cancelAbsence } from "@/lib/absence/repository";
import { canCancel, canDecide, findOverlapping } from "@/lib/absence/rules";

export const dynamic = "force-dynamic";

// PATCH a single absence: approve, refuse or cancel it.
//
// ===========================================================================
// THE FORK IS ON THE ACT, NOT ON THE DOOR.
//
//   approve / refuse — a manager's decision. `requireApproverRole` plus the
//                      `people.absence.approve` capability, exactly as before.
//
//   cancel          — WITHDRAWING YOUR OWN REQUEST IS PART OF MAKING ONE. A
//                     member of staff who asked for next Tuesday off, then did
//                     not need it, must be able to take it back without ringing
//                     the manager. So the approver guard does not stand across
//                     this branch; the pure `canCancel` decides, and it already
//                     refuses a non-approver who is not the requester. A
//                     non-approver cancelling somebody ELSE's absence therefore
//                     cannot happen, and does not depend on this file getting a
//                     conditional right.
//
// Two things keep the widening honest:
//  - a non-approver's row lookup is narrowed to their OWN staff record (resolved
//    from the session, never the body), so a foreign id reads as "not found"
//    rather than "forbidden" — no existence oracle over absence ids;
//  - the capability differs by act: cancelling your own is `people.absence.request`
//    (the same key that let you raise it), cancelling somebody else's is
//    `people.absence.approve`.
//
// Three refusals still live in canDecide and all of them apply here: wrong role,
// already decided, and approving your own request. None is re-implemented in
// this file.
// ===========================================================================

type Action = "approve" | "refuse" | "cancel";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

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

function isAction(v: unknown): v is Action {
  return v === "approve" || v === "refuse" || v === "cancel";
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

  const action = body.action;
  if (!isAction(action)) return bad("action must be approve, refuse or cancel");

  const canManage = requireApproverRole(auth) === null;

  // THE PER-PERSON GATE. Deciding somebody else's holiday is a manager's act and
  // keeps the approver key; withdrawing your own request is part of requesting
  // one and carries the request key, so an owner can revoke either independently.
  if (action === "cancel" && !canManage) {
    const capabilityDenied = await requireCapability(auth, "people.absence.request");
    if (capabilityDenied) return capabilityDenied;
  } else {
    // approve, refuse, or an approver cancelling: the manager's door.
    const roleDenied = requireApproverRole(auth);
    if (roleDenied) return roleDenied;
    const capabilityDenied = await requireCapability(auth, "people.absence.approve");
    if (capabilityDenied) return capabilityDenied;
  }

  const role = auth?.role ?? null;
  const userId = auth?.id ?? null;

  let absence;
  try {
    absence = await getAbsence(id, client.id);
  } catch {
    return dbUnavailable();
  }
  if (!absence) return bad("Absence not found", 404);

  // A non-approver may only ever touch a row belonging to their OWN staff
  // record. Answered as 404, deliberately: a 403 would confirm that the id
  // exists, which is an existence oracle over the practice's absence table.
  if (!canManage) {
    let me;
    try {
      me = auth ? await findStaffByAppUser(client.id, auth.id) : null;
    } catch {
      return dbUnavailable();
    }
    if (!me || absence.staffId !== me.id) return bad("Absence not found", 404);
  }

  if (action === "cancel") {
    if (!canCancel(role, absence, userId)) {
      return bad("This absence can no longer be cancelled", 403);
    }
    try {
      const cancelled = await cancelAbsence(id, client.id);
      if (!cancelled) return bad("This absence can no longer be cancelled", 409);
      return Response.json({ ok: true, status: "cancelled" });
    } catch {
      return dbUnavailable();
    }
  }

  if (!canDecide(role, absence, userId)) {
    // Two very different situations, and the person deserves to know which.
    if (absence.status !== "pending") return bad("This request has already been decided", 409);
    return bad("You cannot approve or refuse your own request", 403);
  }

  if (action === "approve") {
    try {
      // Approving is the point at which a clash becomes real double-booking, so this
      // is where it blocks. A PENDING clash is only a warning (two requests, one of
      // which is about to be refused); an APPROVED clash means the person is already
      // signed off for those days.
      const existing = await listAbsence(client.id, {
        staffId: absence.staffId,
        from: absence.startDate,
        to: absence.endDate,
        statuses: ["approved"],
      });
      const clashes = findOverlapping(existing, absence);
      if (clashes.length > 0) {
        return bad("This person already has approved time off over those dates", 409);
      }
    } catch {
      return dbUnavailable();
    }
  }

  try {
    const decided = await decideAbsence(
      id,
      client.id,
      action === "approve" ? "approved" : "refused",
      userId,
      decisionNote(body),
    );
    // The repository's write is scoped to status = 'pending', so a false here means
    // somebody else decided it between our read and our write.
    if (!decided) return bad("This request has already been decided", 409);
    return Response.json({ ok: true, status: action === "approve" ? "approved" : "refused" });
  } catch {
    return dbUnavailable();
  }
}

/** The manager's note against a decision, trimmed and capped. */
function decisionNote(body: Record<string, unknown>): string | null {
  return str(body.decisionNote, 500) ?? null;
}
