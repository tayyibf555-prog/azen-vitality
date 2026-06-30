"use client";

import { useParams } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { getClient } from "@/lib/mock";

// Public, branded new-patient onboarding form at /onboard/<client>. A thin client
// wrapper mirroring /assess/<client>: it reads the [client] slug from the URL and
// hands it to the shared form. No auth, no SSR data fetch — the slug brands the form
// and resolves the practice name.

export default function OnboardingPage() {
  const params = useParams<{ client: string }>();
  const clientSlug = typeof params.client === "string" ? params.client : "";
  const practiceName = getClient(clientSlug)?.name;

  return <OnboardingForm clientSlug={clientSlug} practiceName={practiceName} />;
}
