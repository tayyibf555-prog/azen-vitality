import { PoundSterling, ListChecks, CheckCircle2, Building2 } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  DataTable,
  type Column,
} from "@/components/primitives";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { OwnerViewSwitch } from "@/components/owner/owner-view-switch";
import { SystemsCatalog } from "@/components/owner/systems-catalog";
import { getClient, getSites, getSite } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { listOpportunities } from "@/lib/coordinator/repository";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";
import { gbp } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function loadOpportunities(siteIds: string[]): Promise<TreatmentOpportunity[]> {
  try {
    return await listOpportunities({ siteIds });
  } catch {
    // DB may be empty or unreachable in this environment. Treat as no data.
    return [];
  }
}

interface SiteRecovery {
  siteId: string;
  recoverable: number;
  openCount: number;
}

const SITE_RECOVERY_COLUMNS: Column<SiteRecovery>[] = [
  {
    key: "site",
    header: "Site",
    cell: (r) => (
      <span className="font-semibold text-navy">{getSite(r.siteId)?.name ?? r.siteId}</span>
    ),
  },
  {
    key: "open",
    header: "Open opportunities",
    cell: (r) => <span className="tabular-nums">{r.openCount}</span>,
    align: "right",
  },
  {
    key: "recoverable",
    header: "Recoverable value",
    cell: (r) => (
      <span className="font-semibold text-navy tabular-nums">{gbp(r.recoverable)}</span>
    ),
    align: "right",
  },
];

export default async function OwnerManagementPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  const client = getClient(clientSlug);

  if (!client) {
    return (
      <PageHeader
        title="Management"
        description="This client could not be found."
      />
    );
  }

  const siteIds = await getViewSiteIds(client.id);
  const sites = getSites(client.id).filter((s) => siteIds.includes(s.id));
  const opportunities = await loadOpportunities(siteIds);

  const open = opportunities.filter((o) => o.status !== "completed");
  const completed = opportunities.filter((o) => o.status === "completed");

  const totalRecoverable = open.reduce((sum, o) => sum + o.amountOutstanding, 0);
  const openCount = open.length;
  const recoveredToDate = completed.reduce((sum, o) => sum + o.plannedValue, 0);

  const siteRecovery: SiteRecovery[] = sites
    .map((s) => {
      const siteOpen = open.filter((o) => o.siteId === s.id);
      return {
        siteId: s.id,
        recoverable: siteOpen.reduce((sum, o) => sum + o.amountOutstanding, 0),
        openCount: siteOpen.length,
      };
    })
    .sort((a, b) => b.recoverable - a.recoverable);

  return (
    <>
      <PageHeader
        hero
        title="Management"
        description="Your owner command view. Switch between practice operations and the AI systems running them."
      />

      <OwnerViewSwitch
        systems={<SystemsCatalog />}
        operations={
          <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Recoverable value"
          value={gbp(totalRecoverable)}
          icon={PoundSterling}
          hint="Outstanding across open plans"
        />
        <StatCard
          label="Open opportunities"
          value={openCount}
          icon={ListChecks}
          hint="Plans not yet completed"
        />
        <StatCard
          label="Recovered to date"
          value={gbp(recoveredToDate)}
          icon={CheckCircle2}
          hint="Completed plan value"
        />
      </div>

      <SectionCard
        title="Treatment recovery"
        description="Accepted but incomplete treatment across all sites, live from the coordinator."
        bodyClassName="p-0"
      >
        {opportunities.length === 0 ? (
          <p className="m-5 flex items-center gap-2 rounded-lg border border-line bg-card-muted px-4 py-3 text-sm text-muted">
            <Building2 size={15} className="shrink-0 text-blue-dark" />
            No opportunities synced yet. Run the Dentally sync to populate the per-site
            breakdown. This view stays empty until real data lands.
          </p>
        ) : (
          <DataTable
            columns={SITE_RECOVERY_COLUMNS}
            rows={siteRecovery}
            getRowKey={(r) => r.siteId}
            className="px-2 py-1"
          />
        )}
      </SectionCard>

      <OverviewDashboard hideHero siteIds={siteIds} />
          </>
        }
      />
    </>
  );
}
