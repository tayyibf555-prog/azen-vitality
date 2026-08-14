import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSite } from "@/lib/mock/clients";
import { isMedicalHistoryEnabled } from "@/lib/patient-medical/gate";
import { verifyPatientToken } from "@/lib/public-link/patient-token";
import { MhForm } from "@/components/medical-history/mh-form";

// Public medical-history capture page: the tokenised link a patient opens 24h
// before their appointment, or on an iPad at the desk. A SERVER component that
// gates on the feature flag and verifies the signed { siteId, patientRef } token,
// then renders the patient-facing form. It leaks no patient identity to the
// browser: only the opaque token is passed on, and the form posts it straight back
// so the server resolves the patient from the signature, never the request body.
//
// A switched-off feature, a missing/tampered token, or a token minted for another
// purpose all resolve to notFound() — the same 404, so a probe learns nothing.
// The /mh/* path is public (the proxy gates only /agency, /owner, /c/*).
// force-dynamic so a freshly minted link is always honoured.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Medical history" };

export default async function MedicalHistoryCapturePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // With the feature off there is nothing to capture and nowhere to store it, so
  // the link is dead. 404 rather than a message, so the page state cannot be
  // distinguished from a bad token.
  if (!isMedicalHistoryEnabled()) notFound();

  const identity = verifyPatientToken(token, "mh");
  if (!identity) notFound();

  const practiceName = getSite(identity.siteId)?.name ?? null;
  return <MhForm token={token} practiceName={practiceName} />;
}
