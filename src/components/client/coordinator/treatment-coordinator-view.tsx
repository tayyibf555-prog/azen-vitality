import { HeartPulse } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { CoordinatorTabs } from "@/components/client/coordinator/coordinator-tabs";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listOpportunities } from "@/lib/coordinator/repository";
import { closerQueueCounts, listAwaitingApproval } from "@/lib/closer/repository";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";
import type { CloserDraftView } from "@/lib/closer/types";
import { gbp } from "@/lib/utils";

const DAY = 86_400_000;

const NO_COUNTS = { awaiting: 0, sent: 0, replies: 0 };

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

/**
 * The closer's drafts, joined to the opportunities already loaded for the worklist.
 *
 * Joined in memory rather than in SQL because the opportunities are ALREADY here —
 * the worklist needs every one of them — so a second query would fetch rows this
 * function is holding. A draft whose opportunity is not in that map is DROPPED
 * rather than rendered with blanks: without the patient's name, the treatment and
 * the figure there is nothing for a human to judge, and an approval made without
 * them would be a rubber stamp. It cannot happen in practice (both reads are
 * scoped to the same site selection, and the touch's opportunity_id is a foreign
 * key) which is precisely why the impossible case must not render a half-empty
 * card somebody clicks Approve on.
 */
async function loadCloserQueue(
  siteIds: string[],
  opportunities: TreatmentOpportunity[],
): Promise<{ drafts: CloserDraftView[]; counts: typeof NO_COUNTS }> {
  try {
    const [touches, counts] = await Promise.all([
      listAwaitingApproval(siteIds),
      closerQueueCounts(siteIds),
    ]);
    const byId = new Map(opportunities.map((o) => [o.id, o]));
    const drafts: CloserDraftView[] = [];
    for (const t of touches) {
      const o = byId.get(t.opportunityId);
      if (!o) continue;
      drafts.push({
        touchId: t.id,
        opportunityId: t.opportunityId,
        patientName: o.patientName,
        treatment: o.treatment,
        amountOutstanding: o.amountOutstanding,
        step: t.step,
        channel: t.channel,
        body: t.body,
        createdAt: t.createdAt,
      });
    }
    return { drafts, counts };
  } catch {
    // The closer tables may not exist in this environment (migration 0085 is a
    // file, not yet applied everywhere). An empty queue, never a broken page.
    return { drafts: [], counts: NO_COUNTS };
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
  const { drafts, counts } = await loadCloserQueue(siteIds, opportunities);

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
        title="Treatment Coordinator"
        description="Recover accepted but incomplete treatment, ranked so the highest impact patient is always at the top."
        stats={
          <>
            <StatCard
              label="Recoverable value"
              value={gbp(totalRecoverable)}
              dot="bg-status-amber"
            />
            <StatCard
              label="Open opportunities"
              value={open.length}
              dot="bg-status-blue"
            />
            <StatCard
              label="Recovered to date"
              value={gbp(recoveredToDate)}
              dot="bg-status-green"
            />
            <StatCard
              label="Average days stalled"
              value={avgDaysStalled}
              dot="bg-status-red"
            />
          </>
        }
      />

      {opportunities.length === 0 ? (
        <EmptyState
          icon={HeartPulse}
          title="No opportunities synced yet"
          description="Run the Dentally sync to pull accepted but incomplete treatment plans into this worklist. This view is mock safe, so it stays empty until real data lands."
        />
      ) : (
        <CoordinatorTabs
          opportunities={opportunities}
          drafts={drafts}
          counts={counts}
          nowIso={now.toISOString()}
        />
      )}
    </>
  );
}
