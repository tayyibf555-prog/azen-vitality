import { TodayView } from "@/components/client/today/today-view";

export const dynamic = "force-dynamic";

export default async function TodayPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <TodayView clientSlug={clientSlug} />;
}
