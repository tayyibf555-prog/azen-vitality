import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listThreads } from "@/lib/inbox/repository";
import type { Thread } from "@/lib/inbox/types";
import { InboxWorkspace } from "./inbox-workspace";

async function loadThreads(siteIds: string[]): Promise<Thread[]> {
  try {
    return await listThreads(siteIds);
  } catch {
    return [];
  }
}

// The unified Conversations inbox: every patient conversation across SMS,
// WhatsApp, after-hours and the lifecycle agents, grouped per contact, with a
// human takeover reply box. Read-only aggregation over the existing stores; no
// new schema. Server component resolves the client's sites, loads the threads
// and hands them to the interactive workspace.
export async function InboxView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Conversations" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const threads = await loadThreads(siteIds);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Conversations"
        description="Every patient conversation across SMS, WhatsApp, after-hours and the lifecycle agents in one place, with the ability to take over and reply yourself. Messages are in test mode until go-live."
      />
      <InboxWorkspace clientSlug={client.slug} initialThreads={threads} />
    </div>
  );
}
