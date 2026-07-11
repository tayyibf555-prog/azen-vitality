import { PageHeader, StatCard } from "@/components/primitives";
import { Users, UserCheck, CalendarClock } from "lucide-react";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { listPatients, countPatients, type PatientRecord } from "@/lib/dentally/read";
import { getPatientCounts } from "@/lib/patient-count/repository";
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
  let exactActive: number | null = null;
  try {
    const [slice, metaTotal, counts] = await Promise.all([
      listPatients(scope.siteIds, { maxPages: 3 }),
      countPatients(scope.siteIds),
      getPatientCounts(scope.siteIds).catch(() => []),
    ]);
    patients = slice;
    exactTotal = metaTotal;
    // The nightly book scan gives the EXACT active number (Dentally's live
    // meta.total ignores active/archived filters). Only trust it when every
    // in-scope site has been counted, so a half-covered "All sites" view never
    // shows a confidently wrong number.
    if (counts.length === scope.siteIds.length && counts.length > 0) {
      exactActive = counts.reduce((s, c) => s + c.active, 0);
    }
  } catch {
    patients = [];
  }

  const nowIso = new Date().toISOString();
  // Recall count below is over the bounded slice, NOT the whole book — hence the
  // caption under the grid.
  const activeInSlice = patients.filter((p) => p.active).length;
  const dueRecall = patients.filter((p) => p.recallDueAt && p.recallDueAt <= nowIso).length;

  return (
    <>
      <PageHeader
        title="Patients"
        description="Your patient database, live from Dentally, searchable by name or contact with recall and last visit at a glance."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Active patients"
          value={(exactActive ?? activeInSlice).toLocaleString("en-GB")}
          icon={UserCheck}
          hint={
            exactActive !== null
              ? scope.isAllSites
                ? "Across all sites, counted nightly"
                : `At ${scope.siteName}, counted nightly`
              : "Among the patients listed below"
          }
        />
        <StatCard
          label="On record"
          value={exactTotal !== null ? exactTotal.toLocaleString("en-GB") : "—"}
          icon={Users}
          hint="Whole book including archived records"
        />
        <StatCard label="Due a recall" value={dueRecall} icon={CalendarClock} hint="Among the patients listed below" />
      </div>
      <p className="-mt-1 text-xs text-muted">
        The list shows active patients (first {Math.min(patients.length, 300)}); search reaches everyone, including archived records.
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
