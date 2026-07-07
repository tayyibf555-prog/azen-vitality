import { Zap, Inbox, Send, CheckCircle2, Timer } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "./worklist";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listLeads } from "@/lib/speed-to-lead/repository";
import { firstResponseSeconds, toDashboardLead } from "@/lib/speed-to-lead/types";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";

async function loadLeads(siteIds: string[]): Promise<SpeedToLeadLead[]> {
  try {
    return await listLeads({ siteIds });
  } catch {
    return [];
  }
}

/** Median first-response across contacted leads, formatted, or a dash. */
function medianResponseLabel(leads: SpeedToLeadLead[]): string {
  const secs = leads
    .map((l) => firstResponseSeconds(l))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (secs.length === 0) return "—";
  const mid = Math.floor(secs.length / 2);
  const median = secs.length % 2 === 0 ? Math.round((secs[mid - 1] + secs[mid]) / 2) : secs[mid];
  if (median < 60) return `${median}s`;
  const mins = Math.floor(median / 60);
  const rem = median % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

export async function SpeedToLeadView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Speed-to-lead" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const leads = await loadLeads(siteIds);

  const newLeads = leads.filter((l) => l.stage === "new");
  const contacted = leads.filter((l) => l.stage === "contacted" || l.stage === "qualifying");
  const booked = leads.filter((l) => l.stage === "booked");

  return (
    <>
      <PageHeader
        title="Speed-to-lead"
        description="Contacts every new enquiry within seconds across SMS, email and WhatsApp, then threads the reply straight to the booking agent."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="New" value={newLeads.length} icon={Inbox} hint="Awaiting first contact" />
        <StatCard label="Contacted" value={contacted.length} icon={Send} hint="First reply sent, in conversation" />
        <StatCard label="Booked" value={booked.length} icon={CheckCircle2} hint="Enquiry turned into a booking" />
        <StatCard label="Median response" value={medianResponseLabel(leads)} icon={Timer} hint="Enquiry to first contact" />
      </div>

      {leads.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No enquiries yet"
          description="New enquiries POST to the public intake endpoint and appear here the instant they land, already contacted. This view is mock safe, so it stays empty until a lead arrives."
        />
      ) : (
        <Worklist leads={leads.map(toDashboardLead)} nowIso={new Date().toISOString()} />
      )}
    </>
  );
}
