import { cookies } from "next/headers";
import { PageHeader } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import {
  listAppointmentsSafe,
  listSitePractitionersSafe,
  type AppointmentRecord,
} from "@/lib/dentally/read";
import { CalendarBoard, type PractitionersForSite } from "./calendar-board";
import { DIARY_ZOOM_COOKIE, parseZoom } from "./diary-view";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function CalendarView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Calendar" description="This client could not be found." />;
  }

  // Scope the diary to the dashboard's selected site (default N15) so only that
  // site's appointments load; "All sites" loads every site and the board's own
  // site control picks one practice at a time from within that set.
  const scope = await getViewScope(client.id);
  const siteIds = scope.siteIds;
  const sites = getSites(client.id).filter((s) => siteIds.includes(s.id));

  // Load a window around now; the board navigates within it. Use the REAL current
  // time, never the frozen mock clock: on live Dentally a hardcoded date would open
  // the diary on the wrong day and, once the real date passed the frozen window,
  // stop including today's appointments entirely.
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 14);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + 45);
  const windowFrom = isoDate(from);
  const windowTo = isoDate(to);

  // listAppointmentsSafe (not listAppointments) so a genuine Dentally read failure
  // is told apart from a genuinely empty day (go-live defect B3): the board renders
  // an amber "could not load" notice instead of a confident "nothing booked", and a
  // failed read is never cached, so an outage cannot make the empty-diary lie
  // persist for the read cache's TTL.
  //
  // The clinician lists load in the SAME pass, one call per site, all in parallel
  // with the appointment read. They are the diary's COLUMNS, so a silent failure
  // there would collapse the column set to whatever the day's appointments imply
  // and make a half-staffed diary look correctly staffed and correctly free;
  // listSitePractitionersSafe reports the failure rather than returning [].
  //
  // Both failure signals are carried PER SITE, because the grid shows one practice
  // at a time out of a multi-site read and slices it client-side. The read's own
  // `failed` boolean is a whole-request verdict that stays false whenever any site
  // returned rows, so on its own it would let the site switcher land on a practice
  // whose read threw and draw a confident empty diary for it.
  let appointments: AppointmentRecord[] = [];
  let loadFailed = false;
  let failedSiteIds: string[] = [];
  let practitionersBySite: Record<string, PractitionersForSite> = {};
  let practitionersFailed = false;
  try {
    const [appts, perSite] = await Promise.all([
      listAppointmentsSafe(siteIds, { from: windowFrom, to: windowTo }),
      Promise.all(
        sites.map(async (s) => ({ siteId: s.id, ...(await listSitePractitionersSafe(s.id)) })),
      ),
    ]);
    appointments = appts.appointments;
    loadFailed = appts.failed;
    failedSiteIds = appts.failedSiteIds;
    practitionersBySite = Object.fromEntries(
      perSite.map((p) => [
        p.siteId,
        {
          // Sorted here so the column order is decided once, and diaryColumns'
          // own semantics (empty columns kept, locums appended, Unassigned last)
          // are left untouched.
          practitioners: [...p.practitioners].sort((a, b) => a.name.localeCompare(b.name, "en-GB")),
          failed: p.failed,
        },
      ]),
    );
    practitionersFailed = perSite.some((p) => p.failed);
  } catch {
    appointments = [];
    loadFailed = true;
    failedSiteIds = siteIds;
    practitionersBySite = {};
    practitionersFailed = true;
  }

  // The remembered row height is read HERE, not from localStorage after hydration,
  // so the first paint is already the right density and nothing corrects itself.
  const zoom = parseZoom((await cookies()).get(DIARY_ZOOM_COOKIE)?.value);

  return (
    <CalendarBoard
      appointments={appointments}
      sites={sites.map((s) => ({ id: s.id, name: s.name, openingHours: s.openingHours }))}
      practitionersBySite={practitionersBySite}
      nowIso={now.toISOString()}
      initialSite={scope.isAllSites ? sites[0]?.id ?? "" : scope.selection}
      isAllSites={scope.isAllSites}
      loadFailed={loadFailed}
      failedSiteIds={failedSiteIds}
      practitionersFailed={practitionersFailed}
      windowFrom={windowFrom}
      windowTo={windowTo}
      clientSlug={clientSlug}
      initialZoom={zoom}
    />
  );
}
