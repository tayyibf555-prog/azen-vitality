import { NotificationsView } from "@/components/client/notifications/notifications-view";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  return <NotificationsView clientSlug={client} />;
}
