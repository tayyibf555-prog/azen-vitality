import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { RotaWorkspace } from "./rota-workspace";

// Staff Rota section (owner/manager only).
//
// Owners and managers set the staffing rules once. From each site's opening hours
// and each staff member's availability, the rota is generated automatically, and
// every staff member is texted their upcoming shifts. Messages are in test mode
// until go-live.
//
// The headline numbers depend on live shift + staff data, so the StatCards live in
// the client workspace (which fetches them) rather than here, keeping them in sync
// with the "This week" tab. The generate route is all-sites (no read route scopes
// it), so we resolve the view scope here and pass it down; the workspace filters
// the fetched shifts to the selected site(s) and phrases its copy accordingly.
export async function RotaView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Staff Rota" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);

  return (
    <>
      <PageHeader
        title="Staff Rota"
        description="Set your staffing rules and the rota is generated automatically from each site's opening hours and staff availability, then every staff member is texted their upcoming shifts. Messages are in test mode until go-live."
      />

      <RotaWorkspace
        clientSlug={clientSlug}
        siteIds={scope.siteIds}
        isAllSites={scope.isAllSites}
        siteName={scope.siteName}
      />
    </>
  );
}
