import { AgentView } from "@/components/client/agent/agent-view";

export const dynamic = "force-dynamic";

export default async function BookingAgentPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <AgentView clientSlug={clientSlug} channel="sms" />;
}
