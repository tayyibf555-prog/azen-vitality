import { SmileAssessmentView } from "@/components/client/smile-assessment/smile-assessment-view";

export const dynamic = "force-dynamic";

export default async function SmileAssessmentPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <SmileAssessmentView clientSlug={clientSlug} />;
}
