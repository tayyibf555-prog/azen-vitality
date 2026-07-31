// ===========================================================================
// GET /api/calendar/day?site=<siteId>&days=<YYYY-MM-DD,...>
//
// The diary's availability, funding and entries for one to seven London days.
//
// It NEVER 500s on a partial failure. Each of the five reads carries its own flag
// and the caller renders the difference: a hatched column that says "Hours not
// loaded" is honest, and a 500 that blanks the whole diary is not - the booked
// appointments are still correct and the practice still has to work the day.
// ===========================================================================

import { requireDiaryRead } from "@/lib/calendar/access";
import { loadDiaryDay, MAX_DIARY_DAYS } from "@/lib/calendar/day-load";
import { listAppointmentsSafe, listSitePractitionersSafe } from "@/lib/dentally/read";

export const dynamic = "force-dynamic";

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from one day key to another, inclusive of both ends. */
function spanDays(fromDayKey: string, toDayKey: string): number {
  const from = Date.parse(`${fromDayKey}T00:00:00Z`);
  const to = Date.parse(`${toDayKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.POSITIVE_INFINITY;
  return Math.round((to - from) / 86_400_000) + 1;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const siteId = (url.searchParams.get("site") ?? "").trim();

  const access = await requireDiaryRead(siteId);
  if (access instanceof Response) return access;

  const dayKeys = [
    ...new Set(
      (url.searchParams.get("days") ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d !== ""),
    ),
  ].sort();

  if (dayKeys.length === 0) {
    return Response.json({ ok: false, error: "days is required" }, { status: 400 });
  }
  if (dayKeys.length > MAX_DIARY_DAYS) {
    return Response.json(
      { ok: false, error: `Ask for ${MAX_DIARY_DAYS} days or fewer.` },
      { status: 400 },
    );
  }
  if (dayKeys.some((d) => !DAY_KEY_RE.test(d))) {
    return Response.json({ ok: false, error: "days must be YYYY-MM-DD" }, { status: 400 });
  }
  // THE SPAN, not only the count. Both endpoints are handed straight to the
  // Dentally appointment scan and the availability read as a RANGE, so two keys
  // a decade apart are a decade-wide read of every practitioner at this site
  // against a shared rate budget, from a request that passes a count of two.
  if (spanDays(dayKeys[0], dayKeys[dayKeys.length - 1]) > MAX_DIARY_DAYS) {
    return Response.json(
      { ok: false, error: `Ask for a range of ${MAX_DIARY_DAYS} days or fewer.` },
      { status: 400 },
    );
  }

  // The day's appointments are read SERVER side. Patient ids for the funding
  // fan-out are never taken from the client: a caller could otherwise ask this
  // route to resolve the funding of any patient id it liked.
  const [appointmentsRead, practitionersRead] = await Promise.all([
    listAppointmentsSafe([siteId], { from: dayKeys[0], to: dayKeys[dayKeys.length - 1] }),
    listSitePractitionersSafe(siteId),
  ]);

  const appointmentsFailed =
    appointmentsRead.failed || appointmentsRead.failedSiteIds.includes(siteId);

  const payload = await loadDiaryDay({
    clientId: access.clientId,
    siteId,
    dayKeys,
    practitionerIds: practitionersRead.practitioners.map((p) => p.id),
    practitionersFailed: practitionersRead.failed,
    appointments: appointmentsRead.appointments,
  });

  return Response.json({
    ok: true,
    ...payload,
    appointmentsFailed,
    practitionersFailed: practitionersRead.failed,
  });
}
