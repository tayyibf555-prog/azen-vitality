import { DailyBriefView } from "@/components/client/daily-brief/daily-brief-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function DailyBriefPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("daily-brief");
  return <DailyBriefView clientSlug={clientSlug} />;
}
