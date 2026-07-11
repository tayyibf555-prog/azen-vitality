import { PageHeader, StatCard } from "@/components/primitives";
import { Users, UserCheck, UserX, CalendarClock } from "lucide-react";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { listPatients, countPatients, type PatientRecord } from "@/lib/dentally/read";
import { PatientsTable } from "./patients-table";

export async function PatientsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Patients" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);
  // Load only a bounded first slice (~300) so the page is fast on a real-size
  // practice (~8k patients would otherwise be ~80 sequential Dentally calls). The
  // table's search box runs a server-side Dentally query to reach anyone beyond it.
  // The EXACT site total comes separately from Dentally's index metadata (one
  // 1-row call, 5-min cache) so the headline number is the real book size, not
  // the size of the slice we happened to fetch.
  let patients: PatientRecord[] = [];
  let exactTotal: number | null = null;
  try {
    [patients, exactTotal] = await Promise.all([
      listPatients(scope.siteIds, { maxPages: 3 }),
      countPatients(scope.siteIds),
    ]);
  } catch {
    patients = [];
  }

  const nowIso = new Date().toISOString();
  // Counts below are over the bounded slice, NOT the whole book, so they'd be
  // misleading as headline totals — hence the caption under the grid and the
  // Patients card's honest "First 300 shown, search for any patient" hint.
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
        <StatCard
          label="Patients"
          value={(exactTotal ?? patients.length).toLocaleString("en-GB")}
          icon={Users}
          hint={
            exactTotal !== null
              ? `${scope.isAllSites ? "Total across all sites" : `Total at ${scope.siteName}`}; first ${Math.min(patients.length, 300)} listed below`
              : "First 300 shown, search for any patient"
          }
        />
        <StatCard label="Active" value={active} icon={UserCheck} hint="Currently active" />
        <StatCard label="Lapsed" value={lapsed} icon={UserX} hint="Archived or inactive" />
        <StatCard label="Due a recall" value={dueRecall} icon={CalendarClock} hint="Recall date passed" />
      </div>
      <p className="-mt-1 text-xs text-muted">
        Active, lapsed and recall counts reflect the patients listed below. Search to find any patient.
      </p>

      <PatientsTable
        patients={patients.filter((p) => p.active)}
        nowIso={nowIso}
        clientSlug={clientSlug}
        initialFilter="active"
      />
    </>
  );
}
