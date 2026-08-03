import { RecallView } from "@/components/client/recall/recall-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function RecallPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("recall");
  return <RecallView clientSlug={clientSlug} />;
}
