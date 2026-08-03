import { AfterHoursView } from "@/components/client/after-hours/after-hours-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function AfterHoursPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("after-hours");
  return <AfterHoursView clientSlug={clientSlug} />;
}
