import { RotaView } from "@/components/client/rota/rota-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function RotaPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("rota");
  return <RotaView clientSlug={clientSlug} />;
}
