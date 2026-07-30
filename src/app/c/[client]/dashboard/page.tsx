import { PageHeader } from "@/components/primitives";
import { PracticeDashboard } from "@/components/client/dashboard/practice-dashboard";
import { readPracticeDashboard } from "@/lib/dashboard/read";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteSelection, ALL_SITES } from "@/lib/site-view";

export const dynamic = "force-dynamic";

// The practice manager's dashboard. It reads EVERY site the client runs, because
// the whole point of the strip's all-sites toggle is comparing them without
// having to switch site first. The top bar's current selection only decides what
// the toggle opens on, so the two controls never disagree on arrival.

export default async function PracticeDashboardPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Dashboard" description="This client could not be found." />;
  }

  const selection = await getViewSiteSelection(client.id);
  const view = await readPracticeDashboard({ clientId: client.id, now: new Date() });

  // No PageHeader here on purpose. The dashboard is a dense band of figures read
  // between phone calls, and a hero title plus a subtitle repeating what the
  // panel headings already say cost about ninety pixels of the fold. The
  // component renders its own compact title line instead.
  return (
    <PracticeDashboard
      view={view}
      clientSlug={clientSlug}
      initialSiteId={selection === ALL_SITES ? null : selection}
    />
  );
}
