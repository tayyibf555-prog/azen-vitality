import { PageHeader, StatCard } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { buildNotifications } from "@/lib/notifications/build";
import { countByType } from "@/lib/notifications/logic";
import type { NotificationItem } from "@/lib/notifications/types";
import { NotificationsList } from "./notifications-list";

// Notifications: the alerts that need attention now, pulled together from
// compliance, no-show risk, new onboarding submissions and new enquiries. Like the
// Daily brief and Task queue, the feed is DERIVED and computed on read — there is
// no event store. This server shell guards the client, builds the feed resiliently
// and frames the page; the list child owns the (read-only + local dismiss) UI.
export async function NotificationsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Notifications" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);

  let items: NotificationItem[] = [];
  try {
    items = await buildNotifications({ clientId: client.id, clientSlug, siteIds });
  } catch {
    items = [];
  }

  const highCount = items.filter((i) => i.urgency === "high").length;
  const byType = countByType(items);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="The alerts that need attention now, pulled from compliance, no-shows, onboarding and new enquiries."
        stats={
          <>
            <StatCard
              label="High priority"
              value={highCount}
              dot="bg-status-red"
            />
            <StatCard label="Total" value={items.length} dot="bg-status-blue" />
            <StatCard
              label="Compliance"
              value={byType.compliance ?? 0}
              dot="bg-status-blue"
            />
            <StatCard
              label="No-show risk"
              value={byType.no_show ?? 0}
              dot="bg-status-amber"
            />
            {(byType.lead ?? 0) > 0 ? (
              <StatCard
                label="New enquiries"
                value={byType.lead ?? 0}
                dot="bg-status-green"
              />
            ) : null}
            {(byType.onboarding ?? 0) > 0 ? (
              <StatCard
                label="Onboarding"
                value={byType.onboarding ?? 0}
                dot="bg-status-amber"
              />
            ) : null}
          </>
        }
      />

      <NotificationsList items={items} />
    </>
  );
}
