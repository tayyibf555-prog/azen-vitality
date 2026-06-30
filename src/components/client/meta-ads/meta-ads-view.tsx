import { Coins, Users, Target, CalendarCheck } from "lucide-react";
import { PageHeader, StatCard } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { ACCOUNT_SUMMARY } from "@/lib/meta-ads/mock";
import { money, count } from "./format";
import { MetaAdsWorkspace } from "./meta-ads-workspace";

// Meta Ads section: plan, build and track Facebook and Instagram campaigns, with
// AI ad copy, a launch guide, analytics and a winning-ads library. The data layer
// is mock until the practice's Meta account is connected; every piece of copy is
// built to UK GDC and ASA rules.
export function MetaAdsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Meta Ads" description="This client could not be found." />;
  }

  const s = ACCOUNT_SUMMARY;

  return (
    <>
      <PageHeader
        title="Meta Ads"
        description="Plan, build and track your Facebook and Instagram campaigns in one place: AI-written ad copy, a step-by-step launch guide, performance analytics and a library of winning dental ads. Campaign figures are mock until your Meta account is connected, and every piece of copy is built to UK GDC and ASA advertising rules."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Spend (last 30 days)"
          value={money(s.spendGbp)}
          icon={Coins}
          hint={`Across active campaigns`}
        />
        <StatCard label="Leads" value={count(s.leads)} icon={Users} hint="Enquiries from ads" />
        <StatCard
          label="Cost per lead"
          value={money(s.cplGbp, true)}
          icon={Target}
          hint="Spend divided by leads"
        />
        <StatCard
          label="Booked patients"
          value={count(s.bookings)}
          icon={CalendarCheck}
          hint={`${money(s.costPerBookingGbp, true)} per booking`}
        />
      </div>

      <MetaAdsWorkspace clientSlug={clientSlug} practiceName={client.name} />
    </>
  );
}
