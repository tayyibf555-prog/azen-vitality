import { PageHeader } from "@/components/primitives";
import { PracticeDashboard } from "@/components/client/dashboard/practice-dashboard";
import { TaskQueueBoard } from "@/components/client/task-queue/task-queue-board";
import { readPracticeDashboard } from "@/lib/dashboard/read";
import { requireIndexAccess } from "@/lib/auth/page-guard";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteSelection, ALL_SITES } from "@/lib/site-view";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// OVERVIEW. This is what "Home" in the sidebar opens, and it IS the practice
// dashboard, arranged as Dentally arranges its own: the takings strip, then the
// band of panels, then the day's filtered appointment list.
//
// It used to be a different page entirely ("One Front Door": a greeting, day
// numerals, a diary rail, a mini month and a numbers band). That page was built
// before the decision to match Dentally, and it left the practice dashboard
// stranded at /dashboard with NO nav entry, reachable only by typing the URL.
// The practice manager comparing us against Dentally was therefore comparing the
// wrong screen, which is the sort of defect that reads as "your product does not
// have that" when in fact it did.
//
// One thing survives from that page and sits UNDERNEATH the dashboard rather
// than replacing any of it: the task queue. Dentally puts a filtered appointment
// list below its stats band, which the dashboard already reproduces; "Next
// actions" then follows as the platform's own addition, in the position where a
// manager has finished reading the day and wants to know what to do about it.
//
// ---------------------------------------------------------------------------
// NOT EVERY ROLE READS THIS PAGE (campaign 6, decision 15).
// ---------------------------------------------------------------------------
// Everything above — the takings strip, outstanding accounts, invoiced totals,
// UDA, and a day list carrying patient names — is exactly what a `client_staff`
// login must never see. That role holds "" in its allow-list only so the shell
// admits it and no redirect loop forms; `requireIndexAccess` is what forwards it
// to its own surface, and it runs BEFORE `readPracticeDashboard`, so the money is
// not so much as fetched for somebody who may not see it.
// ---------------------------------------------------------------------------

export default async function ClientHomePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  // FIRST, and before any read: a role that may not have this page is forwarded.
  await requireIndexAccess(clientSlug);
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Overview" description="This client could not be found." />;
  }

  // Reads EVERY site the client runs, because the point of the strip's all-sites
  // toggle is comparing them without switching site first. The top bar's current
  // selection only decides what the toggle opens on, so the two never disagree.
  const selection = await getViewSiteSelection(client.id);
  const view = await readPracticeDashboard({ clientId: client.id, now: new Date() });

  // No PageHeader on purpose: a hero title plus a subtitle repeating what the
  // panel headings already say costs about ninety pixels of the fold on a screen
  // read between phone calls. The dashboard renders its own compact title line.
  return (
    <>
      <PracticeDashboard
        view={view}
        clientSlug={clientSlug}
        initialSiteId={selection === ALL_SITES ? null : selection}
      />
      <TaskQueueBoard
        plain
        clientSlug={clientSlug}
        maxRows={8}
        title="Next actions"
        description="The highest-priority work across every module. Finish one and the next slides in."
      />
    </>
  );
}
