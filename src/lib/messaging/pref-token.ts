import crypto from "crypto";

// Signed per-patient token for the public channel-preference page (/prefs/<token>).
//
// The token CARRIES the site id + patient ref and is signed with an HMAC, so the
// public page can decode which patient it is for while a tampered or forged token
// is rejected without the server key. It is unguessable and cannot be minted
// without the key. This mirrors the landing preview-token / smile embed-token idiom
// and reuses the SAME server key, so no new secret is introduced; with the key
// unset (local/dev) minting returns null and verifying returns null.
//
// Format: base64url(payloadJson) + "." + hex(hmac-sha256(payloadB64)). The payload
// is the { siteId, patientRef } pair. The signature is over the base64url payload,
// so any change to the payload invalidates it.

const KEY_ENV = "SMILE_ASSESSMENT_SUBMIT_KEY";

export interface PrefTokenPayload {
  siteId: string;
  patientRef: string;
}

function keyFor(): string | undefined {
  return process.env[KEY_ENV];
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64: string, key: string): string {
  return crypto.createHmac("sha256", key).update(`pref:${payloadB64}`).digest("hex");
}

/** The signed token for a (site, patient) pair, or null when no server key is set. */
export function mintPrefToken(
  payload: PrefTokenPayload,
  key: string | undefined = keyFor(),
): string | null {
  if (!key || !payload.siteId || !payload.patientRef) return null;
  const payloadB64 = b64url(JSON.stringify({ siteId: payload.siteId, patientRef: payload.patientRef }));
  return `${payloadB64}.${sign(payloadB64, key)}`;
}

/**
 * Decode + verify a token, returning its payload, or null when the key is unset,
 * the token is malformed, or the signature does not match (tamper/forgery). Uses a
 * timing-safe comparison.
 */
export function verifyPrefToken(
  token: string | null | undefined,
  key: string | undefined = keyFor(),
): PrefTokenPayload | null {
  if (!key || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = Buffer.from(sign(payloadB64, key));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const parsed = JSON.parse(fromB64url(payloadB64).toString("utf8")) as Partial<PrefTokenPayload>;
    if (typeof parsed.siteId === "string" && typeof parsed.patientRef === "string" && parsed.siteId && parsed.patientRef) {
      return { siteId: parsed.siteId, patientRef: parsed.patientRef };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The public preference link for a patient, or null when no server key is set.
 * Uses PUBLIC_BASE_URL for an absolute URL when available, else a root-relative
 * path. NOTE: nothing auto-appends this to message templates yet - that wiring is
 * a later, supervised step. This helper exists so that step has one place to call.
 */
export function buildPrefLink(
  siteId: string,
  patientRef: string,
  baseUrl: string | undefined = process.env.PUBLIC_BASE_URL,
): string | null {
  const token = mintPrefToken({ siteId, patientRef });
  if (!token) return null;
  const base = baseUrl && baseUrl.startsWith("http") ? baseUrl.replace(/\/$/, "") : "";
  return `${base}/prefs/${token}`;
}
