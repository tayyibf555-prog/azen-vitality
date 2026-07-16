import crypto from "crypto";

// Preview token for a DRAFT landing page. A draft is not publicly servable, but
// the owner needs to see the real /go/<client>/<slug> page before publishing, so
// a draft renders only when a valid preview token is supplied on the query string.
//
// The token is an HMAC over the page id, so it is unguessable and cannot be forged
// without the server key, and it is bound to the specific page (a token for one
// draft will not unlock another). It does NOT expire on a short clock: a draft
// preview link should keep working while the owner iterates. Once the page is
// published the token is irrelevant (a live page serves without one).
//
// Mirrors the Smile Assessment embed-token HMAC idiom. Uses the same server key so
// no new secret is introduced; falls back to no-preview (null) when unset.

function keyFor(): string | undefined {
  return process.env.SMILE_ASSESSMENT_SUBMIT_KEY;
}

/** The preview token for a page id, or null when no server key is configured. */
export function mintPreviewToken(pageId: string, key: string | undefined = keyFor()): string | null {
  if (!key || !pageId) return null;
  return crypto.createHmac("sha256", key).update(`landing-preview:${pageId}`).digest("hex");
}

/** Timing-safe check that a token matches a page id. */
export function verifyPreviewToken(
  token: string | null | undefined,
  pageId: string,
  key: string | undefined = keyFor(),
): boolean {
  if (!key || !token || !pageId) return false;
  const want = Buffer.from(mintPreviewToken(pageId, key) ?? "");
  const got = Buffer.from(token);
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}
