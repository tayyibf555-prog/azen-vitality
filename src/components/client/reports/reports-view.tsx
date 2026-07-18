import { FileText } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { buildSnapshot } from "@/lib/reports/snapshot";
import { ReportsWorkspace } from "./reports-workspace";
import { UsageSection } from "./usage-section";

// Reports section: AI-generated weekly and monthly business reviews for the
// practice owner. The reviews are written from the practice's REAL enquiry and
// booking activity: nothing is fabricated. Until enough live activity has accrued,
// the page shows an honest awaiting state and the AI review stays locked; once
// enquiries are coming through, the real figures appear and the review unlocks.
export async function ReportsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Reports" description="This client could not be found." />;
  }

  const siteIds = await getViewSiteIds(client.id);
  const [week, month] = await Promise.all([
    buildSnapshot("week", siteIds),
    buildSnapshot("month", siteIds),
  ]);

  const hasActivity = month.enquiries > 0;

  return (
    <>
      <PageHeader
        title="Reports"
        description="AI weekly and monthly business reviews written from your live enquiry and booking activity, with concrete recommendations."
        stats={
          hasActivity ? (
            <>
              <StatCard label="Enquiries (30 days)" value={month.enquiries} dot="bg-status-blue" />
              <StatCard label="Consultations booked" value={month.booked} dot="bg-status-green" />
              <StatCard
                label="Enquiry to booked"
                value={`${Math.round(month.enquiryToBookedRate * 100)}%`}
                dot="bg-status-blue"
              />
            </>
          ) : undefined
        }
      />

      {hasActivity ? (
        <ReportsWorkspace clientSlug={clientSlug} snapshots={{ week, month }} />
      ) : (
        <EmptyState
          icon={FileText}
          title="Your first report unlocks with live activity"
          description="Reports are written from your live enquiry and booking data. As enquiries start coming through, the figures appear here and the AI weekly and monthly reviews unlock. Nothing is shown until it is real."
        />
      )}

      {/* Owner-only product usage. Independent of enquiry activity, so it renders
          whether or not the AI report has unlocked. Reports is OWNER_ROLES-gated, so
          this is never visible to a coordinator. */}
      <UsageSection clientId={client.id} />
    </>
  );
}
