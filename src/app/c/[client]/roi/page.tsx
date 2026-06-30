import { RoiView } from "@/components/client/roi/roi-view";

export const dynamic = "force-dynamic";

export default async function RoiPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <RoiView clientSlug={clientSlug} />;
}
