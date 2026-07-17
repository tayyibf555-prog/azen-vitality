import { PageHeader } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { listSitePractitioners, type PractitionerRecord } from "@/lib/dentally/read";
import { isSystemEnabled } from "@/lib/systems/repository";
import { CampaignsWorkspace, type SiteOption } from "./campaigns-workspace";

export const dynamic = "force-dynamic";

/**
 * Server shell for the Campaigns screen. It resolves the per-site practitioner lists
 * (a Dentally read, best-effort) and the current Segment-outreach switch state, then
 * hands them to the interactive workspace. The switch state drives the Launch banner;
 * the practitioner lists populate the "see this clinician" picker per selected site.
 */
export async function OutreachCampaignsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Campaigns" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);
  const sites = getSites(client.id);

  // Practitioners per site (best-effort; a failed read leaves an empty picker, not a
  // broken page). Runs concurrently across the handful of sites.
  const practitionerEntries = await Promise.all(
    sites.map(async (s): Promise<[string, PractitionerRecord[]]> => [s.id, await safePractitioners(s.id)]),
  );
  const practitionersBySite: Record<string, PractitionerRecord[]> = Object.fromEntries(practitionerEntries);

  const outreachEnabled = await isSystemEnabled(client.id, "outreach");

  const siteOptions: SiteOption[] = sites.map((s) => ({ id: s.id, name: s.name }));
  // Default the form's site to the one in view (a single selected site), else the first.
  const defaultSiteId = !scope.isAllSites && scope.siteIds.length === 1 ? scope.siteIds[0] : sites[0]?.id ?? "";

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Build a list of patients from your existing base, preview exactly who matches, then invite them back with a warm text. Every send honours consent, opt-outs and a daily cap."
      />
      <CampaignsWorkspace
        clientSlug={clientSlug}
        sites={siteOptions}
        practitionersBySite={practitionersBySite}
        defaultSiteId={defaultSiteId}
        outreachEnabled={outreachEnabled}
        controlsHref={`/c/${clientSlug}/controls`}
      />
    </>
  );
}

async function safePractitioners(siteId: string): Promise<PractitionerRecord[]> {
  try {
    return await listSitePractitioners(siteId);
  } catch {
    return [];
  }
}
