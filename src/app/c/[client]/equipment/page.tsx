import { EquipmentView } from "@/components/client/equipment/equipment-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function EquipmentPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("equipment");
  return <EquipmentView clientSlug={clientSlug} />;
}
