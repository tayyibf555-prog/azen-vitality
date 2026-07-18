import { serviceClient } from "@/lib/supabase/server";
import type { MessageChannel } from "./types";

const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

export function isStopKeyword(body: string): boolean {
  return STOP_KEYWORDS.has(body.trim().toLowerCase());
}

export async function isSuppressed(siteId: string, channel: MessageChannel, toRef: string): Promise<boolean> {
  const db = serviceClient();
  const { data, error } = await db
    .from("message_suppression")
    .select("id")
    .eq("site_id", siteId)
    .eq("channel", channel)
    .eq("to_ref", toRef)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function addSuppression(
  siteId: string,
  channel: MessageChannel,
  toRef: string,
  reason = "stop",
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("message_suppression")
    .upsert({ site_id: siteId, channel, to_ref: toRef, reason }, { onConflict: "site_id,channel,to_ref" });
  if (error) throw error;
}

/** The reason marker for suppression rows created by an admin "Do not contact" status.
 *  Kept distinct from 'stop' so clearing the admin status can remove ONLY these rows and
 *  never a patient's own opt-out. */
export const ADMIN_DNC_REASON = "admin_do_not_contact";

/** Every deliverable channel a "Do not contact" must cover. All three are suppressed so
 *  the promise made in the UI ("no messages at all") holds for SMS, email AND WhatsApp,
 *  even though WhatsApp sits behind its own kill switch today. */
const ADMIN_DNC_CHANNELS: MessageChannel[] = ["sms", "email", "whatsapp"];

/**
 * Mark a patient ref "Do not contact": add an admin suppression row on every channel.
 *
 * STOP-safe: uses INSERT ... ON CONFLICT DO NOTHING (ignoreDuplicates), so an existing
 * row is left untouched. That matters because a patient may ALSO have texted STOP - we
 * must never overwrite that 'stop' row's reason with 'admin_do_not_contact', or clearing
 * the admin status later would silently delete their genuine opt-out. Either row keeps
 * them suppressed while both are in force, so nothing slips through in the meantime.
 */
export async function addAdminDoNotContact(siteId: string, patientRef: string): Promise<void> {
  const db = serviceClient();
  const rows = ADMIN_DNC_CHANNELS.map((channel) => ({
    site_id: siteId,
    channel,
    to_ref: patientRef,
    reason: ADMIN_DNC_REASON,
  }));
  const { error } = await db
    .from("message_suppression")
    .upsert(rows, { onConflict: "site_id,channel,to_ref", ignoreDuplicates: true });
  if (error) throw error;
}

/**
 * Clear an admin "Do not contact": delete ONLY this patient's admin_do_not_contact rows.
 * The reason filter is load-bearing - a patient's own STOP ('stop') row is never touched,
 * so lifting the admin status can never un-suppress someone who genuinely opted out.
 */
export async function clearAdminDoNotContact(siteId: string, patientRef: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("message_suppression")
    .delete()
    .eq("site_id", siteId)
    .eq("to_ref", patientRef)
    .eq("reason", ADMIN_DNC_REASON);
  if (error) throw error;
}
