import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { getClient } from "@/lib/mock/clients";
import { getActiveFormBySlug } from "@/lib/onboarding/form-repository";
import { resolveSteps } from "@/lib/onboarding/resolve";
import { practiceName } from "@/lib/onboarding/config";

// Public landing page for a NAMED onboarding form (/onboard/<client>/<slug>): the
// shareable link an owner sends to patients. Mirrors the campaign landing
// (/assess/<client>/<slug>): a SERVER component that resolves the practice and the
// active form (service-role reads via the repository), resolves the form's own config
// into steps, and renders the branded form with the form's headline/intro. Submissions
// carry the form slug so they are attributed back to it. A missing practice or a
// missing/paused form 404s. The /onboard/* paths are public (the proxy gates only
// /agency, /owner, /c/*). force-dynamic so an edited form is always reflected.

export const dynamic = "force-dynamic";

interface Params {
  client: string;
  slug: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { client, slug } = await params;
  const clientRecord = getClient(client);
  if (!clientRecord) return { title: "New patient onboarding" };
  try {
    const form = await getActiveFormBySlug(clientRecord.id, slug);
    if (!form) return { title: `New patient onboarding | ${clientRecord.name}` };
    return {
      title: `${form.headline || "New patient onboarding"} | ${clientRecord.name}`,
      description: form.intro || form.headline || undefined,
    };
  } catch {
    return { title: `New patient onboarding | ${clientRecord.name}` };
  }
}

export default async function NamedOnboardingPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { client: clientSlug, slug } = await params;

  const client = getClient(clientSlug);
  if (!client) notFound();

  // Degrade a transient read error to a clean 404 rather than a 500 on a public link.
  let form = null;
  try {
    form = await getActiveFormBySlug(client.id, slug);
  } catch {
    form = null;
  }
  if (!form) notFound();

  const steps = resolveSteps(form.config);

  return (
    <OnboardingForm
      clientSlug={client.slug}
      practiceName={practiceName(client)}
      steps={steps}
      formSlug={form.slug}
      headline={form.headline ?? undefined}
      intro={form.intro ?? undefined}
    />
  );
}
