import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { getClient } from "@/lib/mock/clients";
import { getConfig } from "@/lib/onboarding/config-repository";
import { resolveSteps } from "@/lib/onboarding/resolve";
import { practiceName } from "@/lib/onboarding/config";

// Public, branded new-patient onboarding form at /onboard/<client>. A SERVER component:
// it resolves the practice from the [client] slug, loads that practice's saved form
// config (or null for the default flow), resolves the config into the steps to render,
// and hands them to the client form. No auth — the slug brands the page and scopes the
// config. force-dynamic so a freshly saved config is always reflected.

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  const client = getClient(clientSlug);

  // Unknown practice: a friendly message, not a crash. No data is fetched.
  if (!client) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-5 py-10 text-center">
        <h1 className="text-2xl font-bold text-navy">We couldn&rsquo;t find this practice</h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          Please check the link you were given, or get in touch with the practice and they&rsquo;ll
          be happy to help.
        </p>
      </main>
    );
  }

  const config = await getConfig(client.id);
  const steps = resolveSteps(config);

  return (
    <OnboardingForm
      clientSlug={client.slug}
      practiceName={practiceName(client)}
      steps={steps}
    />
  );
}
