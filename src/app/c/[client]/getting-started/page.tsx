import { GettingStartedView } from "@/components/client/getting-started/getting-started-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function GettingStartedPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  // Open to every role (unlike its Operations siblings): the coordinator is
  // normally the one working through the checklist, so this is a no-op guard
  // for them and only blocks a role/client mismatch.
  await requireModuleAccess("getting-started");
  return <GettingStartedView clientSlug={clientSlug} />;
}
