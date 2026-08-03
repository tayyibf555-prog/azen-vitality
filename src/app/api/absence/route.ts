import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { listStaff, getStaff } from "@/lib/rota/repository";
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

export const dynamic = "force-dynamic";

// Holiday and absence: list (GET) and request (POST).
//
// The guard chain is the house pattern from api/rota/staff/route.ts:35-55, with ONE
// substitution: requireApproverRole instead of requireOwnerRole. Approving holiday is
// the practice manager's job and she is a client_coordinator, whom requireOwnerRole
// rejects. requireOwnerRole itself is untouched; the approver guard is additive.
//
// Every decision the UI renders (may I approve this, does it clash, has it finished)
// is computed by @/lib/absence/rules here and shipped to the client as data. The
// components hold no conditions of their own.

/** How far back and forward the list reaches when the caller gives no window. */
const DEFAULT_PAST_DAYS = 30;
const DEFAULT_FUTURE_DAYS = 180;

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
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

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
  const staffId = str(url.searchParams.get("staffId"), 60);

  // Scope to the selected site plus floating staff, exactly as the rota staff list
  // does, so one practice's view never shows another site's team.
  const scope = await getViewScope(client.id);
  const siteScope = scope.isAllSites ? undefined : scope.siteIds;

  try {
    const [absences, staff] = await Promise.all([
      listAbsence(client.id, { from, to, statuses, staffId, siteIds: siteScope }),
      listStaff(client.id, siteScope ? { siteIds: siteScope } : undefined),
    ]);
    const rows = decorateAbsences(absences, { role: auth?.role ?? null, userId: auth?.id ?? null }, now);
    return Response.json({
      ok: true,
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
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  const staffId = str(body.staffId, 60) ?? "";
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

  // Belt and braces on top of requireApproverRole: an approver may record absence for
  // anyone, a clinician only for themselves. `selfStaffId` is null because there is no
  // login-to-staff link yet, which is exactly why a clinician cannot reach this route.
  if (auth && !canRequest(auth.role, staffId, null)) {
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
