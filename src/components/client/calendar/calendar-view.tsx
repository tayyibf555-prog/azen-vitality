import { PageHeader } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { listAppointmentsSafe, type AppointmentRecord } from "@/lib/dentally/read";
import { CalendarBoard } from "./calendar-board";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function CalendarView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Calendar" description="This client could not be found." />;
  }

  // Scope the diary to the dashboard's selected site (default N15) so only that
  // site's appointments load; "All sites" loads every site and the board's in-view
  // filter works within that set.
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
  let appointments: AppointmentRecord[] = [];
  let loadFailed = false;
  try {
    const result = await listAppointmentsSafe(siteIds, { from: windowFrom, to: windowTo });
    appointments = result.appointments;
    loadFailed = result.failed;
  } catch {
    appointments = [];
    loadFailed = true;
  }

  return (
    <>
      <PageHeader
        title="Calendar"
        description="The live diary from Dentally, navigable by day or week and filterable by site."
      />
      <CalendarBoard
        appointments={appointments}
        sites={sites.map((s) => ({ id: s.id, name: s.name }))}
        nowIso={now.toISOString()}
        initialSiteFilter={scope.isAllSites ? "all" : scope.selection}
        loadFailed={loadFailed}
        windowFrom={windowFrom}
        windowTo={windowTo}
      />
    </>
  );
}
