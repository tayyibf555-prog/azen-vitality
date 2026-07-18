import { Zap } from "lucide-react";
import { PageHeader, StatCard, EmptyState, Tabs, SectionCard } from "@/components/primitives";
import { Worklist } from "./worklist";
import { ResponsesTable } from "./responses-table";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteIds } from "@/lib/site-view";
import { listLeads } from "@/lib/speed-to-lead/repository";
import { listResponses } from "@/lib/smile-assessment/repository";
import { loadDoNotContactKeys, excludedTargetKey } from "@/lib/patient-status/repository";
import { firstResponseSeconds, toDashboardLead } from "@/lib/speed-to-lead/types";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";
import type { AssessmentResponse } from "@/lib/smile-assessment/types";

async function loadLeads(siteIds: string[]): Promise<SpeedToLeadLead[]> {
  try {
    return await listLeads({ siteIds });
  } catch {
    return [];
  }
}

async function loadResponses(siteIds: string[]): Promise<AssessmentResponse[]> {
  try {
    return await listResponses({ siteIds, limit: 500 });
  } catch {
    return [];
  }
}

/** Median first-response across contacted leads, formatted, or a dash. */
function medianResponseLabel(leads: SpeedToLeadLead[]): string {
  const secs = leads
    .map((l) => firstResponseSeconds(l))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (secs.length === 0) return "—";
  const mid = Math.floor(secs.length / 2);
  const median = secs.length % 2 === 0 ? Math.round((secs[mid - 1] + secs[mid]) / 2) : secs[mid];
  if (median < 60) return `${median}s`;
  const mins = Math.floor(median / 60);
  const rem = median % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

export async function SpeedToLeadView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Leads" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const [leads, responses, dncKeys] = await Promise.all([
    loadLeads(siteIds),
    loadResponses(siteIds),
    loadDoNotContactKeys(siteIds),
  ]);

  // Flag leads whose LINKED patient is marked do_not_contact, using the lead's own
  // patient-id linkage (the same identity path the contact path already uses). Leads
  // with no linked patient id are skipped - no new phone-matching is built for this.
  const doNotContactLeadIds = leads
    .filter((l) => l.dentallyPatientId && dncKeys.has(excludedTargetKey(l.siteId, l.dentallyPatientId)))
    .map((l) => l.id);

  const newLeads = leads.filter((l) => l.stage === "new");
  const contacted = leads.filter((l) => l.stage === "contacted" || l.stage === "qualifying");
  const booked = leads.filter((l) => l.stage === "booked");

  // Qualification buckets. QUALIFIED = everything that earned contact: high-band
  // assessment leads plus direct enquiries (missed calls, website form) that are
  // leads by intent. High-band responses that did NOT become a lead (no reachable
  // contact, or submitted before instant contact was switched on) surface in the
  // Qualified tab too, so nobody qualified is invisible.
  const qualifiedAwaiting = responses.filter((r) => r.band === "high" && !r.leadId);
  const closeTo = responses.filter((r) => r.band === "medium");
  const notQualified = responses.filter((r) => r.band === "low");

  return (
    <>
      <PageHeader
        title="Leads"
        description="Every enquiry in one place, with where it came from. Qualified leads are texted within seconds; close-to-qualified ones are listed for the team to nurture."
        stats={
          <>
            <StatCard label="New" value={newLeads.length} dot="bg-status-amber" />
            <StatCard label="Contacted" value={contacted.length} dot="bg-status-blue" />
            <StatCard label="Booked" value={booked.length} dot="bg-status-green" />
            <StatCard label="Median response" value={medianResponseLabel(leads)} dot="bg-status-blue" />
          </>
        }
      />

      <Tabs
        tabs={[
          {
            key: "qualified",
            label: "Qualified",
            badge: leads.length + qualifiedAwaiting.length,
            content: (
              <div className="space-y-5">
                {leads.length === 0 ? (
                  <EmptyState
                    icon={Zap}
                    title="No qualified leads yet"
                    description="High-scoring Smile Assessments, missed calls and website enquiries land here the instant they arrive, already texted."
                  />
                ) : (
                  <Worklist
                    leads={leads.map(toDashboardLead)}
                    nowIso={new Date().toISOString()}
                    doNotContactLeadIds={doNotContactLeadIds}
                  />
                )}
                {qualifiedAwaiting.length > 0 ? (
                  <SectionCard
                    title="Qualified, awaiting contact"
                    description="High scorers we could not text automatically (no reachable number, or submitted before instant contact was switched on). Worth a manual call today."
                  >
                    <ResponsesTable
                      responses={qualifiedAwaiting}
                      emptyTitle="Nothing waiting"
                      emptyDescription="Every qualified assessment has been contacted."
                    />
                  </SectionCard>
                ) : null}
              </div>
            ),
          },
          {
            key: "close",
            label: "Close to qualified",
            badge: closeTo.length,
            content: (
              <ResponsesTable
                responses={closeTo}
                emptyTitle="No near-miss assessments"
                emptyDescription="Medium scorers from the Smile Assessment appear here: interested, but not quite ready. A friendly follow-up often tips them over."
              />
            ),
          },
          {
            key: "not",
            label: "Not qualified",
            badge: notQualified.length,
            content: (
              <ResponsesTable
                responses={notQualified}
                emptyTitle="No low scorers"
                emptyDescription="Low-scoring assessments are recorded here for completeness. No automated contact is sent to them."
              />
            ),
          },
        ]}
      />
    </>
  );
}
