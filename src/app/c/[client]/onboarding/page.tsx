import { OnboardingView } from "@/components/client/onboarding/onboarding-view";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <OnboardingView clientSlug={clientSlug} />;
}
