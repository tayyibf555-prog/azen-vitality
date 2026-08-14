import crypto from "crypto";

// Signed, purpose-scoped per-patient token for public patient-facing links.
//
// This GENERALISES src/lib/messaging/pref-token.ts: the token CARRIES the site id
// + patient ref and is signed with an HMAC, so a public page can decode which
// patient it is for while a tampered or forged token is rejected without the server
// key. It reuses the SAME server key as pref-token / the smile embed-token idiom, so
// no new secret is introduced; with the key unset (local/dev) minting returns null
// and verifying returns null.
//
// What is NEW here is the `purpose` scope. A token minted for one purpose (e.g. the
// medical-history form, 'mh') MUST NOT be replayable against a different purpose's
// endpoint (e.g. the FP17 form, 'fp17'). We enforce that two ways:
//   1. `purpose` lives INSIDE the signed payload, so it cannot be swapped without
//      invalidating the signature; and
//   2. `purpose` is mixed into the HMAC PREFIX, so verifying a token demands the
//      SAME purpose the caller expects - a 'mh' signature simply does not match the
//      'fp17' prefix (and vice-versa). This is the load-bearing cross-purpose gate.
//
// Format: base64url(payloadJson) + "." + hex(hmac-sha256("patient:<purpose>:" +
// payloadB64)). The payload is the { siteId, patientRef, purpose } triple.

const KEY_ENV = "SMILE_ASSESSMENT_SUBMIT_KEY";

export type PatientLinkPurpose = "mh" | "fp17";

export interface PatientTokenInput {
  siteId: string;
  patientRef: string;
  purpose: PatientLinkPurpose;
}

export interface PatientTokenPayload {
  siteId: string;
  patientRef: string;
}

function keyFor(): string | undefined {
  return process.env[KEY_ENV];
}

function isPurpose(value: unknown): value is PatientLinkPurpose {
  return value === "mh" || value === "fp17";
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

// The purpose is mixed into the signed prefix. Changing this to drop `purpose`
// removes the cross-purpose replay defence and turns the rejection test red.
function sign(payloadB64: string, purpose: PatientLinkPurpose, key: string): string {
  return crypto.createHmac("sha256", key).update(`patient:${purpose}:${payloadB64}`).digest("hex");
}

/**
 * The signed token for a (site, patient, purpose) triple, or null when no server key
 * is set or a field is missing/invalid.
 */
export function mintPatientToken(
  input: PatientTokenInput,
  key: string | undefined = keyFor(),
): string | null {
  if (!key || !input.siteId || !input.patientRef || !isPurpose(input.purpose)) return null;
  const payloadB64 = b64url(
    JSON.stringify({ siteId: input.siteId, patientRef: input.patientRef, purpose: input.purpose }),
  );
  return `${payloadB64}.${sign(payloadB64, input.purpose, key)}`;
}

/**
 * Decode + verify a token against an EXPECTED purpose, returning its { siteId,
 * patientRef } payload, or null when the key is unset, the token is malformed, the
 * signature does not match (tamper/forgery), or the token was minted for a different
 * purpose. Uses a timing-safe comparison.
 */
export function verifyPatientToken(
  token: string | null | undefined,
  expectedPurpose: PatientLinkPurpose,
  key: string | undefined = keyFor(),
): PatientTokenPayload | null {
  if (!key || !token || !isPurpose(expectedPurpose)) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Signed with the EXPECTED purpose's prefix: a token minted for another purpose
  // will not match here, so it cannot be replayed across endpoints.
  const want = Buffer.from(sign(payloadB64, expectedPurpose, key));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const parsed = JSON.parse(fromB64url(payloadB64).toString("utf8")) as Partial<PatientTokenInput>;
    if (
      typeof parsed.siteId === "string" &&
      typeof parsed.patientRef === "string" &&
      parsed.siteId &&
      parsed.patientRef &&
      isPurpose(parsed.purpose)
    ) {
      return { siteId: parsed.siteId, patientRef: parsed.patientRef };
    }
    return null;
  } catch {
    return null;
  }
}
