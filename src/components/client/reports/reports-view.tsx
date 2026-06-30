import { Coins, UserPlus, TrendingUp, Gauge } from "lucide-react";
import { PageHeader, StatCard } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { money, count } from "@/components/client/roi/format";
import { buildSnapshot } from "@/lib/reports/snapshot";
import { ReportsWorkspace } from "./reports-workspace";

// Reports section: AI-generated weekly and monthly business reviews for the
// practice owner, pulling together acquisition, conversion, lifecycle and
// compliance with concrete recommendations. The headline numbers come from the
// monthly snapshot so there is always something on screen; the narrative review
// is generated on demand. Data is mock until the live sources connect.
export function ReportsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Reports" description="This client could not be found." />;
  }

  const s = buildSnapshot("month");

  return (
    <>
      <PageHeader
        title="Reports"
        description="AI weekly and monthly business reviews across acquisition, conversion, lifecycle and compliance, with recommendations. The figures are mock until the live sources connect."
      />

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
