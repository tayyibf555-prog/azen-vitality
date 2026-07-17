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
        hero
        title="Reactivation"
        description="Dormant patients ranked by recoverable value and worked through a multi step cadence, with replies picked up by the AI Booking Agent."
      />

      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard label="Dormant patients" value={dormant.length} dot="bg-status-blue" hint="Open across all cohorts" />
        <StatCard label="Recoverable value" value={gbp(totalRecoverable)} dot="bg-status-amber" hint="Across dormant patients" />
        <StatCard label="In cadence" value={inCadence.length} dot="bg-status-blue" hint="Active outreach sequences" />
        <StatCard label="Re-engaged" value={converted.length} dot="bg-status-green" hint="Booked back in" />
      </div>

      <DailyLimitCard clientSlug={clientSlug} />

      {targets.length === 0 ? (
        <EmptyState
          icon={RotateCcw}
          title="No dormant patients synced yet"
          description="Run the reactivation sync to pull lapsed patients, overdue recalls and stalled plans into this worklist. This view is mock safe, so it stays empty until real data lands."
        />
      ) : (
        <Worklist targets={targets} cadences={cadences} nowIso={new Date().toISOString()} />
      )}
    </>
  );
}
