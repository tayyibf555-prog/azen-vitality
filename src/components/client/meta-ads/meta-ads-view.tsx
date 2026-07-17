import { PageHeader, StatCard, SampleNote } from "@/components/primitives";
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
        description="Plan, build and track your Facebook and Instagram campaigns in one place, with AI-written ad copy, a launch guide, analytics and a library of winning dental ads."
      />

      {/* Header disclaimer: spend, leads, cost per lead and booked stats are all
          sample until the practice's Meta account connects. */}
      <SampleNote>Sample data, not yet from your live sources. Spend, leads and cost figures are pilot estimates until your Meta account connects.</SampleNote>

      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="Spend (last 30 days)"
          value={money(s.spendGbp)}
          dot="bg-status-amber"
          hint={`Across active campaigns`}
        />
        <StatCard label="Leads" value={count(s.leads)} dot="bg-status-blue" hint="Enquiries from ads" />
        <StatCard
          label="Cost per lead"
          value={money(s.cplGbp, true)}
          dot="bg-status-blue"
          hint="Spend divided by leads"
        />
        <StatCard
          label="Booked patients"
          value={count(s.bookings)}
          dot="bg-status-green"
          hint={`${money(s.costPerBookingGbp, true)} per booking`}
        />
      </div>

      <MetaAdsWorkspace clientSlug={clientSlug} practiceName={client.name} />
    </>
  );
}
