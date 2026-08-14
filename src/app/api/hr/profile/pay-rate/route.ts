import { getClient } from "@/lib/mock/clients";
import {
  requireClientAccess,
  requireModuleApiAccess,
  requireOwnerRole,
  requireUser,
} from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getStaff } from "@/lib/rota/repository";
import { requireCapability } from "@/lib/auth/capability-guard";
import { appendPayRate, listPayRates } from "@/lib/hr/repository";
import { isDayKey } from "@/lib/hr/entitlement";
import { poundsToPence } from "@/lib/hours/cost";

export const dynamic = "force-dynamic";

// ===========================================================================
// RECORDING A PAY RATE. APPEND ONLY, AND SEPARATELY GUARDED.
//
// THE GUARD CHAIN:
//   requireUser            somebody is signed in;
//   requireClientAccess    they belong to this practice;
//   requireModuleApiAccess they may have the Staff HR module at all;
//   requireOwnerRole       writing the employee file is owner + agency (`hr.edit`);
//   requireCapability      and pay specifically is `hr.view-pay`, which is now a
//                          real catalog key rather than the interim role helper.
//
// The last two currently admit the same two roles, and they are BOTH here on
// purpose. They answer different questions and will diverge the moment
// `hr.view-pay` is granted to one named coordinator: at that point this route
// needs `requireOwnerRole` removed and the capability left, and having them as
// separate lines makes that a deliberate one-line edit rather than an
// archaeological exercise. (It is also what keeps the API coverage sweeps
// honest: they recognise role and module tokens as the proof a route is locked,
// so the owner guard is what this route is seen to have, and the capability is
// what an owner can actually move.)
//
// APPEND ONLY. There is no PATCH and no DELETE here, and that is the schema's
// design, not an omission: a pay rise is a NEW effective-dated row. Editing the
// old row would silently re-price every hour already worked under it, and the
// rate somebody was actually paid would be gone. The month report prices each
// day at the rate in force on that day, which only works because the history
// survives.
// ===========================================================================

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

/**
 * The rate, in integer pence.
 *
 * Accepts either an explicit integer `hourlyPence` or a typed `hourlyPounds`
 * string, and parses the second by DIGITS (`poundsToPence`) rather than through
 * a float. A caller sending a fractional pence value is refused rather than
 * rounded: half a penny an hour is not a rate anybody meant.
 */
function readRate(body: Record<string, unknown>): number | null {
  if (body.hourlyPence !== undefined) {
    const n = typeof body.hourlyPence === "number" ? body.hourlyPence : Number(body.hourlyPence);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return null;
    return n;
  }
  const typed = str(body.hourlyPounds, 20);
  if (!typed) return null;
  const pence = poundsToPence(typed);
  if (pence === null || pence < 0 || pence > 1_000_000) return null;
  return pence;
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

  const client = getClient(
    str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "",
  );
  if (!client) return bad("Unknown client", 404);

  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return clientDenied;
  const moduleDenied = requireModuleApiAccess(auth, "staff-hr");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;
  const payDenied = await requireCapability(auth, "hr.view-pay");
  if (payDenied) return payDenied;

  const staffId = str(body.staffId, 60);
  if (!staffId) return bad("staffId is required");

  const staff = await getStaff(staffId, client.id);
  if (!staff) return bad("Unknown staff member", 404);

  const hourlyPence = readRate(body);
  if (hourlyPence === null) {
    return bad("Give the hourly rate as pounds and pence, for example 12.50.");
  }

  const effectiveFrom = str(body.effectiveFrom, 10);
  if (!effectiveFrom || !isDayKey(effectiveFrom)) {
    return bad("effectiveFrom must be a date, YYYY-MM-DD.");
  }
  const effectiveTo = str(body.effectiveTo, 10) ?? null;
  if (effectiveTo && !isDayKey(effectiveTo)) return bad("effectiveTo must be a date, YYYY-MM-DD.");
  if (effectiveTo && effectiveTo < effectiveFrom) {
    return bad("The last day cannot be before the first day.");
  }

  try {
    // A second rate starting on the same day is ambiguous: the per-day resolution
    // would have to pick one arbitrarily, and a pay figure decided by row order is
    // worse than an error. The unique index refuses it; this reads the existing
    // rows first so the answer is a sentence rather than a database code.
    const { ready, rates } = await listPayRates(client.id, [staffId]);
    if (!ready) {
      return Response.json(
        { ok: false, ready: false, error: "Staff HR is not set up on this database yet." },
        { status: 503 },
      );
    }
    if (rates.some((r) => r.effectiveFrom === effectiveFrom)) {
      return bad(
        "There is already a rate starting on that date. Record the new rate from a later date.",
        409,
      );
    }

    const rate = await appendPayRate({
      clientId: client.id,
      staffId,
      hourlyPence,
      effectiveFrom,
      effectiveTo,
      note: str(body.note, 300) ?? null,
      setBy: auth?.id ?? null,
    });

    return Response.json({ ok: true, rate }, { status: 201 });
  } catch {
    // A failed WRITE is never reported as success. The read path is allowed to
    // degrade to "not set up yet"; a rate that was not stored must say so.
    return bad("That rate could not be recorded.", 503);
  }
}
