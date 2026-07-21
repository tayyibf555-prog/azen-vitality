import { LandingPagesView } from "@/components/client/landing-pages/landing-pages-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function LandingPagesPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("landing-pages");
  return <LandingPagesView clientSlug={clientSlug} />;
}
