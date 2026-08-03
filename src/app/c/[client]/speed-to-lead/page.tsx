import { SpeedToLeadView } from "@/components/client/speed-to-lead/speed-to-lead-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function SpeedToLeadPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("speed-to-lead");
  return <SpeedToLeadView clientSlug={clientSlug} />;
}
