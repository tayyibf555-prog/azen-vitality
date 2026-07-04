import { SystemsView } from "@/components/client/systems/systems-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function ControlsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("controls");
  return <SystemsView clientSlug={clientSlug} />;
}
