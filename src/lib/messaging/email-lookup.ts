import { serviceClient } from "@/lib/supabase/server";
import { normaliseEmail } from "@/lib/messaging/phone";

// NeverBounce pre-send validation ("never pay to email an undeliverable address").
// The exact email mirror of the Twilio Lookup phone path (src/lib/messaging/lookup.ts).
//
// Before the send path emails a resolved address, it can ask NeverBounce whether
// that address is a real, reachable mailbox. An invalid or disposable address is
// blocked BEFORE the send, so we never spend on a message that can never arrive.
//
// DORMANT BY DEFAULT. The whole feature is DOUBLE-GATED on NEVERBOUNCE_API_KEY
// *and* EMAIL_LOOKUP_ENABLED: with either unset (the current state - email is not
// even configured in prod yet) validateEmail is a no-op that returns valid=true,
// so the send path behaves EXACTLY as before. The key alone must not activate it;
// it ships switched off and is turned on deliberately.
//
// COST DISCIPLINE. Every verdict is cached in email_lookup (migration 0054) keyed
// by the normalised (trimmed + lowercased) address, with a 90-day TTL. A cache hit
// NEVER re-calls the API, so an address we have already validated costs nothing on
// subsequent sends.
//
// AVAILABILITY BEATS COST. A NeverBounce error (timeout, 5xx, quota, network, or a
// non-"success" status like auth_failure/temp_unavail/throttle_triggered) FAILS
// OPEN: we return valid=true and log, so a NeverBounce outage degrades the cost
// saving rather than black-holing genuine sends. Only a definitive "invalid" or
// "disposable" verdict blocks a send; catchall/unknown pass (fail-open posture,
// cost saving not delivery blocking).

/** Whether pre-send email validation is switched on. Default OFF (dormant). */
export function emailLookupEnabled(): boolean {
  // Double gate: the key alone must NOT activate it (email is not live in prod).
  return Boolean(process.env.NEVERBOUNCE_API_KEY) && process.env.EMAIL_LOOKUP_ENABLED === "true";
}

/** A row older than this is treated as a cache miss and re-validated. */
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** NeverBounce single-check request timeout - kept short so a slow API never stalls a send. */
const API_TIMEOUT_MS = 5_000;

export interface EmailValidation {
  /** OUR deliverability verdict: a real mailbox that can receive an email. */
  valid: boolean;
  /** NeverBounce's raw result when known (valid/invalid/disposable/catchall/unknown), else null. */
  verdict: string | null;
  /** Where the verdict came from - for logs/tests, never a gate itself. */
  source: "disabled" | "no-address" | "cache" | "api" | "api-error";
}

type FetchImpl = typeof fetch;

interface ValidateOptions {
  fetchImpl?: FetchImpl;
  now?: Date;
}

/** A cache row within the 90-day TTL, or null (miss/expired/error). */
async function readCache(email: string, now: Date): Promise<{ valid: boolean; verdict: string | null } | null> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("email_lookup")
      .select("valid, verdict, checked_at")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as { valid: boolean; verdict: string | null; checked_at: string };
    if (now.getTime() - Date.parse(row.checked_at) > CACHE_TTL_MS) return null; // stale: re-validate
    return { valid: Boolean(row.valid), verdict: row.verdict ?? null };
  } catch (err) {
    // A cache-read blip must not block a send: treat as a miss and let the API (or
    // its fail-open) decide.
    console.warn(`[email-lookup] cache read failed for ${email}; treating as miss`, err);
    return null;
  }
}

/** Persist a verdict so a future send for this address never re-calls the API. */
async function writeCache(email: string, valid: boolean, verdict: string | null, now: Date): Promise<void> {
  try {
    const db = serviceClient();
    const { error } = await db
      .from("email_lookup")
      .upsert({ email, valid, verdict, checked_at: now.toISOString() }, { onConflict: "email" });
    if (error) throw error;
  } catch (err) {
    // Best-effort: a failed cache write only costs a future re-lookup, never a send.
    console.warn(`[email-lookup] cache write failed for ${email}`, err);
  }
}

/**
 * NeverBounce's result -> our "can receive an email" verdict.
 *
 * Only a definitive "invalid" or "disposable" result is undeliverable. Everything
 * else - "valid", "catchall", "unknown", or an absent result - passes, so the
 * feature saves cost on the addresses we are sure about and never blocks a send on
 * an unverifiable one (fail-open posture).
 */
function deliverable(verdict: string | null): boolean {
  if (!verdict) return true;
  const v = verdict.toLowerCase();
  return v !== "invalid" && v !== "disposable";
}

/**
 * Whether a resolved email address can receive an email, per NeverBounce.
 *
 * Returns valid=true (a no-op) when the feature is disabled, when no address is
 * given, or when the NeverBounce API errors (fail open). Only a cached or freshly
 * fetched "invalid"/"disposable" verdict returns valid=false. A cache hit never
 * calls the API. The address is normalised (trimmed + lowercased) first, so the
 * same mailbox in any case/whitespace form hits the same cache row.
 */
export async function validateEmail(
  addr: string | null | undefined,
  opts: ValidateOptions = {},
): Promise<EmailValidation> {
  // Dormant unless explicitly switched on: no cache read, no API call, no change.
  if (!emailLookupEnabled()) return { valid: true, verdict: null, source: "disabled" };

  // Normalise first so "Foo@Bar.COM " and "foo@bar.com" share one cache row and one
  // verdict. An unparseable address is nothing we can validate: fail open (the
  // resolve path already retires a genuinely missing address before we get here).
  const email = normaliseEmail(addr);
  if (!email) return { valid: true, verdict: null, source: "no-address" };

  const now = opts.now ?? new Date();

  // Cache first: a hit is authoritative and free (never re-calls the paid API).
  const cached = await readCache(email, now);
  if (cached) return { valid: cached.valid, verdict: cached.verdict, source: "cache" };

  // Miss: call NeverBounce single-check. Any failure fails OPEN (send anyway) - an
  // availability outage must never stop genuine sends.
  const apiKey = process.env.NEVERBOUNCE_API_KEY;
  if (!apiKey) {
    console.warn("[email-lookup] no NeverBounce API key configured; failing open (allowing the send)");
    return { valid: true, verdict: null, source: "api-error" };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  // NeverBounce v4 single-check: GET, API key + email as query params.
  const url =
    `https://api.neverbounce.com/v4.2/single/check` +
    `?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[email-lookup] NeverBounce returned ${res.status} for ${email}; failing open (allowing the send)`);
      return { valid: true, verdict: null, source: "api-error" };
    }
    const data = (await res.json()) as { status?: string; result?: string | null };
    // A non-"success" envelope (auth_failure, temp_unavail, throttle_triggered, …)
    // is an API-level error, not a delivery verdict: fail open.
    if (data.status !== "success") {
      console.warn(
        `[email-lookup] NeverBounce status "${data.status ?? "unknown"}" for ${email}; failing open (allowing the send)`,
      );
      return { valid: true, verdict: null, source: "api-error" };
    }
    const verdict = data.result ?? null;
    const isDeliverable = deliverable(verdict);
    // Cache the verdict (valid + invalid alike) so we never re-pay to learn it.
    await writeCache(email, isDeliverable, verdict, now);
    return { valid: isDeliverable, verdict, source: "api" };
  } catch (err) {
    console.warn(`[email-lookup] NeverBounce call failed for ${email}; failing open (allowing the send)`, err);
    return { valid: true, verdict: null, source: "api-error" };
  }
}
