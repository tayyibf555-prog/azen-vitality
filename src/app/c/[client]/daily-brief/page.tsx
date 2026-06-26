import { DailyBriefView } from "@/components/client/daily-brief/daily-brief-view";

export const dynamic = "force-dynamic";

export default async function DailyBriefPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <DailyBriefView clientSlug={clientSlug} />;
}
