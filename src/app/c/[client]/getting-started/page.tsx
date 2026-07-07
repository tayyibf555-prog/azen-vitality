import { GettingStartedView } from "@/components/client/getting-started/getting-started-view";

export const dynamic = "force-dynamic";

export default async function GettingStartedPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <GettingStartedView clientSlug={clientSlug} />;
}
