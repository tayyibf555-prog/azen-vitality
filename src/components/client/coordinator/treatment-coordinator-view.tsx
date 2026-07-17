import { HeartPulse } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "@/components/client/coordinator/worklist";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listOpportunities } from "@/lib/coordinator/repository";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";
import { gbp } from "@/lib/utils";

const DAY = 86_400_000;

function daysStalled(acceptedAt: string, now: Date): number {
  if (!acceptedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(acceptedAt).getTime()) / DAY));
}

async function loadOpportunities(siteIds: string[]): Promise<TreatmentOpportunity[]> {
  try {
    return await listOpportunities({ siteIds });
  } catch {
    // DB may be empty or unreachable in this environment. Treat as no data.
    return [];
  }
}

export async function TreatmentCoordinatorView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);

  if (!client) {
    return (
      <PageHeader
        title="Treatment Coordinator"
        description="This client could not be found."
      />
    );
  }

  const siteIds = await getViewSiteIds(client.id);
  const opportunities = await loadOpportunities(siteIds);

  // Real current time, never the frozen mock clock: "days stalled" must count from
  // today, not a hardcoded date, once this reads live data.
  const now = new Date();
  const open = opportunities.filter((o) => o.status !== "completed");
  const completed = opportunities.filter((o) => o.status === "completed");
  const stalled = opportunities.filter((o) => o.status === "stalled");

  const totalRecoverable = open.reduce((sum, o) => sum + o.amountOutstanding, 0);
  const recoveredToDate = completed.reduce((sum, o) => sum + o.plannedValue, 0);
  const avgDaysStalled =
    stalled.length > 0
      ? Math.round(
          stalled.reduce((sum, o) => sum + daysStalled(o.acceptedAt, now), 0) / stalled.length,
        )
      : 0;

  return (
    <>
      <PageHeader
        hero
        title="Treatment Coordinator"
        description="Recover accepted but incomplete treatment, ranked so the highest impact patient is always at the top."
      />

      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="Recoverable value"
          value={gbp(totalRecoverable)}
          dot="bg-status-amber"
          hint="Outstanding across open plans"
        />
        <StatCard
          label="Open opportunities"
          value={open.length}
          dot="bg-status-blue"
          hint="Plans not yet completed"
        />
        <StatCard
          label="Recovered to date"
          value={gbp(recoveredToDate)}
          dot="bg-status-green"
          hint="Completed plan value"
        />
        <StatCard
          label="Average days stalled"
          value={avgDaysStalled}
          dot="bg-status-red"
          hint="Across stalled plans"
        />
      </div>

      {opportunities.length === 0 ? (
        <EmptyState
          icon={HeartPulse}
          title="No opportunities synced yet"
          description="Run the Dentally sync to pull accepted but incomplete treatment plans into this worklist. This view is mock safe, so it stays empty until real data lands."
        />
      ) : (
        <Worklist opportunities={opportunities} nowIso={now.toISOString()} />
      )}
    </>
  );
}
