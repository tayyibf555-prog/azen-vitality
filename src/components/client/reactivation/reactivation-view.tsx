import { RotateCcw } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "@/components/client/reactivation/worklist";
import { DailyLimitCard } from "@/components/client/reactivation/daily-limit-card";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listTargets, listCadences } from "@/lib/reactivation/repository";
import type { ReactivationCadence, ReactivationTarget } from "@/lib/reactivation/types";
import { gbp } from "@/lib/utils";

async function loadData(siteIds: string[]): Promise<{
  targets: ReactivationTarget[];
  cadences: ReactivationCadence[];
}> {
  try {
    const [targets, cadences] = await Promise.all([
      listTargets({ siteIds }),
      listCadences(siteIds),
    ]);
    return { targets, cadences };
  } catch {
    return { targets: [], cadences: [] };
  }
}

export async function ReactivationView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);

  if (!client) {
    return <PageHeader title="Reactivation" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const { targets, cadences } = await loadData(siteIds);

  const dormant = targets.filter((t) => t.status === "dormant" || t.status === "in_cadence");
  const converted = targets.filter((t) => t.status === "converted");
  const inCadence = targets.filter((t) => t.status === "in_cadence");
  const totalRecoverable = dormant.reduce((sum, t) => sum + t.recoverableValue, 0);

  return (
    <>
      <PageHeader
        title="Reactivation"
        description="Dormant patients ranked by recoverable value and worked through a multi step cadence, with replies picked up by the AI Booking Agent."
        stats={
          <>
            <StatCard label="Dormant patients" value={dormant.length} dot="bg-status-blue" />
            <StatCard label="Recoverable value" value={gbp(totalRecoverable)} dot="bg-status-amber" />
            <StatCard label="In cadence" value={inCadence.length} dot="bg-status-blue" />
            <StatCard label="Re-engaged" value={converted.length} dot="bg-status-green" />
          </>
        }
      />

      {/* Two-zone: the worklist takes the wide column, the owner's daily-cap
          setting sits in the rail (stacks below on narrow widths). */}
      <div className="grid items-start gap-x-11 gap-y-8 lg:grid-cols-[minmax(0,1fr)_288px]">
        <div className="min-w-0">
          {targets.length === 0 ? (
            <EmptyState
              icon={RotateCcw}
              title="No dormant patients synced yet"
              description="Run the reactivation sync to pull lapsed patients, overdue recalls and stalled plans into this worklist. This view is mock safe, so it stays empty until real data lands."
            />
          ) : (
            <Worklist targets={targets} cadences={cadences} nowIso={new Date().toISOString()} />
          )}
        </div>
        <aside className="space-y-7">
          <DailyLimitCard clientSlug={clientSlug} />
        </aside>
      </div>
    </>
  );
}
