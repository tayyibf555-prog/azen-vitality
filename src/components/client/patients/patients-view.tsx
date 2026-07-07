import { PageHeader, StatCard } from "@/components/primitives";
import { Users, UserCheck, UserX, CalendarClock } from "lucide-react";
import { getClient, NOW } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listPatients, type PatientRecord } from "@/lib/dentally/read";
import { PatientsTable } from "./patients-table";

export async function PatientsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Patients" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  let patients: PatientRecord[] = [];
  try {
    patients = await listPatients(siteIds);
  } catch {
    patients = [];
  }

  const nowIso = NOW.toISOString();
  const active = patients.filter((p) => p.active).length;
  const lapsed = patients.filter((p) => !p.active).length;
  const dueRecall = patients.filter((p) => p.recallDueAt && p.recallDueAt <= nowIso).length;

  return (
    <>
      <PageHeader
        title="Patients"
        description="Your patient database, live from Dentally, searchable by name or contact with recall and last visit at a glance."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Patients" value={patients.length} icon={Users} hint="Across all sites" />
        <StatCard label="Active" value={active} icon={UserCheck} hint="Currently active" />
        <StatCard label="Lapsed" value={lapsed} icon={UserX} hint="Archived or inactive" />
        <StatCard label="Due a recall" value={dueRecall} icon={CalendarClock} hint="Recall date passed" />
      </div>

      <PatientsTable patients={patients} nowIso={nowIso} />
    </>
  );
}
