import { MetaAdsView } from "@/components/client/meta-ads/meta-ads-view";

export const dynamic = "force-dynamic";

export default async function MetaAdsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <MetaAdsView clientSlug={clientSlug} />;
}
