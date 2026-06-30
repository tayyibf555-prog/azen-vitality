import { Bell, ShieldAlert, ShieldCheck, CalendarX, UserPlus, Sparkles } from "lucide-react";
import { PageHeader, StatCard } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
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

  const siteIds = getSites(client.id).map((s) => s.id);

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
        description="The alerts that need attention now, pulled together from compliance, no-shows, new onboarding submissions and new enquiries. This is mock until the live sources connect."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="High priority"
          value={String(highCount)}
          icon={ShieldAlert}
          hint="Needs action now"
        />
        <StatCard label="Total" value={String(items.length)} icon={Bell} hint="Across all sources" />
        <StatCard
          label="Compliance"
          value={String(byType.compliance ?? 0)}
          icon={ShieldCheck}
          hint="Audits, policies, training"
        />
        <StatCard
          label="No-show risk"
          value={String(byType.no_show ?? 0)}
          icon={CalendarX}
          hint="High-risk appointments"
        />
      </div>

      {(byType.lead ?? 0) > 0 || (byType.onboarding ?? 0) > 0 ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="New enquiries"
            value={String(byType.lead ?? 0)}
            icon={Sparkles}
            hint="High-intent, to contact"
          />
          <StatCard
            label="Onboarding"
            value={String(byType.onboarding ?? 0)}
            icon={UserPlus}
            hint="Submissions to review"
          />
        </div>
      ) : null}

      <NotificationsList items={items} />
    </>
  );
}
