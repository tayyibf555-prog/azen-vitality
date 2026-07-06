import { CalendarClock, Clock, AlertTriangle, Send, CheckCircle2 } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "@/components/client/recall/worklist";
import { getClient, getSites, NOW } from "@/lib/mock/clients";
import { listTargets, listCadences } from "@/lib/recall/repository";
import type { RecallCadence, RecallTarget } from "@/lib/recall/types";

async function loadData(siteIds: string[]): Promise<{
  targets: RecallTarget[];
  cadences: RecallCadence[];
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

export async function RecallView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);

  if (!client) {
    return <PageHeader title="Recall concierge" description="This client could not be found." />;
  }

  const siteIds = getSites(client.id).map((s) => s.id);
  const { targets, cadences } = await loadData(siteIds);

  const open = targets.filter((t) => t.status === "due" || t.status === "in_cadence");
  const dueSoon = open.filter((t) => t.overdueDays < 0);
  const overdue = open.filter((t) => t.overdueDays >= 0);
  const inCadence = targets.filter((t) => t.status === "in_cadence");
  const booked = targets.filter((t) => t.status === "converted");

  return (
    <>
      <PageHeader
        hero
        title="Recall concierge"
        description="Books patients back in before their recall lapses, on an SMS and email cadence with consent respected."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Due soon" value={dueSoon.length} icon={Clock} hint="Within the lead window" />
        <StatCard label="Overdue" value={overdue.length} icon={AlertTriangle} hint="Past due, inside the recall window" />
        <StatCard label="In cadence" value={inCadence.length} icon={Send} hint="Active outreach sequences" />
        <StatCard label="Booked back" value={booked.length} icon={CheckCircle2} hint="Recalls booked in" />
      </div>

      {targets.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No recalls due yet"
          description="Run the recall sync to pull due and overdue recall dates from Dentally into this worklist. This view is mock safe, so it stays empty until data lands."
        />
      ) : (
        <Worklist targets={targets} cadences={cadences} nowIso={NOW.toISOString()} />
      )}
    </>
  );
}
