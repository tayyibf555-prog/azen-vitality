import { serviceClient } from "@/lib/supabase/server";

// Cross-module outbound frequency cap. The shared drain calls wasContactedToday before
// sending an OUTREACH row and recordContacted after any successful send, so at most one
// outreach message reaches a recipient per Europe/London day across ALL modules. Keyed
// by the resolved address (dedupes SMS + WhatsApp on the same number). See migration
// 0036_message_daily_log.

/**
 * Whether this recipient address already received an outbound message today (the given
 * `YYYY-MM-DD` Europe/London day) from ANY module.
 *
 * Fail-OPEN: on a DB error this returns false (allow the send) rather than blocking. The
 * cap reduces message fatigue, it is not a safety gate like consent/STOP suppression, so
 * a message_daily_log blip must never halt delivery — matching the owner kill switch's
 * fail-open posture.
 */
export async function wasContactedToday(siteId: string, address: string, day: string): Promise<boolean> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("message_daily_log")
      .select("id")
      .eq("site_id", siteId)
      .eq("address", address)
      .eq("sent_on", day)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  } catch (err) {
    console.error(`[frequency] wasContactedToday failed for ${address} on ${day}; failing open (allowing the send)`, err);
    return false;
  }
}

/**
 * Record that this recipient was messaged today, so later sources in the same drain run
 * and later ticks apply the once-per-day cap. Upsert on (site_id, address, sent_on) so a
 * second send the same day is a no-op write. Best-effort: a failure here never fails the
 * send that already went out (it only means the cap may not apply to the next message).
 */
export async function recordContacted(siteId: string, address: string, day: string, source: string): Promise<void> {
  try {
    const db = serviceClient();
    const { error } = await db
      .from("message_daily_log")
      .upsert({ site_id: siteId, address, sent_on: day, source }, { onConflict: "site_id,address,sent_on" });
    if (error) throw error;
  } catch (err) {
    console.error(`[frequency] recordContacted failed for ${address} on ${day}; the daily cap may not apply to the next send`, err);
  }
}
