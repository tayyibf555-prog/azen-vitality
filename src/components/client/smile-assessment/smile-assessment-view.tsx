import { PageHeader, StatCard } from "@/components/primitives";
import { SmileAssessmentWorkspace } from "./smile-assessment-workspace";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listResponses } from "@/lib/smile-assessment/repository";
import type { AssessmentResponse } from "@/lib/smile-assessment/types";

async function loadResponses(siteIds: string[]): Promise<AssessmentResponse[]> {
  try {
    return await listResponses({ siteIds });
  } catch {
    return [];
  }
}

export async function SmileAssessmentView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Smile Assessment" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const responses = await loadResponses(siteIds);
  const nowIso = new Date().toISOString();

  const high = responses.filter((r) => r.band === "high");
  const medium = responses.filter((r) => r.band === "medium");
  const low = responses.filter((r) => r.band === "low");
  // High scorers that were actually fast-tracked into Speed-to-lead.
  const contacted = high.filter((r) => r.leadId !== null).length;

  return (
    <>
      <PageHeader
        title="Smile Assessment"
        description="An embeddable quiz that scores each enquiry on intent and fit, fast-tracking high scorers to contact and recording the rest for nurture."
      />

      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard label="Total" value={responses.length} dot="bg-status-blue" hint="Quiz submissions" />
        <StatCard
          label="High intent"
          value={high.length}
          dot="bg-status-green"
          hint={`${contacted} fast-tracked to contact`}
        />
        <StatCard label="Medium" value={medium.length} dot="bg-status-amber" hint="Worth a follow-up" />
        <StatCard label="Low" value={low.length} dot="bg-line-strong" hint="Nurture for later" />
      </div>

      <SmileAssessmentWorkspace clientSlug={clientSlug} responses={responses} nowIso={nowIso} />
    </>
  );
}
