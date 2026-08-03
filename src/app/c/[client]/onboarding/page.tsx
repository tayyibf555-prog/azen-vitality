import { OnboardingView } from "@/components/client/onboarding/onboarding-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("onboarding");
  return <OnboardingView clientSlug={clientSlug} />;
}
