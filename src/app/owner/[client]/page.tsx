import { Building2 } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  DataTable,
  type Column,
} from "@/components/primitives";
import { PracticeDashboard } from "@/components/client/dashboard/practice-dashboard";
import { TaskQueueBoard } from "@/components/client/task-queue/task-queue-board";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { OwnerViewSwitch } from "@/components/owner/owner-view-switch";
import { SystemsCatalog } from "@/components/owner/systems-catalog";
import { readPracticeDashboard } from "@/lib/dashboard/read";
import { getClient, getSites, getSite } from "@/lib/mock";
import { getViewScope, getViewSiteSelection, ALL_SITES } from "@/lib/site-view";
import { listOpportunities } from "@/lib/coordinator/repository";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";
import { gbp } from "@/lib/utils";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE OWNER LANDS ON THE SAME DASHBOARD THE PRACTICE DOES, AND THEN ON MORE.
//
// This page used to open on the OLD OverviewDashboard while /c/[client] opened
// on the new PracticeDashboard: the owner signing in saw a screen a whole
// generation behind the one their practice manager saw, which is exactly the
// comparison the practice makes against Dentally.
//
// So the dashboard comes FIRST and is read exactly as c/[client]/page.tsx reads
// it - every site, with the top bar's current selection deciding only what the
// strip opens on - and the owner-only material follows UNDERNEATH rather than
// replacing any of it. Nothing an owner had is gone: the Systems catalogue, the
// operations/systems switch, the treatment-recovery band and the funnel overview
// are all still here, in the order an owner reads them (the day first, then the
// business).
// ---------------------------------------------------------------------------

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

export default async function OwnerHomePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  const client = getClient(clientSlug);

  if (!client) {
    return (
      <PageHeader
        title="Overview"
        description="This client could not be found."
      />
    );
  }

  // The dashboard read and the owner band's scope are independent, so they run
  // concurrently rather than one after the other on every entry into the owner
  // shell. The dashboard reads EVERY site the client runs (the strip's all-sites
  // toggle is the point); the owner band below is scoped to the top bar's
  // selection, which is the behaviour it already had.
  const [selection, view, scope] = await Promise.all([
    getViewSiteSelection(client.id),
    readPracticeDashboard({ clientId: client.id, now: new Date() }),
    getViewScope(client.id),
  ]);

  const siteIds = scope.siteIds;
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

  // No PageHeader above the dashboard, for the same reason /c has none: a hero
  // title plus a subtitle repeating the panel headings costs about ninety pixels
  // of the fold. The dashboard renders its own compact title line.
  //
  // WIDTH, and this tree is the reason it is done this way. data-wide drops the
  // shell's max-w-[1400px] cap for the dashboard, which is an instrument and was
  // throwing away 388px of a 1920 monitor. But the marker is read by a :has() on
  // the shell's main column and :has() matches ANY descendant, so setting it here
  // un-caps EVERY child of that column: the task queue, the Management header, the
  // owner stat row, the recovery table and the whole systems catalogue would all
  // go full-bleed too. A 2500px line of body copy is not a better owner console.
  //
  // So everything below the dashboard is re-capped, in one wrapper, at the same
  // 1400px the shell caps at. (Not to the pixel: the shell's cap includes its own
  // px-6 gutter and this one does not, so the console runs 48px wider than before
  // on a large screen. Centred and at that size, that is not a difference anyone
  // reads - and matching it exactly would mean hardcoding 1400-minus-a-gutter.)
  //
  // c/[client]/page.tsx carries the identical structure - same marker, same
  // wrapper, same class string - because the two trees render the same dashboard
  // and must not disagree about its size.
  return (
    <div data-wide className="space-y-4">
      <PracticeDashboard
        view={view}
        clientSlug={clientSlug}
        initialSiteId={selection === ALL_SITES ? null : selection}
      />
      <div className="mx-auto max-w-[1400px] space-y-4">
        <TaskQueueBoard
          plain
          clientSlug={clientSlug}
          maxRows={8}
          title="Next actions"
          description="The highest-priority work across every module. Finish one and the next slides in."
        />

        {/* Everything below this line is the OWNER's, and nobody else's. */}
        <PageHeader
          title="Management"
          description="Your owner command view. Switch between practice operations and the AI systems running them."
        />

        <OwnerViewSwitch
          systems={<SystemsCatalog />}
          operations={
            <>
              <div className="flex flex-wrap gap-x-7 gap-y-4">
                <StatCard
                  label="Recoverable value"
                  value={gbp(totalRecoverable)}
                  dot="bg-status-amber"
                  hint="Outstanding across open plans"
                />
                <StatCard
                  label="Open opportunities"
                  value={openCount}
                  dot="bg-status-blue"
                  hint="Plans not yet completed"
                />
                <StatCard
                  label="Recovered to date"
                  value={gbp(recoveredToDate)}
                  dot="bg-status-green"
                  hint="Completed plan value"
                />
              </div>

              <SectionCard
                title="Treatment recovery"
                description={
                  scope.isAllSites
                    ? "Accepted but incomplete treatment across all sites, live from the coordinator."
                    : `Accepted but incomplete treatment at ${scope.siteName}, live from the coordinator.`
                }
                bodyClassName="p-0"
              >
                {opportunities.length === 0 ? (
                  <p className="m-5 flex items-center gap-2 rounded-lg border border-line bg-card-muted px-4 py-3 text-sm text-muted">
                    <Building2 size={15} className="shrink-0 text-muted" />
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
      </div>
    </div>
  );
}
