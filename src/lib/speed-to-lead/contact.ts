import "server-only";
import { findOrCreateConversation, appendMessage } from "@/lib/agent/repository";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { checkAgentReply } from "@/lib/agent/guardrail";
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
 * No address: skip silently and leave the lead at stage 'new' (a later intake
 * that captures a number can still reach it). No consent for the chosen channel,
 * or the address is suppressed (opted out): the lead can NEVER be contacted, so
 * retire it to the terminal 'lost' stage with the reason recorded on the attempt
 * — otherwise listUncontacted would re-pick it every sweep forever. On send
 * failure: record a 'failed' attempt and leave the stage 'new' so the sweep
 * retries.
 *
 * Shared by the intake route (in-request, for instant contact) and the sweep
 * (the failsafe for anything the intake missed).
 */
export async function contactLead(lead: SpeedToLeadLead, campaign?: CampaignContext): Promise<void> {
  const to = toAddress(lead);
  // No deliverable address yet: nothing to send to and nothing to retire on;
  // leave at 'new' so a later enquiry that supplies an address can be contacted.
  if (!to) return;

  // No consent on the chosen channel: this lead is not contactable and never will
  // be on its own. Record why and retire it to the terminal 'lost' stage so the
  // SLA sweep (listUncontacted) stops re-selecting it every tick.
  if (!channelConsented(lead)) {
    await insertAttempt({
      leadId: lead.id,
      channel: lead.channel,
      toAddress: to,
      body: "Retired: no consent for the chosen channel.",
      status: "failed",
    });
    await setLeadStage(lead.id, "lost");
    return;
  }

  // Honour the opt-out list (a number that texted STOP must never be re-contacted,
  // even via the public intake). Suppression for an unknown lead is keyed on its
  // address; a KNOWN patient's STOP is recorded as patient:<id> by the inbound
  // webhook, so when the lead is matched to a Dentally patient check that ref too.
  const suppressed =
    (await isSuppressed(lead.siteId, lead.channel, to)) ||
    (lead.dentallyPatientId
      ? await isSuppressed(lead.siteId, lead.channel, `patient:${lead.dentallyPatientId}`)
      : false);
  if (suppressed) {
    // Opted out: also terminal. Record the reason and retire to 'lost' so the
    // sweep does not re-pick it forever.
    await insertAttempt({
      leadId: lead.id,
      channel: lead.channel,
      toAddress: to,
      body: "Retired: contact is suppressed (opted out).",
      status: "failed",
    });
    await setLeadStage(lead.id, "lost");
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

  // Output backstop for this direct-send path, which deliberately bypasses the
  // messaging drain (speed matters). The drain applies this same guardrail to
  // EVERY module send; without it here an LLM draft carrying NHS/private/funding
  // jargon or clinical advice would reach a brand-new lead unfiltered. A hit is
  // terminal: log loudly, record a failed attempt, and retire the lead to 'lost'
  // so the SLA sweep does not re-draft-and-block it every tick.
  const guard = checkAgentReply(body, { includePrice: false });
  if (!guard.ok) {
    console.error(
      `[speed-to-lead] lead ${lead.id}: first-contact draft blocked by output guardrail ` +
        `(${guard.category}: ${JSON.stringify(guard.matched)}); not sent`,
    );
    await insertAttempt({
      leadId: lead.id,
      channel: lead.channel,
      toAddress: to,
      body,
      status: "failed",
    });
    await setLeadStage(lead.id, "lost");
    return;
  }

  // Narrow the retryable window to the SEND itself. Only a send failure may leave
  // the lead retryable; a failure in the post-send bookkeeping must NOT, or the
  // sweep would re-text a lead that was already successfully messaged.
  let result: Awaited<ReturnType<typeof sendMessage>>;
  try {
    result = await sendMessage({ channel: lead.channel, to, body });
  } catch {
    // Delivery failed (transient provider error or unreachable on this channel).
    // The drafted message is already logged on the conversation; record the failed
    // attempt and leave the lead retryable (the caller's claim release / the sweep
    // re-picks it up). This is the ONLY path that keeps the lead retryable.
    await insertAttempt({ leadId: lead.id, channel: lead.channel, toAddress: to, body, status: "failed" });
    return;
  }

  // Sent. From here the patient has been texted, so a bookkeeping failure must never
  // reset the lead to retryable. Advance it out of the first-contact window; if a
  // write fails, log loudly and retry the stage advance, but never fall back to a
  // retryable state (a duplicate text is worse than a stuck 'contacting').
  try {
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
  } catch (err) {
    console.error(
      `[speed-to-lead] lead ${lead.id}: SENT but post-send bookkeeping failed; advancing stage anyway to avoid a double-text`,
      err,
    );
    // Best-effort: get the lead out of the retryable window so the caller's claim
    // release / the sweep does not re-send it.
    try {
      await setLeadStage(lead.id, "contacted");
    } catch {
      /* leave as-is; a stuck 'contacting' is preferable to re-texting the patient */
    }
  }
}
