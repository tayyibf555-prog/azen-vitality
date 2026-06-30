import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { OnboardingWorkspace } from "./onboarding-workspace";

// Onboarding section (internal staff view).
//
// New patients complete the branded onboarding form at /onboard/<client> — contact,
// address, a brief medical intake, optional documents and consent, collected step by
// step. Each completed form lands here for the team to review and register into the
// practice. Submissions are mock and in test mode until go-live.
//
// The headline numbers and worklist are fetched client-side from the auth-gated
// /api/onboarding/list (which requires the user's session cookie), so the StatCards and
// the worklist both live in the client workspace and stay in sync.

export function OnboardingView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Onboarding" description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader
        title="Onboarding"
        description={`New patients who completed the onboarding form at /onboard/${client.slug}, ready for the team to review and register. Each form captures contact, address, a brief medical intake, any documents and consent. Submissions are mock and in test mode until go-live.`}
      />

      <OnboardingWorkspace clientSlug={clientSlug} practiceName={client.name} />
    </>
  );
}
