import { NoshowView } from "@/components/client/noshow/noshow-view";

export const dynamic = "force-dynamic";

export default async function NoshowPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <NoshowView clientSlug={clientSlug} />;
}
