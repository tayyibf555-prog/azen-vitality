import { Coins, UserPlus, TrendingUp, Gauge } from "lucide-react";
import { PageHeader, StatCard, SampleNote } from "@/components/primitives";
import { getClient, getSites, getSiteMetrics } from "@/lib/mock";
import { getViewSiteIds } from "@/lib/site-view";
import { money, count } from "@/components/client/roi/format";
import { buildSnapshot } from "@/lib/reports/snapshot";
import { ReportsWorkspace } from "./reports-workspace";

// Reports section: AI-generated weekly and monthly business reviews for the
// practice owner, pulling together acquisition, conversion, lifecycle and
// compliance with concrete recommendations. The headline numbers come from the
// monthly snapshot so there is always something on screen; the narrative review
// is generated on demand. The acquisition figures are scoped to the selected
// site(s) by proportional scaling (the site's share of client recovered revenue);
// compliance readiness is point-in-time and is not scaled. Data is mock until the
// live sources connect.
export async function ReportsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Reports" description="This client could not be found." />;
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

  const s = buildSnapshot("month", share);

  return (
    <>
      <PageHeader
        title="Reports"
        description="AI weekly and monthly business reviews across acquisition, conversion, lifecycle and compliance, with recommendations."
      />

      {/* Was a subtle line in the header description; promoted to a visible banner so
          the figures below are unmistakably sample. */}
      <SampleNote>Sample data, not yet from your live sources. The figures in these reviews are pilot estimates until the live sources connect.</SampleNote>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Spend (30 days)"
          value={money(s.spendGbp)}
          icon={Coins}
          hint="Across every paid channel"
        />
        <StatCard
          label="New patients"
          value={count(s.newPatients)}
          icon={UserPlus}
          hint={`From ${count(s.leads)} enquiries`}
        />
        <StatCard
          label="Revenue (30 days)"
          value={money(s.revenueGbp)}
          icon={TrendingUp}
          hint="Attributed to acquisition"
        />
        <StatCard
          label="Return on spend"
          value={`${s.returnX.toFixed(1)}x`}
          icon={Gauge}
          hint={`£${s.costPerNewPatientGbp} per new patient`}
        />
      </div>

      <ReportsWorkspace clientSlug={clientSlug} />
    </>
  );
}
