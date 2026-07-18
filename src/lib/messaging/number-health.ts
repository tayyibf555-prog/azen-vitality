import { serviceClient } from "@/lib/supabase/server";
import { toE164 } from "./phone";

// Number-health read-back for the patient record.
//
// The Twilio Lookup pre-send validation accumulates one verdict per E.164 number in
// phone_lookup (migration 0045) as it drains sends. This module READS those verdicts
// so the owner can see, on a patient's record, whether their number is a real mobile,
// a landline we would never text, or simply not validated yet.
//
// STRICTLY READ-ONLY. It never calls Twilio and never writes a verdict; it only reads
// what the send path has already learned. A read failure degrades to "unchecked" (a
// health hint is never a gate). It reuses the SAME toE164 normalisation the send path
// uses, so a raw national number (07700 900123) matches the +447700900123 key the
// cache stores.

/**
 * A patient number's deliverability health:
 *   - "mobile":        a real mobile/VoIP that can receive a text (cached valid=true).
 *   - "undeliverable": a landline/invalid number a send would be blocked on (valid=false).
 *   - "unchecked":     a usable number with no verdict on file yet (never validated).
 *   - "none":          no usable number on file at all.
 */
export type NumberHealthState = "mobile" | "undeliverable" | "unchecked" | "none";

export interface NumberHealth {
  state: NumberHealthState;
  /** Twilio's line type when known (e.g. "landline"), for the undeliverable caption. */
  lineType: string | null;
}

/** A phone_lookup verdict: our deliverability boolean plus the line type when known. */
export interface PhoneVerdict {
  valid: boolean;
  lineType: string | null;
}

const NONE: NumberHealth = { state: "none", lineType: null };
const UNCHECKED: NumberHealth = { state: "unchecked", lineType: null };

/**
 * Classify a raw phone + its phone_lookup verdict into a display health. Pure: no I/O.
 * An unnormalisable/absent number is "none"; a normalisable number with no verdict is
 * "unchecked"; otherwise the cached `valid` boolean is authoritative (the send path
 * already folds line-type into it - a landline is stored valid=false), so valid maps
 * to "mobile" and invalid to "undeliverable".
 */
export function classifyNumberHealth(
  rawPhone: string | null | undefined,
  verdict: PhoneVerdict | null,
): NumberHealth {
  if (!toE164(rawPhone)) return NONE;
  if (!verdict) return UNCHECKED;
  return verdict.valid
    ? { state: "mobile", lineType: verdict.lineType }
    : { state: "undeliverable", lineType: verdict.lineType };
}

/**
 * Batch-read deliverability verdicts for many raw phones in ONE query. Each phone is
 * normalised via the SAME toE164 the send path uses (so a raw 07... matches the +447...
 * cache key), then deduped. Returns a map keyed by E.164. Never throws: a read failure
 * yields an empty map (every number then reads as "unchecked"), because this is a
 * read-only hint, never a gate.
 */
export async function loadPhoneVerdicts(
  rawPhones: Array<string | null | undefined>,
): Promise<Map<string, PhoneVerdict>> {
  const e164s = Array.from(
    new Set(rawPhones.map((p) => toE164(p)).filter((p): p is string => p !== null)),
  );
  const out = new Map<string, PhoneVerdict>();
  if (e164s.length === 0) return out;
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("phone_lookup")
      .select("phone, valid, line_type")
      .in("phone", e164s);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ phone: string; valid: boolean; line_type: string | null }>) {
      out.set(r.phone, { valid: Boolean(r.valid), lineType: r.line_type ?? null });
    }
  } catch (err) {
    console.warn("[number-health] batch verdict read failed; treating all as unchecked", err);
  }
  return out;
}

/**
 * The number health for a set of people, keyed by their id, in ONE query. For the
 * patients list: pass the visible slice and pass the result straight to the drawer so
 * a record opens with its chip already resolved (no per-row query).
 */
export async function loadNumberHealthByPatient(
  people: Array<{ id: string; phone: string | null }>,
): Promise<Record<string, NumberHealth>> {
  const verdicts = await loadPhoneVerdicts(people.map((p) => p.phone));
  const out: Record<string, NumberHealth> = {};
  for (const person of people) {
    const e164 = toE164(person.phone);
    out[person.id] = classifyNumberHealth(person.phone, e164 ? verdicts.get(e164) ?? null : null);
  }
  return out;
}

/**
 * One number's health, by its raw form. Used by the patient-detail endpoint so a
 * record opened from search/filter (beyond the batched list slice) still resolves an
 * accurate chip. At most one verdict read; "none" for an absent/garbage number
 * short-circuits before any query.
 */
export async function numberHealthFor(rawPhone: string | null | undefined): Promise<NumberHealth> {
  const e164 = toE164(rawPhone);
  if (!e164) return NONE;
  const verdicts = await loadPhoneVerdicts([rawPhone]);
  return classifyNumberHealth(rawPhone, verdicts.get(e164) ?? null);
}
