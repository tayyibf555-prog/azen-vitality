import { PageHeader } from "@/components/primitives";
import { PracticeDashboard } from "@/components/client/dashboard/practice-dashboard";
import { OperatingSystemBand } from "@/components/client/dashboard/os-band";
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
  //
  // WIDTH. data-wide drops the shell's max-w-[1400px] cap, because this dashboard
  // is an instrument and a 1920 reception monitor was throwing 388px of it away -
  // the band froze at four equal columns and floated in white space, which is the
  // owner's own complaint against it and the thing Dentally does not do.
  //
  // The marker is read by a :has() on the shell's main column, and :has() matches
  // ANY descendant, so it un-caps that column for EVERY child - not just the one
  // that set it. The task queue underneath is prose and a list of rows; it wants a
  // reading measure, not a viewport. So it gets the cap back, explicitly, in a
  // wrapper of its own. /owner/[client]/page.tsx is the same structure, because
  // the two trees render the same dashboard and must not disagree about its size.
  //
  // THE CAP IS LEFT-ALIGNED, NOT CENTRED, and that is a correction. It carried
  // mx-auto, so on a 1680 screen the dashboard above ran 80px to 1656px while
  // "Next actions" ran 168px to 1568px: the page had TWO left rules, and the
  // second one moved as the window resized. Every heading, figure and row above
  // starts on one vertical line and the worklist started 88px inside it, which
  // reads as a different page pasted underneath rather than as the next section
  // of this one. The measure is what the cap is for and the measure is unchanged;
  // only the leftover width now falls on the right, where there is nothing to
  // line up against, instead of being split either side of the reading rule.
  return (
    <div data-wide className="space-y-4">
      <PracticeDashboard
        view={view}
        clientSlug={clientSlug}
        initialSiteId={selection === ALL_SITES ? null : selection}
      />
      <div className="max-w-[1400px] space-y-4">
        {/* THE PLATFORM'S OWN STATE, between the practice's numbers and the
            practice's worklist. The dashboard above says how the day is going;
            this says what the platform is running while it goes; the worklist
            below says what to do about either.

            IT IS ROLE-FILTERED INSIDE, which is why it is rendered here
            unconditionally. The filter is `canRoleAccessModule` and nothing
            else: a tile is drawn only if the role may open the module that tile
            links to, so a nav ruling reaches this band with no edit of its own.
            The authoritative account of that is the header of
            src/lib/home/os-band.ts, which is pinned to the code by its own test.

            WHAT IT COMES TO ON THIS PAGE, role by role. The names below are the
            band's own tile labels, and `os-band-note.test.ts` beside this file
            re-derives every line from `canRoleAccessModule` on each run, so a
            module widened, narrowed or added turns this paragraph red rather
            than leaving a false contract in the file a later lane opens first:

              [agency_admin, client_owner] all six: Leads, Pre-visit questions,
                Equipment, IT desk, Dentally write-back, Automations.
              [client_coordinator] the practice manager's operational subset:
                Leads, Pre-visit questions, Equipment, IT desk. She may not open
                System controls, so neither of the last two is drawn for her.
              [client_clinician] the two desks: Equipment, IT desk. Ruling
                W2-A/1 (3 Sep 2026) widened both of those modules to every
                clearance and the band followed with no edit of its own.
              [client_staff] nothing at all here — not because the predicate
                refuses it, but because `requireIndexAccess` at the top of this
                page forwards a staff login to My work before this line is
                reached.

            The enumeration that stood here predates W2-A/1 and had stopped
            describing what the newest clearance is actually drawn. */}
        <OperatingSystemBand clientId={client.id} clientSlug={clientSlug} tree="client" />
        <TaskQueueBoard
          plain
          clientSlug={clientSlug}
          maxRows={8}
          title="Next actions"
          description="The highest-priority work across every module. Finish one and the next slides in."
        />
      </div>
    </div>
  );
}
