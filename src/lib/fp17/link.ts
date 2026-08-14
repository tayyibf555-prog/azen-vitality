import { mintPatientToken } from "@/lib/public-link/patient-token";

// The per-patient FP17 declaration link, minted with the shared purpose-scoped
// token ('fp17'), or null when no server key is set (local/dev). Uses
// PUBLIC_BASE_URL for an absolute URL when available, else a root-relative path.
//
// STAGED, exactly like messaging/pref-token.ts's buildPrefLink: nothing auto-sends
// this yet. The brief's "24h before / iPad on the day" auto-send is a later,
// supervised messaging step (per the per-module-messaging-tables discipline). This
// helper exists so that step — and the practice's own "copy a link" action — has one
// place to mint the link, and so the token's purpose can never be got wrong at a call
// site. On submit the endpoint re-verifies this exact token server-side.

export function buildFp17Link(
  siteId: string,
  patientRef: string,
  clientSlug: string,
  baseUrl: string | undefined = process.env.PUBLIC_BASE_URL,
): string | null {
  const token = mintPatientToken({ siteId, patientRef, purpose: "fp17" });
  if (!token) return null;
  const base = baseUrl && baseUrl.startsWith("http") ? baseUrl.replace(/\/$/, "") : "";
  return `${base}/fp17/${clientSlug}/${token}`;
}
