import { getClient } from "@/lib/mock/clients";
import {
  requireApproverRole,
  requireClientAccess,
  requireModuleApiAccess,
  requireOwnerRole,
  requireUser,
} from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { listStaff, getStaff } from "@/lib/rota/repository";
import { hasCapability } from "@/lib/auth/capability-guard";
import { listHrProfiles, listPayRates, upsertHrProfile } from "@/lib/hr/repository";
import { isDayKey, resolveEntitlement } from "@/lib/hr/entitlement";
import { rateOnDay } from "@/lib/hours/cost";
import type { HrPerson, HrProfileResponse } from "@/lib/hr/types";
import type { PayRate } from "@/lib/hours/types";
import { londonDayKey } from "@/lib/time/london";

export const dynamic = "force-dynamic";

// ===========================================================================
// THE EMPLOYEE FILE: read (GET) and write (PATCH).
//
// THE GUARD CHAIN, AND WHY IT IS FOUR LINKS RATHER THAN ONE:
//   requireUser            somebody is signed in;
//   requireClientAccess    they belong to this practice;
//   requireModuleApiAccess they may have the Staff HR module at all (this is the
//                          link that refuses the clinician and the staff role,
//                          neither of whom has "staff-hr");
//   requireApproverRole    read is owner, agency and the practice manager;
//   requireOwnerRole       WRITE is owner and agency only (`hr.edit`).
//
// AND THEN, INSIDE, THE ONE THAT IS NARROWER THAN THE MODULE: pay. The practice
// manager legitimately opens this screen every week and must not see what
// individuals are paid, so the rate table is NEVER READ for her. Not read and
// filtered: not read. The question is now asked of the capability catalog —
// `hasCapability(auth, "hr.view-pay")` — so an owner who grants one named
// coordinator the key changes what this route builds, without her becoming an
// owner. The interim role helper it replaced was `requirePayAccess`.
//
// PERSONAL DATA. Dates of birth, home addresses, emergency contacts and an NI
// fragment are employee personal data under UK GDPR. The full NI number cannot
// be stored (0075 caps the column at four characters) and nothing here is ever
// returned to a role outside the chain above.
// ===========================================================================

/** Nothing longer than this is a name, an email or a note anybody typed. */
const MAX_FIELD = 200;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** 0075 unapplied: say so, rather than render an empty employee file. */
function notSetUp(): Response {
  return Response.json(
    { ok: false, ready: false, error: "Staff HR is not set up on this database yet." },
    { status: 503 },
  );
}

function str(v: unknown, max = MAX_FIELD): string | null | undefined {
  if (v === null) return null; // an explicit clear
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? null : s.slice(0, max);
}

/** A `YYYY-MM-DD` day, an explicit null, or undefined for "not in this edit". */
function dayField(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return null;
  return isDayKey(s) ? s : undefined;
}

function numberField(v: unknown, min: number, max: number): number | null | undefined {
  if (v === null) return null;
  if (v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  if (n < min || n > max) return undefined;
  return Math.round(n * 10) / 10;
}

function objectField(v: unknown, keys: string[]): Record<string, string | null> | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = str(raw[key]) ?? null;
  return out;
}

export async function GET(request: Request): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const url = new URL(request.url);
  const client = getClient(url.searchParams.get("client") ?? "");
  if (!client) return bad("Unknown client", 404);

  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return clientDenied;
  const moduleDenied = requireModuleApiAccess(auth, "staff-hr");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;

  // OMISSION, NOT REFUSAL, and now keyed on `hr.view-pay` from the capability
  // catalog rather than on a role list: a coordinator the owner has granted the key
  // sees the rates, and one who has not never has them built into the payload at
  // all. `hasCapability` rather than `requireCapability` because the rest of the
  // employee file is legitimately hers.
  const includesPay = await hasCapability(auth, "hr.view-pay");
  // A HINT for the screen, never the lock: PATCH re-checks the role itself.
  const canEdit = requireOwnerRole(auth) === null;
  const now = new Date();
  const asOfDay = londonDayKey(now);

  const scope = await getViewScope(client.id);
  const siteScope = scope.isAllSites ? undefined : scope.siteIds;

  try {
    const staff = await listStaff(client.id, siteScope ? { siteIds: siteScope } : undefined);
    const staffIds = staff.map((s) => s.id);

    const { ready, profiles } = await listHrProfiles(client.id, staffIds);
    if (!ready) return notSetUp();

    // READ ONLY WITH PAY ACCESS. A coordinator's request never touches this table.
    const rates = includesPay ? (await listPayRates(client.id, staffIds)).rates : [];

    const people: HrPerson[] = staff.map((person) => {
      const profile = profiles.get(person.id) ?? null;
      const entry: HrPerson = {
        staffId: person.id,
        name: person.name,
        role: person.role,
        siteId: person.siteId,
        active: person.active,
        profile,
        entitlement: resolveEntitlement({
          availability: person.availability,
          contractedDaysPerWeek: profile?.contractedDaysPerWeek ?? null,
          entitlementDaysOverride: profile?.entitlementDaysOverride ?? null,
          employmentStart: profile?.employmentStart ?? null,
          employmentEnd: profile?.employmentEnd ?? null,
          leaveYearStartMonth: profile?.leaveYearStartMonth ?? null,
          onDay: asOfDay,
        }),
      };

      // The key is only ever CREATED when the caller may see it.
      if (includesPay) {
        const mine = rates.filter((r) => r.staffId === person.id);
        const forRule: PayRate[] = mine.map((r) => ({
          staffId: r.staffId,
          hourlyPence: r.hourlyPence,
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
        }));
        entry.pay = { currentPence: rateOnDay(asOfDay, forRule), history: mine };
      }

      return entry;
    });

    const payload: HrProfileResponse = { ok: true, ready: true, includesPay, canEdit, asOfDay, people };
    return Response.json(payload);
  } catch {
    return notSetUp();
  }
}

