import { AbsenceView } from "@/components/client/absence/absence-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function AbsencePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("absence");
  return <AbsenceView clientSlug={clientSlug} />;
}
