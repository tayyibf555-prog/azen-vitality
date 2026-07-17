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
      />

      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="High priority"
          value={highCount}
          dot="bg-status-red"
          hint="Needs action now"
        />
        <StatCard label="Total" value={items.length} dot="bg-status-blue" hint="Across all sources" />
        <StatCard
          label="Compliance"
          value={byType.compliance ?? 0}
          dot="bg-status-blue"
          hint="Audits, policies, training"
        />
        <StatCard
          label="No-show risk"
          value={byType.no_show ?? 0}
          dot="bg-status-amber"
          hint="High-risk appointments"
        />
        {(byType.lead ?? 0) > 0 ? (
          <StatCard
            label="New enquiries"
            value={byType.lead ?? 0}
            dot="bg-status-green"
            hint="High-intent, to contact"
          />
        ) : null}
        {(byType.onboarding ?? 0) > 0 ? (
          <StatCard
            label="Onboarding"
            value={byType.onboarding ?? 0}
            dot="bg-status-amber"
            hint="Submissions to review"
          />
        ) : null}
      </div>

      <NotificationsList items={items} />
    </>
  );
}
