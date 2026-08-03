import { NotificationsView } from "@/components/client/notifications/notifications-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  await requireModuleAccess("notifications");
  return <NotificationsView clientSlug={client} />;
}
