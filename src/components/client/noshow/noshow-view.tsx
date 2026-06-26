import { CalendarClock, ShieldCheck, CheckCircle2, AlertTriangle, Users } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "./worklist";
import { WaitlistPanel } from "./waitlist-panel";
import { getClient, getSites } from "@/lib/mock/clients";
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

  const siteIds = getSites(client.id).map((s) => s.id);
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
        description="Confirms and reminds patients before every appointment, lets them confirm or cancel by reply, scores no-show risk so the team can focus, and auto-fills cancellations from the waitlist."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Upcoming" value={String(upcoming.length)} icon={CalendarClock} hint="Awaiting confirmation" />
        <StatCard label="Confirmed" value={String(confirmed.length)} icon={CheckCircle2} hint="Patient confirmed" />
        <StatCard label="High risk" value={String(atRisk.length)} icon={AlertTriangle} hint="Most likely to no-show" />
        <StatCard label="Waitlist" value={String(waiting.length)} icon={Users} hint="Ready to fill a gap" />
      </div>

      {targets.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No upcoming appointments yet"
          description="Run the no-show sync to pull the upcoming diary from Dentally into this worklist. This view is mock safe, so it stays empty until data lands."
        />
      ) : (
        <Worklist targets={targets} nowIso={nowIso} />
      )}

      <WaitlistPanel entries={waitlist} nowIso={nowIso} />
    </>
  );
}
