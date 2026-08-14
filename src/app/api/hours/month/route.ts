import { getClient } from "@/lib/mock/clients";
import {
  requireApproverRole,
  requireClientAccess,
  requireModuleApiAccess,
  requireUser,
} from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getViewScope } from "@/lib/site-view";
import { listShifts, listStaff } from "@/lib/rota/repository";
import { listAllEvents } from "@/lib/clock/repository";
import { requireCapability, hasCapability } from "@/lib/auth/capability-guard";
import { listPayRates } from "@/lib/hr/repository";
import { buildMonthReport, currentMonth, monthBounds } from "@/lib/hours/report";
import type { HoursStaff, PayRate } from "@/lib/hours/types";
import { londonDayEndIso, londonDayStartIso } from "@/lib/calendar/availability";
import type { RosteredShift } from "@/lib/clock/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// THE MONTH'S HOURS.
//
// THE GUARD CHAIN:
//   requireUser            somebody is signed in;
//   requireClientAccess    they belong to this practice;
//   requireModuleApiAccess they may have the Hours module (this refuses the
//                          clinician and the staff role, neither of whom has
//                          "hours");
//   requireApproverRole    owner, agency and the practice manager — she is the
//                          person who runs the month.
//
// COST IS NARROWER THAN THE MODULE. The practice manager runs this screen and
// must not see what individuals are paid, so the rate table is NOT READ for her
// and `buildMonthReport` is told not to build the fields at all. The response she
// receives has no cost keys on it: nothing to hide in the client, nothing to leak
// in the JSON.
//
// THE PAYROLL BOUNDARY. Hours and cost only. No payments, no HMRC, no RTI, no
// payslips, no deductions. Stated in the response and on the page.
//
// THE READ IS PAGED. `listEvents` caps at 500 rows, which silently truncates a
// month for a practice of any size and understates everybody's pay; this route
// uses `listAllEvents`, and when even that hits its ceiling the report comes back
// `truncated` and refuses to be called final.
// ===========================================================================

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** Add whole days to a `YYYY-MM-DD` key (noon anchored, so DST cannot roll it). */
function addDays(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
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
  const moduleDenied = requireModuleApiAccess(auth, "hours");
  if (moduleDenied) return moduleDenied;
  const roleDenied = requireApproverRole(auth);
  if (roleDenied) return roleDenied;
  const capDenied = await requireCapability(auth, "hours.view");
  if (capDenied) return capDenied;

  const now = new Date();
  const asked = url.searchParams.get("month") ?? "";
  const month = MONTH.test(asked) ? asked : currentMonth(now);
  const bounds = monthBounds(month);
  if (!bounds) return bad("month must be YYYY-MM");

  // COST IS A SEPARATE QUESTION, AND IT IS OMISSION RATHER THAN REFUSAL. A caller
  // without `hr.view-pay` still gets the month — with no cost keys on it, because
  // the rate table below is never read for them. That is why this is `hasCapability`
  // and not `requireCapability`: refusing the whole report would take the practice
  // manager's own screen away to hide a column she was never shown.
  const includeCost = await hasCapability(auth, "hr.view-pay");
  const scope = await getViewScope(client.id);
  const siteScope = scope.isAllSites ? undefined : scope.siteIds;

  try {
    // EVERYBODY, not only the active: somebody who left in the middle of the
    // month still worked the first half of it, and a month that quietly drops
    // them is a month somebody is not paid for.
    const staffRows = await listStaff(client.id, siteScope ? { siteIds: siteScope } : undefined);
    const staff: HoursStaff[] = staffRows.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      siteId: s.siteId,
    }));
    const staffIds = staff.map((s) => s.id);
    const visible = new Set(staffIds);

    // A DAY OF MARGIN EACH SIDE, so a session that runs past midnight on the last
    // of the month is still paired with the clock-out that closed it. The report
    // attributes sessions by their clock-IN day, so the margin cannot double count.
    const [{ ready, events, truncated }, shiftRows] = await Promise.all([
      listAllEvents(client.id, {
        fromIso: londonDayStartIso(addDays(bounds.from, -1)),
        toIso: londonDayEndIso(addDays(bounds.to, 1)),
        staffIds,
        siteIds: siteScope,
      }),
      listShifts(client.id, bounds.from, bounds.to),
    ]);

    const shifts: RosteredShift[] = shiftRows.filter(
      (s) => visible.has(s.staffId) && (scope.isAllSites || scope.siteIds.includes(s.siteId)),
    );

    // READ ONLY WITH PAY ACCESS.
    let rates: PayRate[] = [];
    if (includeCost) {
      const payRates = await listPayRates(client.id, staffIds);
      rates = payRates.rates.map((r) => ({
        staffId: r.staffId,
        hourlyPence: r.hourlyPence,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
      }));
    }

    const report = buildMonthReport({
      staff,
      events,
      shifts,
      rates,
      month,
      now,
      ready,
      truncated,
      includeCost,
    });

    return Response.json({
      ok: true,
      report,
      scope: { label: scope.label, isAllSites: scope.isAllSites },
      /** Read as of, for the export stamp. Never invented client side. */
      asOf: now.toISOString(),
      boundary: "Hours and cost only. Not payroll: nothing here is submitted to HMRC.",
    });
  } catch {
    // LOUD. A failed read renders a failure, never a confident empty month.
    return Response.json(
      { ok: false, error: "The month's hours could not be read." },
      { status: 503 },
    );
  }
}
