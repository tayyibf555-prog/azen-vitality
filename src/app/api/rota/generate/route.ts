import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireApproverRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { generateShifts, upcomingWeekStarts } from "@/lib/rota/generate";
import { londonDayKey } from "@/lib/time/london";
import { listStaff, getConfig, insertShifts, listShifts } from "@/lib/rota/repository";
import { listApprovedAbsence } from "@/lib/absence/repository";
import { addDayKey } from "@/lib/absence/rules";
import type { Absence } from "@/lib/absence/types";
import type { OpeningHours } from "@/lib/types";
import type { RotaShift, RotaSite } from "@/lib/rota/types";

export const dynamic = "force-dynamic";

// POST /api/rota/generate { clientSlug, weeks? }
// Owner/manager-gated. Generate shifts for the next N weeks (default from config's
// generateWeeksAhead) from config + active staff + the sites' opening hours, insert
// idempotently, and return the inserted count plus the full shift set.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/** A client's sites as the generator needs them (id, name, opening hours). */
function rotaSites(clientId: string): RotaSite[] {
  return getSites(clientId)
    .filter((s) => s.openingHours)
    .map((s) => ({ id: s.id, name: s.name, openingHours: s.openingHours as OpeningHours }));
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
  //
  // WIDENED FROM requireOwnerRole TO requireApproverRole (campaign 6), and it is a
  // decision on the record rather than a tidy-up. The practice manager is a
  // `client_coordinator` in this platform and she is the rota's PRIMARY user, so the
  // owner-only guard meant she could not make a single rota API call — the module
  // locked out the person it was built for. Its two siblings (absence,
  // staff-check-in) were widened to the approver list for exactly this reason and
  // the rota was missed. `requireApproverRole` reads APPROVER_ROLES from
  // `@/lib/absence/rules`, so the HTTP edge and the pure decision rules cannot
  // drift, and the clinician and the staff role are still refused by it.
  // nav.staff.test.ts names this widening and pins all four routes.
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  const config = await getConfig(client.id);
  // weeks: explicit override (1..12), else the config's generateWeeksAhead.
  let weeks = config.generateWeeksAhead;
  if (body.weeks !== undefined) {
    const n = typeof body.weeks === "number" ? body.weeks : Number(body.weeks);
    if (!Number.isFinite(n) || n < 1) return bad("weeks must be a positive number");
    weeks = Math.min(Math.trunc(n), 12);
  }

  const staff = await listStaff(client.id, { activeOnly: true });
  const sites = rotaSites(client.id);
  const now = new Date();
  const weekStartDates = upcomingWeekStarts(now, weeks);

  // Approved absence over exactly the window we are generating, so nobody is
  // rostered on a day they are away.
  //
  // Read defensively. Migration 0067 (staff_absence) is written but not yet applied,
  // so on an un-migrated database this read fails. That must NOT take the rota down:
  // absence removing people is an improvement to generation, not a precondition for
  // it. On failure we generate exactly as we did before absence existed.
  let absences: Absence[] = [];
  if (weekStartDates.length > 0) {
    const from = weekStartDates[0];
    const to = addDayKey(weekStartDates[weekStartDates.length - 1], 6);
    try {
      absences = await listApprovedAbsence(client.id, from, to);
    } catch {
      absences = [];
    }
  }

  // THE SHIFTS ALREADY STORED over exactly this window.
  //
  // Without this the generator is blind to what a person decided: a manually deleted
  // shift is just an absent row, so it is re-created, and a manually moved shift gets
  // a generated twin dropped on top of it. Both used to happen on EVERY page load,
  // silently. `existing` is pure input, like `absences`, so the generator still reads
  // no database of its own -- this route reads it and hands it over.
  //
  // Read defensively for the same reason absence is: if this read fails we generate
  // as we always did rather than taking the rota down. That is a WEAKER guarantee,
  // not a broken one, and it is the right trade for a read that only ever fails when
  // the database is already unhappy.
  let existing: RotaShift[] = [];
  if (weekStartDates.length > 0) {
    try {
      existing = await listShifts(
        client.id,
        weekStartDates[0],
        addDayKey(weekStartDates[weekStartDates.length - 1], 6),
      );
    } catch {
      existing = [];
    }
  }

  const shifts = generateShifts({
    staff,
    sites,
    config,
    weekStartDates,
    today: londonDayKey(now),
    absences,
    existing,
  });
  const inserted = await insertShifts(shifts);

  // `shifts` is now what was MISSING, not the whole week, so it is no longer usable
  // as a read of the rota. It is returned for the count only; the page reads the week
  // from GET /api/rota/shifts, which returns rows with real ids and real statuses.
  return Response.json({ ok: true, weeks, generated: shifts.length, inserted });
}
