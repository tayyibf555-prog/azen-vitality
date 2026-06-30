import { RoiView } from "@/components/client/roi/roi-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function RoiPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("roi");
  return <RoiView clientSlug={clientSlug} />;
}
