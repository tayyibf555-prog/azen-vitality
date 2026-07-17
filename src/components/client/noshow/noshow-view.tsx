import { PageHeader, StatCard } from "@/components/primitives";
import { NoshowTabs } from "./noshow-tabs";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listTargets, listWaitlist } from "@/lib/noshow/repository";
import type { NoshowTarget, WaitlistEntry } from "@/lib/noshow/types";

async function loadData(siteIds: string[]): Promise<{
  targets: NoshowTarget[];
  waitlist: WaitlistEntry[];
}> {
  try {
    const [targets, waitlist] = await Promise.all([
      listTargets({ siteIds }),
      listWaitlist({ siteIds, statuses: ["waiting", "offered", "booked"] }),
    ]);
    return { targets, waitlist };
  } catch {
    return { targets: [], waitlist: [] };
  }
}

export async function NoshowView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="No-show defence" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const { targets, waitlist } = await loadData(siteIds);
  // No-show is forward-looking: anchor to the real present, not the mock history NOW.
  const nowIso = new Date().toISOString();

  const upcoming = targets.filter((t) => t.status === "scheduled");
  const confirmed = targets.filter((t) => t.status === "confirmed");
  const atRisk = upcoming.filter((t) => t.riskBand === "high");
  const waiting = waitlist.filter((w) => w.status === "waiting");

  return (
    <>
      <PageHeader
        title="No-show defence"
        description="Confirms appointments, scores no-show risk, and auto-fills cancellations from the waitlist."
        stats={
          <>
            <StatCard label="Upcoming" value={upcoming.length} dot="bg-status-blue" />
            <StatCard label="Confirmed" value={confirmed.length} dot="bg-status-green" />
            <StatCard label="High risk" value={atRisk.length} dot="bg-status-red" />
            <StatCard label="Waitlist" value={waiting.length} dot="bg-status-amber" />
          </>
        }
      />

      <NoshowTabs targets={targets} waitlist={waitlist} nowIso={nowIso} />
    </>
  );
}
