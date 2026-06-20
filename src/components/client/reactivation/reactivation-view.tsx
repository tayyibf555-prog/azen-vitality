import { RotateCcw, PoundSterling, Users, CheckCircle2, Send } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "@/components/client/reactivation/worklist";
import { AgentSection } from "@/components/client/agent/agent-section";
import { getClient, getSites, NOW } from "@/lib/mock/clients";
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

  const siteIds = getSites(client.id).map((s) => s.id);
  const { targets, cadences } = await loadData(siteIds);

  const dormant = targets.filter((t) => t.status === "dormant" || t.status === "in_cadence");
  const converted = targets.filter((t) => t.status === "converted");
  const inCadence = targets.filter((t) => t.status === "in_cadence");
  const totalRecoverable = dormant.reduce((sum, t) => sum + t.recoverableValue, 0);

  return (
    <>
      <PageHeader
        title="Reactivation"
        description="Win back dormant patients. Lapsed visitors, overdue recalls and stalled treatment plans are ranked by recoverable value and worked through a multi step cadence. When a patient replies, the AI booking agent below takes over and books them in."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Dormant patients" value={String(dormant.length)} icon={Users} hint="Open across all cohorts" />
        <StatCard label="Recoverable value" value={gbp(totalRecoverable)} icon={PoundSterling} hint="Across dormant patients" />
        <StatCard label="In cadence" value={String(inCadence.length)} icon={Send} hint="Active outreach sequences" />
        <StatCard label="Re-engaged" value={String(converted.length)} icon={CheckCircle2} hint="Booked back in" />
      </div>

      {targets.length === 0 ? (
        <EmptyState
          icon={RotateCcw}
          title="No dormant patients synced yet"
          description="Run the reactivation sync to pull lapsed patients, overdue recalls and stalled plans into this worklist. This view is mock safe, so it stays empty until real data lands."
        />
      ) : (
        <Worklist targets={targets} cadences={cadences} nowIso={NOW.toISOString()} />
      )}

      <AgentSection siteIds={siteIds} />
    </>
  );
}
