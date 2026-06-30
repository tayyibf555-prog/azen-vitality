import { UspsView } from "@/components/client/usps/usps-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function UspsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("usps");
  return <UspsView clientSlug={clientSlug} />;
}
