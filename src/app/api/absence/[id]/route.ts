import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getAbsence, listAbsence, decideAbsence, cancelAbsence } from "@/lib/absence/repository";
import { canCancel, canDecide, findOverlapping } from "@/lib/absence/rules";

export const dynamic = "force-dynamic";

// PATCH a single absence: approve, refuse or cancel it.
//
// Same guard chain as the collection route (requireUser -> requireClientAccess ->
// requireApproverRole), then the PURE rules decide. Three separate refusals live in
// canDecide and all of them apply here: wrong role, already decided, and approving
// your own request. None of them is re-implemented in this file.

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
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  const action = body.action;
  if (!isAction(action)) return bad("action must be approve, refuse or cancel");
  const decisionNote = str(body.decisionNote, 500) ?? null;

  const role = auth?.role ?? null;
  const userId = auth?.id ?? null;

  let absence;
  try {
    absence = await getAbsence(id, client.id);
  } catch {
    return dbUnavailable();
  }
  if (!absence) return bad("Absence not found", 404);

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
      decisionNote,
    );
    // The repository's write is scoped to status = 'pending', so a false here means
    // somebody else decided it between our read and our write.
    if (!decided) return bad("This request has already been decided", 409);
    return Response.json({ ok: true, status: action === "approve" ? "approved" : "refused" });
  } catch {
    return dbUnavailable();
  }
}
