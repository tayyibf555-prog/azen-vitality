import { ItDeskView } from "@/components/client/itdesk/it-desk-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function ItDeskPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("it-desk");
  return <ItDeskView clientSlug={clientSlug} />;
}
