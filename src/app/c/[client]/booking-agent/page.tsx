import { AgentView } from "@/components/client/agent/agent-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function BookingAgentPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("booking-agent");
  return <AgentView clientSlug={clientSlug} channel="sms" />;
}