export async function PATCH(request: Request): Promise<Response> {
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
    (typeof body.clientSlug === "string" ? body.clientSlug : "") ||
      (new URL(request.url).searchParams.get("client") ?? ""),
  );
  if (!client) return bad("Unknown client", 404);

  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return clientDenied;
  const moduleDenied = requireModuleApiAccess(auth, "staff-hr");
  if (moduleDenied) return moduleDenied;
  // Writing the employee file is `hr.edit`: owner and agency, not the manager.
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const staffId = str(body.staffId, 60);
  if (!staffId) return bad("staffId is required");

  // The staff member must belong to THIS client. The composite FK would refuse a
  // foreign id anyway, but a 404 here is the honest answer rather than a
  // database error surfacing as a 500.
  const staff = await getStaff(staffId, client.id);
  if (!staff) return bad("Unknown staff member", 404);

  const dateOfBirth = dayField(body.dateOfBirth);
  const employmentStart = dayField(body.employmentStart);
  const employmentEnd = dayField(body.employmentEnd);
  if (body.dateOfBirth !== undefined && dateOfBirth === undefined) return bad("dateOfBirth must be YYYY-MM-DD");
  if (body.employmentStart !== undefined && employmentStart === undefined) {
    return bad("employmentStart must be YYYY-MM-DD");
  }
  if (body.employmentEnd !== undefined && employmentEnd === undefined) {
    return bad("employmentEnd must be YYYY-MM-DD");
  }
  if (employmentStart && employmentEnd && employmentEnd < employmentStart) {
    return bad("The leaving date cannot be before the start date.");
  }

  const contracted = numberField(body.contractedDaysPerWeek, 0, 7);
  if (body.contractedDaysPerWeek !== undefined && contracted === undefined) {
    return bad("contractedDaysPerWeek must be between 0 and 7");
  }
  const override = numberField(body.entitlementDaysOverride, 0, 366);
  if (body.entitlementDaysOverride !== undefined && override === undefined) {
    return bad("entitlementDaysOverride must be between 0 and 366");
  }
  const leaveMonth = numberField(body.leaveYearStartMonth, 1, 12);
  if (body.leaveYearStartMonth !== undefined && leaveMonth === undefined) {
    return bad("leaveYearStartMonth must be between 1 and 12");
  }

  const address = objectField(body.address, ["line1", "line2", "town", "postcode"]);
  if (body.address !== undefined && address === undefined) return bad("address must be an object");
  const emergencyContact = objectField(body.emergencyContact, ["name", "relationship", "phone"]);
  if (body.emergencyContact !== undefined && emergencyContact === undefined) {
    return bad("emergencyContact must be an object");
  }

  // THE FULL NI NUMBER IS NOT STORABLE. Four characters is enough to reconcile a
  // payroll export and useless on its own; anything longer is refused here as
  // well as by the column's own check constraint.
  const rawNi = str(body.niNumberLast4, 20);
  if (rawNi !== undefined && rawNi !== null && rawNi.length > 4) {
    return bad("Record only the last four characters of the National Insurance number.");
  }

  try {
    const profile = await upsertHrProfile(
      client.id,
      staffId,
      {
        ...(body.dateOfBirth !== undefined ? { dateOfBirth } : {}),
        ...(body.personalEmail !== undefined ? { personalEmail: str(body.personalEmail) ?? null } : {}),
        ...(body.personalPhone !== undefined ? { personalPhone: str(body.personalPhone, 40) ?? null } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(emergencyContact !== undefined ? { emergencyContact } : {}),
        ...(body.employmentStart !== undefined ? { employmentStart } : {}),
        ...(body.employmentEnd !== undefined ? { employmentEnd } : {}),
        ...(contracted !== undefined ? { contractedDaysPerWeek: contracted } : {}),
        ...(override !== undefined ? { entitlementDaysOverride: override } : {}),
        ...(leaveMonth !== undefined && leaveMonth !== null ? { leaveYearStartMonth: leaveMonth } : {}),
        ...(body.gdcNumber !== undefined ? { gdcNumber: str(body.gdcNumber, 40) ?? null } : {}),
        ...(rawNi !== undefined ? { niNumberLast4: rawNi } : {}),
      },
      auth?.id ?? null,
    );

    // The response carries no pay, whoever the caller is: this route writes the
    // NON-pay file, and a write is never a reason to hand a rate back.
    return Response.json({ ok: true, profile });
  } catch {
    return notSetUp();
  }
}
