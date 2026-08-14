import { FileText } from "lucide-react";
import { PageHeader, StatCard, EmptyState, SectionCard } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { getViewSiteIds, getViewSiteSelection, ALL_SITES } from "@/lib/site-view";
import { buildSnapshot } from "@/lib/reports/snapshot";
import { presetWindow } from "@/lib/reports/report-window";
import { readNhsBandReport, readPaymentAllocation, readNhsClinicalReport } from "@/lib/reports/flagship-read";
import { FlagshipReports, PAY_DEFAULT_PRESET } from "./flagship-reports";
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

  const [siteIds, selection] = await Promise.all([
    getViewSiteIds(client.id),
    getViewSiteSelection(client.id),
  ]);
  const now = new Date();
  const defaultWindow = presetWindow("this_month", now);
  // The allocation report costs ONE live invoice read per invoice settled in the
  // period (Dentally publishes invoice lines on the per-invoice route only), which
  // on live measured ~1,900 for 60 days. That is fine inside the report's own API
  // route, which allows 300s — it is not fine inside a PAGE render on the 31st of
  // a month. So the page opens on the cheapest honest window and every longer
  // period is fetched through the route. PAY_DEFAULT_PRESET keeps the component's
  // selected tab in step with what was actually read here.
  const payWindow = presetWindow(PAY_DEFAULT_PRESET, now);
  const paySiteId = selection === ALL_SITES ? null : selection;

  const [week, month, nhs, pay, clinical] = await Promise.all([
    buildSnapshot("week", siteIds),
    buildSnapshot("month", siteIds),
    readNhsBandReport({ siteIds, window: defaultWindow, now }),
    readPaymentAllocation({ siteIds, window: payWindow, siteId: paySiteId, now }),
    // Report C opens on the same this-month window as Report A. Its per-clinician
    // fan-out is cheap (one probe + a page or two per active clinician), so unlike
    // the allocation report it can run inside the page render.
    readNhsClinicalReport({ siteIds, window: defaultWindow, now }),
  ]);

  const hasActivity = month.enquiries > 0;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Flagship NHS activity and payment-allocation reports, plus AI weekly and monthly business reviews written from your live enquiry and booking activity."
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

      {/* The two flagship reports: the concrete proof this platform does what
          Dentally will not. NHS activity broken down by clinician AND band, and an
          honest payment-allocation view that states what it does not yet confirm. */}
      <SectionCard
        title="Practice reports"
        description="The reports Dentally will not give you in one place: NHS activity split by clinician and band, and payment allocation with every unconfirmed condition named."
      >
        <FlagshipReports clientSlug={clientSlug} nhs={nhs} pay={pay} clinical={clinical} />
      </SectionCard>

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
