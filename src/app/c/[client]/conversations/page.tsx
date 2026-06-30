import { InboxView } from "@/components/client/inbox/inbox-view";

export const dynamic = "force-dynamic";

export default async function ConversationsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <InboxView clientSlug={clientSlug} />;
}
