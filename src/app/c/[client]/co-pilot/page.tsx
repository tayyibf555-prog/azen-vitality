import { CopilotView } from "@/components/client/copilot/copilot-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function CopilotPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("co-pilot");
  return <CopilotView clientSlug={clientSlug} />;
}
