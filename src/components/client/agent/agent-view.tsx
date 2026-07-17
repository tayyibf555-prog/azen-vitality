import { PageHeader, StatCard } from "@/components/primitives";
import {
  getAgentAnalytics,
  listDashboardConversations,
  getAgentSettings,
  type AgentAnalytics,
  type DashboardConversation,
} from "@/lib/agent/repository";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { AgentControls } from "./agent-controls";

async function load(siteIds: string[], channel?: "sms" | "whatsapp"): Promise<{
  analytics: AgentAnalytics;
  conversations: DashboardConversation[];
  allEnabled: boolean;
}> {
  try {
    const [analytics, conversations, settings] = await Promise.all([
      getAgentAnalytics(siteIds, channel),
      listDashboardConversations(siteIds, channel),
      getAgentSettings(siteIds),
    ]);
    return { analytics, conversations, allEnabled: siteIds.every((id) => settings[id]) };
  } catch {
    return {
      analytics: { total: 0, active: 0, booked: 0, needsHuman: 0 },
      conversations: [],
      allEnabled: true,
    };
  }
}

export async function AgentView({ clientSlug, channel }: { clientSlug: string; channel?: "sms" | "whatsapp" }) {
  const client = getClient(clientSlug);
  const isWhatsapp = channel === "whatsapp";

  if (!client) {
    return <PageHeader title={isWhatsapp ? "WhatsApp agent" : "Booking agent"} description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const { analytics, conversations, allEnabled } = await load(siteIds, channel);

  return (
    <>
      <PageHeader
        title={isWhatsapp ? "WhatsApp Agent" : "AI Booking Agent"}
        description={
          isWhatsapp
            ? "Two way WhatsApp agent that books, reschedules and cancels for known patients, and hands clinical questions to your team. Live across every site."
            : "Two way SMS agent that books, reschedules and cancels for known patients, and hands clinical questions to your team. Live across every site."
        }
      />

      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="Status"
          value={allEnabled ? "Running" : "Paused"}
          dot={allEnabled ? "bg-status-green" : "bg-status-amber"}
          hint={allEnabled ? "Answering replies" : "Routing to your team"}
        />
        <StatCard label="Conversations" value={analytics.total} dot="bg-status-blue" hint="Patients texted" />
        <StatCard label="Booked" value={analytics.booked} dot="bg-status-green" hint="Appointments made" />
        <StatCard
          label="Needs a human"
          value={analytics.needsHuman}
          dot="bg-status-red"
          hint="Waiting for your team"
        />
      </div>

      <AgentControls
        siteIds={siteIds}
        initialEnabled={allEnabled}
        conversations={conversations}
        nowIso={new Date().toISOString()}
      />
    </>
  );
}
