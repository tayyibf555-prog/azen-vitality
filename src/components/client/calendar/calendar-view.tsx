import { PageHeader } from "@/components/primitives";
import { getClient, getSites, NOW } from "@/lib/mock/clients";
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

  const sites = getSites(client.id);
  const siteIds = sites.map((s) => s.id);

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
      />
    </>
  );
}
