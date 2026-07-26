import { serviceClient } from "@/lib/supabase/server";
import { effectiveMaxLapseMonths } from "./normalise";

// The owner-set daily contact limit for reactivation (table reactivation_settings,
// migration 0038). Caps how many automated reactivation messages are queued per
// Europe/London day, so enrolling a large cohort can never flood patients with
// texts. The sweep enforces it; the settings API reads/writes it.

/** Applied when the owner has not set a value (or the read fails). Deliberately
 *  conservative for a 16k-target cohort; the owner can raise it up to the max. */
export const DEFAULT_DAILY_CONTACT_LIMIT = 25;
export const MAX_DAILY_CONTACT_LIMIT = 500;

function londonDay(now: Date): string {
  // en-CA renders YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}

/**
 * The UTC instant of today's midnight in Europe/London, as ISO. DST-correct: tries
 * both possible UK offsets and keeps the candidate that actually renders as 00:00
 * on today's London date.
 */
export function londonDayStartIso(now: Date): string {
  const day = londonDay(now);
  for (const offset of ["+01:00", "+00:00"]) {
    const candidate = new Date(`${day}T00:00:00${offset}`);
    const rendered = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(candidate);
    const d = `${rendered.find((p) => p.type === "year")?.value}-${rendered.find((p) => p.type === "month")?.value}-${rendered.find((p) => p.type === "day")?.value}`;
    const h = rendered.find((p) => p.type === "hour")?.value;
    if (d === day && (h === "00" || h === "24")) return candidate.toISOString();
  }
  // Unreachable for the UK, but never throw over a date computation.
  return new Date(`${day}T00:00:00Z`).toISOString();
}

/**
 * The daily contact limit for a client. Fail-SAFE: any read error returns the
 * conservative default, never "unlimited".
 */
export async function getDailyContactLimit(clientId: string): Promise<number> {
  try {
    const { data, error } = await serviceClient()
      .from("reactivation_settings")
      .select("daily_contact_limit")
      .eq("client_id", clientId)
      .maybeSingle();
    if (error) throw error;
    const n = (data as { daily_contact_limit?: unknown } | null)?.daily_contact_limit;
    return typeof n === "number" && Number.isFinite(n) && n >= 0
      ? Math.min(n, MAX_DAILY_CONTACT_LIMIT)
      : DEFAULT_DAILY_CONTACT_LIMIT;
  } catch (err) {
    console.error(`[reactivation] getDailyContactLimit(${clientId}) failed; using default ${DEFAULT_DAILY_CONTACT_LIMIT}`, err);
    return DEFAULT_DAILY_CONTACT_LIMIT;
  }
}

/**
 * The practice's maximum lapse, in months, above which a patient is too cold to
 * contact. UNLIMITED unless somebody sets one: the client asked for every lapsed
 * patient to be reachable, and the outer edge is a business call they can make
 * later without a code change.
 *
 * Precedence: the client's own reactivation_settings.max_lapse_months, else the
 * deployment-wide REACTIVATION_MAX_LAPSE_MONTHS, else unlimited.
 *
 * Reads the whole row rather than the single column so this keeps working before
 * the column exists, and degrades to the default on any read failure. That is NOT
 * a hole in the safety story: how many patients are actually messaged is bounded by
 * the daily contact limit, the per-run enrolment ceiling and the kill switch, none
 * of which this touches.
 */
export async function getMaxLapseMonths(clientId: string): Promise<number> {
  try {
    const { data } = await serviceClient()
      .from("reactivation_settings")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();
    const raw = (data as { max_lapse_months?: unknown } | null)?.max_lapse_months;
    if (typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "")) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (err) {
    console.error(`[reactivation] getMaxLapseMonths(${clientId}) failed; using the deployment default`, err);
  }
  return effectiveMaxLapseMonths();
}

export async function setDailyContactLimit(clientId: string, limit: number): Promise<void> {
  const { error } = await serviceClient()
    .from("reactivation_settings")
    .upsert(
      { client_id: clientId, daily_contact_limit: limit, updated_at: new Date().toISOString() },
      { onConflict: "client_id" },
    );
  if (error) throw error;
}

/**
 * How many reactivation messages have been queued so far today (Europe/London).
 * Counts reactivation_outbox rows created since London midnight — every queued
 * message counts, whether the sweep queued it or a human approved it, so manual
 * sends tighten the remaining automated budget rather than bypassing it.
 * On error returns 0 (the cap still applies from zero; never blocks on a blip).
 */
export async function countContactedToday(now: Date): Promise<number> {
  try {
    const { count, error } = await serviceClient()
      .from("reactivation_outbox")
      .select("id", { count: "exact", head: true })
      .gte("created_at", londonDayStartIso(now));
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    console.error("[reactivation] countContactedToday failed; assuming 0 used (cap still applies)", err);
    return 0;
  }
}
