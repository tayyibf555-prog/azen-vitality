import { PageHeader, StatCard, SampleNote } from "@/components/primitives";
import { getClient, getSites, getSiteMetrics } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { ROI_SUMMARY, scaleRoiSummary } from "@/lib/roi/mock";
import { money, count } from "./format";
import { AcquisitionFunnel } from "./acquisition-funnel";
import { ChannelBreakdown } from "./channel-breakdown";
import { GrowthTrend } from "./growth-trend";

// ROI (growth) section: how patient-acquisition spend turns into leads, booked
// patients and treatment revenue across every channel, with cost per new patient
// and return on spend. Scoped to the selected site(s) by proportional scaling of
// the practice-wide mock (the site's share of client recovered revenue), so "All
// sites" shows the full figures and a single site shows its share. The data is
// mock until the live sources (Meta for spend and leads, Dentally for bookings
// and revenue) connect.
export async function RoiView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="ROI" description="This client could not be found." />;
  }

  // The selected site(s)' share of the client's total recovered revenue. When
  // all sites are chosen this is 1 and the figures are unchanged.
  const siteIds = await getViewSiteIds(client.id);
  const allSiteIds = getSites(client.id).map((site) => site.id);
  const scopedRevenue = getSiteMetrics(siteIds).reduce((total, m) => total + m.recoveredRevenue, 0);
  const clientTotalRevenue = getSiteMetrics(allSiteIds).reduce(
    (total, m) => total + m.recoveredRevenue,
    0,
  );
  const share = clientTotalRevenue > 0 ? scopedRevenue / clientTotalRevenue : 1;

  const s = scaleRoiSummary(ROI_SUMMARY, share);

  return (
    <>
      <PageHeader
        title="ROI"
        description="How your patient-acquisition spend turns into booked patients and treatment revenue across every channel."
        stats={
          <>
            <StatCard
              label="Ad spend (30 days)"
              value={money(s.spendGbp)}
              dot="bg-status-amber"
            />
            <StatCard
              label="New patients"
              value={count(s.newPatients)}
              dot="bg-status-blue"
            />
            <StatCard
              label="Cost per new patient"
              value={money(s.costPerAcquisitionGbp, true)}
              dot="bg-status-blue"
            />
            <StatCard
              label="Attributed revenue"
              value={money(s.revenueGbp)}
              dot="bg-status-green"
            />
          </>
        }
      />

      {/* Whole section is sample: spend, cost per patient, attributed revenue, the
          multiplier, funnel, growth trend and channel breakdown all come from the
          mock until Meta and Dentally connect. One banner covers it. */}
      <SampleNote>Sample data, not yet from your live sources. Every figure on this page is a pilot estimate until your Meta and Dentally accounts connect.</SampleNote>

      <div className="grid gap-4 lg:grid-cols-2">
        <AcquisitionFunnel stages={s.funnel} />
        <GrowthTrend trend={s.trend} />
      </div>

      <ChannelBreakdown
        channels={s.channels}
        totals={{
          spendGbp: s.spendGbp,
          leads: s.leads,
          newPatients: s.newPatients,
          revenueGbp: s.revenueGbp,
          costPerAcquisitionGbp: s.costPerAcquisitionGbp,
          returnX: s.returnX,
        }}
      />
    </>
  );
}
