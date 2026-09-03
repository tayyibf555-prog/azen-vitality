import { PreVisitTriageView } from "@/components/client/previsit/previsit-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function PreVisitTriagePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("pre-visit-triage");
  return <PreVisitTriageView clientSlug={clientSlug} />;
}
