import { NoshowView } from "@/components/client/noshow/noshow-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function NoshowPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("no-show-defence");
  return <NoshowView clientSlug={clientSlug} />;
}
