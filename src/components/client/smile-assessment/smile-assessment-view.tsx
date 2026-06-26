import { Sparkles, Flame, Gauge, Leaf, Zap } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { ResponsesTable } from "./responses-table";
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
        description="An embeddable quiz that qualifies each enquiry on intent and fit only: treatment interest, timeline, funding readiness and location. High scorers are fast-tracked to Speed-to-lead and contacted in moments; medium and low scorers are recorded for nurture. It never judges clinical suitability."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total" value={String(responses.length)} icon={Sparkles} hint="Quiz submissions" />
        <StatCard
          label="High intent"
          value={String(high.length)}
          icon={Flame}
          hint={`${contacted} fast-tracked to contact`}
        />
        <StatCard label="Medium" value={String(medium.length)} icon={Gauge} hint="Worth a follow-up" />
        <StatCard label="Low" value={String(low.length)} icon={Leaf} hint="Nurture for later" />
      </div>

      {responses.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No assessments yet"
          description="Embed the quiz on the practice website and link it to /assess. Submissions POST to the public endpoint and appear here the instant they land, with high scorers already contacted. This view is mock safe, so it stays empty until a submission arrives."
        />
      ) : (
        <ResponsesTable responses={responses} nowIso={nowIso} />
      )}
    </>
  );
}
