import { Plug } from "lucide-react";
import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { isMetaConnected } from "@/lib/meta-ads/connection";
import { MetaAdsWorkspace } from "./meta-ads-workspace";

// Meta Ads section: plan, build and track Facebook and Instagram campaigns, with
// AI ad copy, a launch guide and a winning-ads library. Live campaign figures
// (spend, leads, cost per lead, bookings) come from the practice's Meta account and
// only appear once it is connected: isMetaConnected is the single seam. Until then
// the account figures show an honest not-connected state, while the builder, the ad
// copy generator, the landing pages, the reference library and the launch guide all
// work now so the practice can be ready to launch the day Meta connects.
export function MetaAdsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Meta Ads" description="This client could not be found." />;
  }

  const connected = isMetaConnected(client.id);

  return (
    <>
      <PageHeader
        title="Meta Ads"
        description="Plan, build and track your Facebook and Instagram campaigns in one place, with AI-written ad copy, a launch guide and a library of winning dental ads."
      />

      {connected ? null : (
        <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
          <Plug size={16} className="mt-0.5 shrink-0 text-muted" />
          <p className="text-xs leading-relaxed text-muted">
            Your Meta account is not connected yet. Campaign spend, leads, cost per lead and booked
            patients appear here once it is linked. You can build campaigns, generate compliant ad
            copy and prepare landing pages now, ready to launch the day it connects.
          </p>
        </div>
      )}

      <MetaAdsWorkspace clientSlug={clientSlug} practiceName={client.name} metaConnected={connected} />
    </>
  );
}
