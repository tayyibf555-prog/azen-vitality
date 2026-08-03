import { SmileAssessmentView } from "@/components/client/smile-assessment/smile-assessment-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function SmileAssessmentPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("smile-assessment");
  return <SmileAssessmentView clientSlug={clientSlug} />;
}
