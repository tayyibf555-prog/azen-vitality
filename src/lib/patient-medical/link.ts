import { mintPatientToken } from "@/lib/public-link/patient-token";

// The public medical-history capture link for a patient. Mirrors buildPrefLink in
// src/lib/messaging/pref-token.ts, and is STAGED the same way: nothing auto-sends it
// yet. The "send the link 24h before the appointment" job is a later, supervised
// step (each module gets its own outbox, per the per-module-messaging-tables rule),
// and a staff "copy link" affordance is the other caller. This helper exists so both
// have ONE place to mint from, and so the token is minted with purpose 'mh' — an
// FP17 token can never be replayed against the medical-history endpoint.

/**
 * The absolute /mh/<token> link for a patient, or null when no server key is set
 * (local/dev), in which case there is nothing to send. Uses PUBLIC_BASE_URL for an
 * absolute URL when available, else a root-relative path.
 */
export function buildMedicalHistoryLink(
  siteId: string,
  patientRef: string,
  baseUrl: string | undefined = process.env.PUBLIC_BASE_URL,
): string | null {
  const token = mintPatientToken({ siteId, patientRef, purpose: "mh" });
  if (!token) return null;
  const base = baseUrl && baseUrl.startsWith("http") ? baseUrl.replace(/\/$/, "") : "";
  return `${base}/mh/${token}`;
}
