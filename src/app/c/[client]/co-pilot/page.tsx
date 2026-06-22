import { CopilotView } from "@/components/client/copilot/copilot-view";

export const dynamic = "force-dynamic";

export default async function CopilotPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <CopilotView clientSlug={clientSlug} />;
}
