import { Coins, UserPlus, Target, TrendingUp } from "lucide-react";
import { PageHeader, StatCard } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { ROI_SUMMARY } from "@/lib/roi/mock";
import { money, count } from "./format";
import { AcquisitionFunnel } from "./acquisition-funnel";
import { ChannelBreakdown } from "./channel-breakdown";
import { GrowthTrend } from "./growth-trend";

// ROI (growth) section: a practice-wide view of how patient-acquisition spend
// turns into leads, booked patients and treatment revenue across every channel,
// with cost per new patient and return on spend. The data is mock until the live
// sources (Meta for spend and leads, Dentally for bookings and revenue) connect.
export function RoiView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="ROI" description="This client could not be found." />;
  }

  const s = ROI_SUMMARY;

  return (
    <>
      <PageHeader
        title="ROI"
        description="How your patient-acquisition spend turns into booked patients and treatment revenue across every channel."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Ad spend (30 days)"
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
          label="Cost per new patient"
          value={money(s.costPerAcquisitionGbp, true)}
          icon={Target}
          hint="Spend divided by new patients"
        />
        <StatCard
          label="Attributed revenue"
          value={money(s.revenueGbp)}
          icon={TrendingUp}
          hint={`${s.returnX.toFixed(1)}x on spend`}
        />
      </div>

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
