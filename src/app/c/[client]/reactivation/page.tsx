import { ReactivationView } from "@/components/client/reactivation/reactivation-view";

export const dynamic = "force-dynamic";

export default async function ReactivationPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <ReactivationView clientSlug={clientSlug} />;
}
