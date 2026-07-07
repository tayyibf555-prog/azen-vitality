import { PageHeader } from "@/components/primitives";
import { getClient, getSites, NOW } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { listAppointments, type AppointmentRecord } from "@/lib/dentally/read";
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

  // Load a window around now; the board navigates within it.
  const from = new Date(NOW);
  from.setUTCDate(from.getUTCDate() - 14);
  const to = new Date(NOW);
  to.setUTCDate(to.getUTCDate() + 45);

  let appointments: AppointmentRecord[] = [];
  try {
    appointments = await listAppointments(siteIds, { from: isoDate(from), to: isoDate(to) });
  } catch {
    appointments = [];
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
        nowIso={NOW.toISOString()}
        initialSiteFilter={scope.isAllSites ? "all" : scope.selection}
      />
    </>
  );
}
