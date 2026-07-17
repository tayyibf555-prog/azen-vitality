import { serviceClient } from "@/lib/supabase/server";

// Twilio Lookup v2 pre-send validation ("never pay for undeliverable texts").
//
// Before the send path dispatches an SMS/WhatsApp to a resolved number, it can
// ask Twilio Lookup (line_type_intelligence) whether that number is a real mobile
// that can receive a text. A landline or an invalid number is blocked BEFORE the
// paid send, so we never spend on a message that can never arrive.
//
// DORMANT BY DEFAULT. The whole feature is gated on TWILIO_LOOKUP_ENABLED: with it
// unset (the current state) validateMobile is a no-op that returns valid=true, so
// the send path behaves EXACTLY as before. It ships switched off and is turned on
// deliberately.
//
// COST DISCIPLINE. Every verdict is cached in phone_lookup (migration 0045) keyed
// by the E.164 number, with a 90-day TTL. A cache hit NEVER re-calls the API, so a
// number we have already validated costs nothing on subsequent sends.
//
// AVAILABILITY BEATS COST. A Lookup API error (timeout, 5xx, quota, network) FAILS
// OPEN: we return valid=true and log, so a Twilio Lookup outage degrades the cost
// saving rather than black-holing genuine sends. Only a definitive "not a mobile"
// verdict blocks a send.

/** Whether pre-send Lookup validation is switched on. Default OFF (dormant). */
export function lookupEnabled(): boolean {
  return process.env.TWILIO_LOOKUP_ENABLED === "true";
}

/** A row older than this is treated as a cache miss and re-validated. */
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface MobileValidation {
  /** OUR deliverability verdict: a real mobile/VoIP that can receive an SMS. */
  valid: boolean;
  /** Twilio's line type when known (mobile/landline/voip/…), else null. */
  lineType: string | null;
  /** Where the verdict came from - for logs/tests, never a gate itself. */
  source: "disabled" | "no-number" | "cache" | "api" | "api-error";
}

type FetchImpl = typeof fetch;

interface ValidateOptions {
  fetchImpl?: FetchImpl;
  now?: Date;
}

interface LookupCreds {
  accountSid?: string;
  authToken?: string;
  apiKeySid?: string;
  apiKeySecret?: string;
}

function envCreds(): LookupCreds {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    apiKeySid: process.env.TWILIO_API_KEY_SID,
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET,
  };
}

/** Basic-auth header value using the same credential preference as the sender. */
function authHeader(cfg: LookupCreds): string | null {
  const useApiKey = Boolean(cfg.apiKeySid && cfg.apiKeySecret);
  const user = useApiKey ? cfg.apiKeySid! : cfg.accountSid;
  const pass = useApiKey ? cfg.apiKeySecret! : cfg.authToken;
  if (!user || !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** A cache row within the 90-day TTL, or null (miss/expired/error). */
async function readCache(phone: string, now: Date): Promise<{ valid: boolean; lineType: string | null } | null> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("phone_lookup")
      .select("valid, line_type, checked_at")
      .eq("phone", phone)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as { valid: boolean; line_type: string | null; checked_at: string };
    if (now.getTime() - Date.parse(row.checked_at) > CACHE_TTL_MS) return null; // stale: re-validate
    return { valid: Boolean(row.valid), lineType: row.line_type ?? null };
  } catch (err) {
    // A cache-read blip must not block a send: treat as a miss and let the API (or
    // its fail-open) decide.
    console.warn(`[lookup] cache read failed for ${phone}; treating as miss`, err);
    return null;
  }
}

/** Persist a verdict so a future send for this number never re-calls the API. */
async function writeCache(phone: string, valid: boolean, lineType: string | null, now: Date): Promise<void> {
  try {
    const db = serviceClient();
    const { error } = await db
      .from("phone_lookup")
      .upsert({ phone, valid, line_type: lineType, checked_at: now.toISOString() }, { onConflict: "phone" });
    if (error) throw error;
  } catch (err) {
    // Best-effort: a failed cache write only costs a future re-lookup, never a send.
    console.warn(`[lookup] cache write failed for ${phone}`, err);
  }
}

/** Twilio's line type -> our "can receive an SMS" verdict. Landline = not deliverable. */
function deliverable(valid: boolean, lineType: string | null): boolean {
  if (!valid) return false;
  // Absent line-type intelligence: trust the top-level `valid` (fail toward sending).
  if (!lineType) return true;
  return lineType.toLowerCase() !== "landline";
}

/**
 * Whether a resolved E.164 number can receive an SMS/WhatsApp, per Twilio Lookup.
 *
 * Returns valid=true (a no-op) when the feature is disabled, when no number is
 * given, or when the Lookup API errors (fail open). Only a cached or freshly
 * fetched "not a mobile" verdict returns valid=false. A cache hit never calls the
 * API.
 */
export async function validateMobile(
  phone: string | null | undefined,
  opts: ValidateOptions = {},
): Promise<MobileValidation> {
  // Dormant unless explicitly switched on: no cache read, no API call, no change.
  if (!lookupEnabled()) return { valid: true, lineType: null, source: "disabled" };
  if (!phone) return { valid: true, lineType: null, source: "no-number" };

  const now = opts.now ?? new Date();

  // Cache first: a hit is authoritative and free (never re-calls the paid API).
  const cached = await readCache(phone, now);
  if (cached) return { valid: cached.valid, lineType: cached.lineType, source: "cache" };

  // Miss: call Twilio Lookup v2. Any failure fails OPEN (send anyway) - an
  // availability outage must never stop genuine sends.
  const auth = authHeader(envCreds());
  if (!auth) {
    console.warn("[lookup] no Twilio credentials configured; failing open (allowing the send)");
    return { valid: true, lineType: null, source: "api-error" };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[lookup] Twilio Lookup returned ${res.status} for ${phone}; failing open (allowing the send)`);
      return { valid: true, lineType: null, source: "api-error" };
    }
    const data = (await res.json()) as {
      valid?: boolean;
      line_type_intelligence?: { type?: string | null } | null;
    };
    const lineType = data.line_type_intelligence?.type ?? null;
    const isDeliverable = deliverable(data.valid !== false, lineType);
    // Cache the verdict (valid + invalid alike) so we never re-pay to learn it.
    await writeCache(phone, isDeliverable, lineType, now);
    return { valid: isDeliverable, lineType, source: "api" };
  } catch (err) {
    console.warn(`[lookup] Twilio Lookup call failed for ${phone}; failing open (allowing the send)`, err);
    return { valid: true, lineType: null, source: "api-error" };
  }
}
