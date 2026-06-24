import { PageHeader, StatCard } from "@/components/primitives";
import { Bot, MessagesSquare, CalendarCheck, UserCog } from "lucide-react";
import {
  getAgentAnalytics,
  listDashboardConversations,
  getAgentSettings,
  type AgentAnalytics,
  type DashboardConversation,
} from "@/lib/agent/repository";
import { getClient, getSites, NOW } from "@/lib/mock/clients";
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

  const siteIds = getSites(client.id).map((s) => s.id);
  const { analytics, conversations, allEnabled } = await load(siteIds, channel);

  return (
    <>
      <PageHeader
        title={isWhatsapp ? "WhatsApp Agent" : "AI Booking Agent"}
        description={
          isWhatsapp
            ? "A two way WhatsApp agent that recognises any patient by their number, answers their messages, and books, reschedules or cancels appointments. It also guides patients on treatments and onboards new ones, and hands clinical questions, complaints and anything it is unsure about to your team. Live across every site."
            : "A two way SMS agent that recognises any patient by their number, answers their replies, and books, reschedules or cancels appointments. It also guides patients on treatments and onboards new ones, and hands clinical questions, complaints and anything it is unsure about to your team. Live across every site."
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Status"
          value={allEnabled ? "Running" : "Paused"}
          icon={Bot}
          hint={allEnabled ? "Answering replies" : "Routing to your team"}
        />
        <StatCard label="Conversations" value={String(analytics.total)} icon={MessagesSquare} hint="Patients texted" />
        <StatCard label="Booked" value={String(analytics.booked)} icon={CalendarCheck} hint="Appointments made" />
        <StatCard
          label="Needs a human"
          value={String(analytics.needsHuman)}
          icon={UserCog}
          hint="Waiting for your team"
        />
      </div>

      <AgentControls
        siteIds={siteIds}
        initialEnabled={allEnabled}
        conversations={conversations}
        nowIso={NOW.toISOString()}
      />
    </>
  );
}
