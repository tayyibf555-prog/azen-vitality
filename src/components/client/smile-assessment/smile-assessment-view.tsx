import { Sparkles, Flame, Gauge, Leaf } from "lucide-react";
import { PageHeader, StatCard } from "@/components/primitives";
import { SmileAssessmentWorkspace } from "./smile-assessment-workspace";
import { getClient, getSites } from "@/lib/mock/clients";
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

  const siteIds = getSites(client.id).map((s) => s.id);
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

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total" value={responses.length} icon={Sparkles} hint="Quiz submissions" />
        <StatCard
          label="High intent"
          value={high.length}
          icon={Flame}
          hint={`${contacted} fast-tracked to contact`}
        />
        <StatCard label="Medium" value={medium.length} icon={Gauge} hint="Worth a follow-up" />
        <StatCard label="Low" value={low.length} icon={Leaf} hint="Nurture for later" />
      </div>

      <SmileAssessmentWorkspace clientSlug={clientSlug} responses={responses} nowIso={nowIso} />
    </>
  );
}
