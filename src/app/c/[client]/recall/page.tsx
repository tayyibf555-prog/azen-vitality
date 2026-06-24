import { RecallView } from "@/components/client/recall/recall-view";

export const dynamic = "force-dynamic";

export default async function RecallPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <RecallView clientSlug={clientSlug} />;
}
