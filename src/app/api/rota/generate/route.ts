import { getClient, getSites } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { generateShifts, upcomingWeekStarts } from "@/lib/rota/generate";
import { listStaff, getConfig, insertShifts } from "@/lib/rota/repository";
import type { OpeningHours } from "@/lib/types";
import type { RotaSite } from "@/lib/rota/types";

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
  const roleDenied = requireOwnerRole(auth);
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
  const weekStartDates = upcomingWeekStarts(new Date(), weeks);

  const shifts = generateShifts({ staff, sites, config, weekStartDates });
  const inserted = await insertShifts(shifts);

  return Response.json({ ok: true, weeks, generated: shifts.length, inserted, shifts });
}
