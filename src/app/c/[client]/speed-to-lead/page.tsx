import { SpeedToLeadView } from "@/components/client/speed-to-lead/speed-to-lead-view";

export const dynamic = "force-dynamic";

export default async function SpeedToLeadPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <SpeedToLeadView clientSlug={clientSlug} />;
}
