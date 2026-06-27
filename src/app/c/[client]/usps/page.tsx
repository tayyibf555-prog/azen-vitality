import { UspsView } from "@/components/client/usps/usps-view";

export const dynamic = "force-dynamic";

export default async function UspsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <UspsView clientSlug={clientSlug} />;
}
