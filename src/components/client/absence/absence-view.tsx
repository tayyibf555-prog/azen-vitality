import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { AbsenceWorkspace } from "./absence-workspace";

// Holiday and absence (owner, agency admin and the practice manager).
//
// Staff time off in one place: a request is raised, the manager approves or refuses
// it, and an APPROVED absence is then taken out of the generated rota so nobody is
// rostered on a day they are away. Nobody can approve their own request, and a clash
// with the same person's existing time off is shown beside the row before a decision
// is made.
//
// The figures depend on live data, so the StatCards live inside the client workspace
// (which fetches the list) rather than here, keeping them in step with the list. The
// site scope is resolved here and passed down for the copy.
export async function AbsenceView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Holiday and absence" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);

  return (
    <>
      <PageHeader
        title="Holiday and absence"
        description="Holiday, sickness, training and unpaid leave in one place. Approved absence is taken out of the generated rota, so nobody is rostered on a day they are away."
      />

      <AbsenceWorkspace
        clientSlug={clientSlug}
        isAllSites={scope.isAllSites}
        siteName={scope.siteName}
      />
    </>
  );
}
