import { InboxView } from "@/components/client/inbox/inbox-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function ConversationsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("conversations");
  return <InboxView clientSlug={clientSlug} />;
}
