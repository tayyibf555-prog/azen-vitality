import { SectionCard, StatCard } from "@/components/primitives";
import { Bot, MessagesSquare, CalendarCheck, UserCog } from "lucide-react";
import {
  getAgentAnalytics,
  listDashboardConversations,
  getAgentSettings,
  type AgentAnalytics,
  type DashboardConversation,
} from "@/lib/agent/repository";
import { NOW } from "@/lib/mock/clients";
import { AgentControls } from "./agent-controls";

async function load(siteIds: string[]): Promise<{
  analytics: AgentAnalytics;
  conversations: DashboardConversation[];
  allEnabled: boolean;
}> {
  try {
    const [analytics, conversations, settings] = await Promise.all([
      getAgentAnalytics(siteIds),
      listDashboardConversations(siteIds),
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

export async function AgentSection({ siteIds }: { siteIds: string[] }) {
  const { analytics, conversations, allEnabled } = await load(siteIds);

  return (
    <SectionCard
      title="AI Booking Agent"
      description="Answers patient replies, books them in, and hands tricky cases to your team. Live across every site."
    >
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

      <div className="mt-5">
        <AgentControls
          siteIds={siteIds}
          initialEnabled={allEnabled}
          conversations={conversations}
          nowIso={NOW.toISOString()}
        />
      </div>
    </SectionCard>
  );
}
