import { serviceClient } from "@/lib/supabase/server";
import type { MessageChannel } from "./types";

// Patient channel preference (table patient_channel_pref, migration 0045).
//
// A patient picks SMS or WhatsApp from a signed /prefs/<token> link. The messaging
// send path honours that preference ONLY where both channels are genuinely viable,
// and WhatsApp is behind its own kill switch - so with WhatsApp off (today) the
// preference changes nothing. Keyed by (site_id, patient_ref) where patient_ref is
// the same `patient:<dentallyId>` form the suppression + touch tables use.

/** The two channels a patient may choose between. */
export type PreferredChannel = "sms" | "whatsapp";

/**
 * The patient's stored channel preference for a site, or null when none is set.
 * Never throws: a read error resolves to null (no preference, honour the default),
 * so a blip in this table can never break a send.
 */
export async function getChannelPref(siteId: string, patientRef: string): Promise<PreferredChannel | null> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("patient_channel_pref")
      .select("preferred_channel")
      .eq("site_id", siteId)
      .eq("patient_ref", patientRef)
      .maybeSingle();
    if (error) throw error;
    const value = (data as { preferred_channel?: string } | null)?.preferred_channel;
    return value === "sms" || value === "whatsapp" ? value : null;
  } catch (err) {
    console.warn(`[channel-pref] read failed for ${siteId}/${patientRef}; ignoring preference`, err);
    return null;
  }
}

/** Store (or update) a patient's channel preference. */
export async function setChannelPref(
  siteId: string,
  patientRef: string,
  preferred: PreferredChannel,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("patient_channel_pref")
    .upsert(
      { site_id: siteId, patient_ref: patientRef, preferred_channel: preferred, updated_at: new Date().toISOString() },
      { onConflict: "site_id,patient_ref" },
    );
  if (error) throw error;
}

/**
 * The channel a message should actually go out on, given the queued channel and
 * the patient's stored preference.
 *
 * Pure and conservative:
 *   - No preference, or an email message: unchanged (never re-route an email).
 *   - Prefers WhatsApp: honoured ONLY when WhatsApp is live (whatsappEnabled). With
 *     WhatsApp off this returns the queued channel, so nothing changes today.
 *   - Prefers SMS: always honoured (SMS is always viable for a mobile).
 *
 * SMS and WhatsApp address the same handset and a STOP suppresses both channels,
 * so swapping between them is address- and opt-out-safe.
 */
export function resolvePreferredChannel(
  requested: MessageChannel,
  preferred: PreferredChannel | null,
  whatsappEnabled: boolean,
): MessageChannel {
  if (!preferred) return requested;
  if (requested === "email") return requested;
  if (preferred === "whatsapp") return whatsappEnabled ? "whatsapp" : requested;
  // preferred === "sms": always deliverable to a mobile.
  return "sms";
}
