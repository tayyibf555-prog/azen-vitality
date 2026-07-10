import { GettingStartedView } from "@/components/client/getting-started/getting-started-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function GettingStartedPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  // Owner-only, like every sibling owner module: block direct-URL access for
  // coordinators (the sidebar already hides it, but the URL must not work).
  await requireModuleAccess("getting-started");
  return <GettingStartedView clientSlug={clientSlug} />;
}
