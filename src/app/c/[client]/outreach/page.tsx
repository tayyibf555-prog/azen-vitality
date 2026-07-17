import { OutreachCampaignsView } from "@/components/client/outreach/campaigns-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function OutreachPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  // Owner-only module: block a direct-URL visit by a coordinator (nav already hides
  // it for them). The kill switch is NOT checked here: this is a management surface
  // that stays reachable when the outreach system is off, so the owner can review
  // campaigns and switch it on. Launch itself is gated in the view.
  await requireModuleAccess("outreach");
  return <OutreachCampaignsView clientSlug={clientSlug} />;
}
