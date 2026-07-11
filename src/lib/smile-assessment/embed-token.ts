import crypto from "crypto";

// Page token for the PUBLIC Smile Assessment funnel (our /assess pages and the
// practice-website embed). The quiz fetches this short-lived token and sends it
// with the submission; the submit route treats a valid token as TRUSTED, which
// unlocks the instant first-contact bridge.
//
// Threat model, honestly stated: the token route is public, so this is NOT a
// secret gate — a determined scripter can fetch a token like the browser does.
// What it buys: the raw SMILE_ASSESSMENT_SUBMIT_KEY is never exposed (that key
// stays server-to-server), tokens rotate hourly so nothing long-lived leaks into
// page sources or logs, and drive-by POSTs without a fetch step are refused. The
// REAL abuse defences remain the per-contact and per-IP rate limits and the
// api_budget guard on the submit route; a CAPTCHA/Turnstile stays the proper
// upgrade before high-volume live traffic.

const HOUR_MS = 3_600_000;

function mac(key: string, clientSlug: string, bucket: number): string {
  return crypto.createHmac("sha256", key).update(`smile-submit:${clientSlug}:${bucket}`).digest("hex");
}

/** The current token for a client's funnel, or null when no key is configured. */
export function mintSubmitToken(
  clientSlug: string,
  now: Date = new Date(),
  key: string | undefined = process.env.SMILE_ASSESSMENT_SUBMIT_KEY,
): string | null {
  if (!key || !clientSlug) return null;
  return mac(key, clientSlug, Math.floor(now.getTime() / HOUR_MS));
}

/** Whether a submitted token is valid for this client (current or previous hour,
 *  so a form open across the boundary still submits). Timing-safe comparison. */
export function verifySubmitToken(
  token: string | null | undefined,
  clientSlug: string,
  now: Date = new Date(),
  key: string | undefined = process.env.SMILE_ASSESSMENT_SUBMIT_KEY,
): boolean {
  if (!key || !token || !clientSlug) return false;
  const bucket = Math.floor(now.getTime() / HOUR_MS);
  const provided = Buffer.from(token);
  for (const b of [bucket, bucket - 1]) {
    const want = Buffer.from(mac(key, clientSlug, b));
    if (provided.length === want.length && crypto.timingSafeEqual(provided, want)) return true;
  }
  return false;
}
