import "server-only";
import { findOrCreateConversation, appendMessage } from "@/lib/agent/repository";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { getClient, getSite } from "@/lib/mock/clients";
import { draftFirstContact, type CampaignContext } from "./draft";
import {
  insertAttempt,
  recordFirstResponse,
  setLeadStage,
} from "./repository";
import type { LeadChannel, SpeedToLeadLead } from "./types";

/** The address a given first-contact channel sends to, or null if missing. */
function toAddress(lead: SpeedToLeadLead): string | null {
  if (lead.channel === "email") return lead.email;
  return lead.phone; // sms + whatsapp
}

/** Whether the lead consented to be contacted on its chosen channel. */
function channelConsented(lead: SpeedToLeadLead): boolean {
  if (lead.channel === "email") return lead.consent.email === true;
  if (lead.channel === "whatsapp") return lead.consent.whatsapp === true || lead.consent.sms === true;
  return lead.consent.sms === true;
}

/**
 * First-contact a brand new lead, instantly.
 *
 * Drafts a warm first message with Claude, threads an agent conversation keyed
 * `lead:<phone>` (the SAME id the inbound Twilio webhook uses for an unknown
 * number, so the lead's reply lands back in this conversation and the booking
 * agent picks it up), sends the message DIRECTLY (speed matters, not the drain),
 * and stamps first_response_at + advances the stage to 'contacted'.
 *
 * No consent for the chosen channel, or no address: skip silently and leave the
 * lead at stage 'new' (nothing recorded). On send failure: record a 'failed'
 * attempt and leave the stage 'new' so the SLA sweep retries.
 *
 * Shared by the intake route (in-request, for instant contact) and the sweep
 * (the failsafe for anything the intake missed).
 */
export async function contactLead(lead: SpeedToLeadLead, campaign?: CampaignContext): Promise<void> {
  const to = toAddress(lead);
  if (!to || !channelConsented(lead)) return;

  // Honour the opt-out list (a number that texted STOP must never be re-contacted,
  // even via the public intake). Suppression for a lead is keyed on its address.
  if (await isSuppressed(lead.siteId, lead.channel, to)) {
    await insertAttempt({ leadId: lead.id, channel: lead.channel, toAddress: to, body: "", status: "failed" });
    return;
  }

  const client = getClient(getSite(lead.siteId)?.clientId ?? "");
  const { body } = await draftFirstContact(lead, lead.channel, client, campaign);

  // Thread an agent conversation keyed `lead:<phone>` so a reply on Twilio's
  // inbound webhook (which keys unknown numbers `lead:${from}`) routes here.
  // Email leads have no inbound channel yet, so the conversation is logged as sms.
  const convChannel: LeadChannel = lead.channel === "email" ? "sms" : lead.channel;
  const conversation = await findOrCreateConversation({
    siteId: lead.siteId,
    dentallyPatientId: `lead:${lead.phone ?? lead.email ?? lead.id}`,
    patientName: lead.name,
    channel: convChannel,
    treatment: lead.treatmentInterest,
    fundingType: null,
  });
  await appendMessage({ conversationId: conversation.id, role: "agent", body });

  try {
    const result = await sendMessage({ channel: lead.channel, to, body });
    await insertAttempt({
      leadId: lead.id,
      channel: lead.channel,
      toAddress: to,
      body,
      status: "sent",
      provider: result.provider,
      providerMessageId: result.providerMessageId,
    });
    // Stamp first-response only once, so a staff 'resend' never corrupts the
    // first-response-time SLA metric.
    if (!lead.firstResponseAt) {
      await recordFirstResponse(lead.id, {
        firstResponseAt: new Date().toISOString(),
        conversationId: conversation.id,
      });
    }
    await setLeadStage(lead.id, "contacted");
  } catch {
    // Delivery failed (transient provider error or unreachable on this channel).
    // The drafted message is already logged on the conversation; record the
    // failed attempt and leave the lead at 'new' so the sweep retries it.
    await insertAttempt({
      leadId: lead.id,
      channel: lead.channel,
      toAddress: to,
      body,
      status: "failed",
    });
  }
}
