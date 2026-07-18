import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { listPatients, countPatients, type PatientRecord } from "@/lib/dentally/read";
import { getPatientCounts } from "@/lib/patient-count/repository";
import { listOverridesForSites } from "@/lib/patient-status/repository";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import { loadNumberHealthByPatient, type NumberHealth } from "@/lib/messaging/number-health";
import { PatientsTable } from "./patients-table";

/** A quiet big-numeral text stat for the header row (was a boxed stat card). */
function HeaderStat({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div>
      <p className="text-[22px] font-bold tracking-[-0.4px] tabular-nums text-navy">{value}</p>
      <p className="mt-0.5 text-[11px] font-medium text-muted">{label}</p>
      <p className="mt-0.5 text-[10.5px] font-normal text-faint">{hint}</p>
    </div>
  );
}

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
  // Platform admin overrides for the sites in scope (few rows - manually set only). Built
  // into a patientId -> status map so the table paints the right chip on any loaded row.
  const overrides: Record<string, PatientAdminStatus> = {};
  try {
    const [slice, metaTotal, counts, overrideRows] = await Promise.all([
      listPatients(scope.siteIds, { maxPages: 3 }),
      countPatients(scope.siteIds),
      getPatientCounts(scope.siteIds).catch(() => []),
      listOverridesForSites(scope.siteIds),
    ]);
    patients = slice;
    exactTotal = metaTotal;
    for (const o of overrideRows) overrides[o.patientId] = o.status;
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
  // The active slice shown in the table. Hoisted so its number-health verdicts are
  // batched in ONE query here (mirroring the overrides load) and passed to the table,
  // rather than each opened record fetching its own.
  const activePatients = patients.filter((p) => p.active);
  const lookups: Record<string, NumberHealth> = await loadNumberHealthByPatient(
    activePatients.map((p) => ({ id: p.id, phone: p.phone })),
  );
  // Recall count below is over the bounded slice, NOT the whole book, hence the
  // caption under the header.
  const activeInSlice = activePatients.length;
  const dueRecall = patients.filter((p) => p.recallDueAt && p.recallDueAt <= nowIso).length;

  return (
    <>
      {/* Header row: title + the same three counts as inline text stats. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-5">
          <div className="max-w-xl">
            <h1 className="text-display text-navy">Patients</h1>
            <p className="mt-1.5 text-[13px] font-normal text-muted">
              Your patient database, live from Dentally, searchable by name or contact with recall
              and last visit at a glance.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-12 gap-y-5">
            <HeaderStat
              label="Active patients"
              value={(exactActive ?? activeInSlice).toLocaleString("en-GB")}
              hint={
                exactActive !== null
                  ? scope.isAllSites
                    ? "Across all sites, counted nightly"
                    : `At ${scope.siteName}, counted nightly`
                  : "Among the patients listed below"
              }
            />
            <HeaderStat
              label="On record"
              value={exactTotal !== null ? exactTotal.toLocaleString("en-GB") : "-"}
              hint="Whole book including archived records"
            />
            <HeaderStat label="Due a recall" value={dueRecall} hint="Among the patients listed below" />
          </div>
        </div>
        <p className="text-caption font-normal text-faint">
          The list shows active patients (first {Math.min(patients.length, 300)}); search reaches
          everyone, including archived records.
        </p>
      </section>

      <PatientsTable
        patients={activePatients}
        nowIso={nowIso}
        clientSlug={clientSlug}
        initialFilter="active"
        overrides={overrides}
        lookups={lookups}
      />
    </>
  );
}
