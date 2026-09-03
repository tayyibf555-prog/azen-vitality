import "server-only";
import { findOrCreateConversation, appendMessage } from "@/lib/agent/repository";
import { sendMessage } from "@/lib/messaging/send";
import { recordContacted } from "@/lib/messaging/frequency";
import { londonDayKey } from "@/lib/time/london";
import { isSuppressed } from "@/lib/messaging/suppression";
import { validateMobile } from "@/lib/messaging/lookup";
import { validateEmail } from "@/lib/messaging/email-lookup";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { getClient, getSite } from "@/lib/mock/clients";
import { latestResponseByLead } from "@/lib/smile-assessment/repository";
import { answerLines } from "@/lib/smile-assessment/summary";
import { getCampaignFollowUp } from "@/lib/smile-assessment/campaign-repository";
import { firstTouchOverride, renderFollowUpTemplate } from "@/lib/smile-assessment/follow-up";
import { draftFirstContact, type CampaignContext } from "./draft";
import { isWhatsappConfigured } from "@/lib/messaging/providers/twilio";
import {
  insertAttempt,
  listAttempts,
  recordFirstResponse,
  setLeadStage,
} from "./repository";

/**
 * Stop re-drafting after this many failed delivery attempts on one lead.
 *
 * A failed send leaves the lead retryable at stage 'new', and listUncontacted
 * re-picks it on every sweep tick for a 48 hour window. Each pick calls the model
 * to draft the message BEFORE attempting delivery, so a lead that can never be
 * delivered costs a model call per tick, thousands of them, in silence.
 */
const MAX_FAILED_CONTACT_ATTEMPTS = 3;
import type { LeadChannel, SpeedToLeadLead } from "./types";

/** The address a given first-contact channel sends to, or null if missing. */
export function toAddress(lead: SpeedToLeadLead): string | null {
  if (lead.channel === "email") return lead.email;
  return lead.phone; // sms + whatsapp
}

/** Whether the lead consented to be contacted on its chosen channel. */
export function channelConsented(lead: SpeedToLeadLead): boolean {
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
 *
 * It does NOT consult the cross-module daily cap, and it DOES stamp it — see the
 * ruling quoted at the send site below.
 */
export async function contactLead(lead: SpeedToLeadLead, campaign?: CampaignContext): Promise<void> {
  // Dead-channel guard, applied FIRST so every downstream use of lead.channel
  // (address, consent, suppression, draft, send, attempt) sees the real channel.
  // A lead queued for WhatsApp when no WhatsApp sender is configured can never be
  // delivered, and the failure path below leaves it retryable, so the sweep would
  // re-draft it every tick for 48 hours. sms and whatsapp reach the same handset and
  // a STOP suppresses both, so downgrading is opt-out-safe. It is also STRICTER on
  // consent (it now needs sms consent rather than either), which fails the safe way.
  if (lead.channel === "whatsapp" && !isWhatsappConfigured()) {
    console.warn(
      `[speed-to-lead] lead ${lead.id} is queued for WhatsApp but no WhatsApp sender is configured; contacting by SMS`,
    );
    lead = { ...lead, channel: "sms" };
  }

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

  // Pre-send deliverability validation (both dormant by default). An address that
  // can never receive this first contact means we retire the lead to the terminal
  // 'lost' stage (the same blocked/skip outcome as no-consent/suppressed above)
  // rather than drafting and sending into a void or leaving it for the SLA sweep to
  // re-pick forever. It is NEVER recorded as a failed send, and either validator
  // fails OPEN on an API error so an outage never blocks a genuine first contact.
  //   - Phone: Twilio Lookup (dormant unless TWILIO_LOOKUP_ENABLED) - a landline or
  //     otherwise undeliverable number.
  //   - Email: NeverBounce (dormant unless NEVERBOUNCE_API_KEY + EMAIL_LOOKUP_ENABLED)
  //     - an invalid or disposable address; catchall/unknown pass.
  if (lead.channel !== "email") {
    const check = await validateMobile(to);
    if (!check.valid) {
      console.warn(
        `[speed-to-lead] lead ${lead.id}: ${to} is not a deliverable mobile ` +
          `(${check.lineType ?? "invalid-number"}); retiring to 'lost' pre-send, not contacted`,
      );
      await setLeadStage(lead.id, "lost");
      return;
    }
  } else {
    const check = await validateEmail(to);
    if (!check.valid) {
      console.warn(
        `[speed-to-lead] lead ${lead.id}: ${to} is not a deliverable email ` +
          `(${check.verdict ?? "invalid-address"}); retiring to 'lost' pre-send, not contacted`,
      );
      await setLeadStage(lead.id, "lost");
      return;
    }
  }

  const clientId = getSite(lead.siteId)?.clientId ?? "";
  const client = getClient(clientId);

  // Ground the draft in the lead's own smile-assessment answers when they have
  // one (timeline, readiness, region). Looked up here, not passed in, so EVERY
  // first-contact path gets it: the submit bridge, the intake route, and the SLA
  // sweep. Best-effort: a failed lookup just means a more generic first text.
  //
  // THE SAME LOOKUP ANSWERS THE SECOND QUESTION (0082): does the campaign this
  // enquiry came through have its OWN first-touch wording? Resolved HERE rather
  // than passed in by the submit route, for exactly the reason the assessment
  // context is: there are four ways into this function (the submit bridge, the
  // intake route, the missed-call bridge and the SLA sweep's retry), and an
  // override that only held on one of them would mean a lead whose first send
  // failed silently got a different message on the retry from the one its owner
  // wrote. The response already carries the campaign id, so this costs one scoped
  // read, and only for a lead that came through an assessment at all.
  let assessment: string[] | undefined;
  let firstTouch: string | null = null;
  try {
    const response = await latestResponseByLead(lead.id);
    const lines = answerLines(response?.responses);
    if (lines.length > 0) assessment = lines;
    if (response?.campaignId) {
      // Never throws: an un-applied 0082, a deleted campaign or a database blip
      // all resolve to the OFF config, i.e. "draft it", i.e. today.
      firstTouch = firstTouchOverride(await getCampaignFollowUp(clientId, response.campaignId));
    }
  } catch {
    /* context only; never block the first contact */
  }

  // Retry cap, checked immediately BEFORE the message is composed so a doomed lead
  // costs at most MAX_FAILED_CONTACT_ATTEMPTS drafts rather than one per sweep tick
  // for 48 hours. It is checked for an owner-written override too: the cap is about
  // a contact that cannot be DELIVERED, which is a property of the address and not
  // of who wrote the words. The lead is deliberately left at 'new' and visible in
  // the worklist: a delivery problem is something a human should look at, not
  // something to hide.
  try {
    const priorFailures = (await listAttempts(lead.id)).filter((a) => a.status === "failed").length;
    if (priorFailures >= MAX_FAILED_CONTACT_ATTEMPTS) {
      console.warn(
        `[speed-to-lead] lead ${lead.id} has ${priorFailures} failed delivery attempts; not drafting again, needs a human`,
      );
      return;
    }
  } catch {
    /* best effort only: a failed attempts read must never block a first contact */
  }

  // THE SEAM WHERE THE FIRST MESSAGE'S TEXT IS CHOSEN, and after 0082 it has two
  // sources rather than one. An override is the practice's OWN wording, cleared at
  // write time by the same compliance scan the funnel copy goes through PLUS this
  // path's own output guardrail (follow-up.ts explains why the write gate is a
  // superset of the send gate), so it is substitution and nothing else — no model
  // call, no cost, no variance.
  //
  // EVERYTHING BELOW THIS LINE IS IDENTICAL FOR BOTH SOURCES, and that is the
  // point of choosing here rather than earlier. The conversation threading, the
  // guardrail backstop, the Twilio status callback, the send, the attempt record,
  // the first-response stamp and the stage advance do not know or care who wrote
  // the words. Nor do the four gates ABOVE this line: consent, suppression,
  // deliverability and the retry cap have already been consulted, and an override
  // cannot reach a patient that a drafted message could not have reached.
  const body = firstTouch
    ? renderFollowUpTemplate(firstTouch, { name: lead.name, practice: client?.name })
    : (await draftFirstContact(lead, lead.channel, client, campaign, assessment)).body;

  // Thread an agent conversation keyed `lead:<phone>` so a reply on Twilio's
  // inbound webhook (which keys unknown numbers `lead:${from}`) routes here.
  // Email leads have no inbound channel yet, so the conversation is logged as sms.
  const convChannel: LeadChannel = lead.channel === "email" ? "sms" : lead.channel;
  const conversation = await findOrCreateConversation({
    siteId: lead.siteId,
    // A Dentally-KNOWN patient must be threaded under their PATIENT id: the
    // inbound webhook resolves their reply by phone to that same id, so keying
    // this conversation `lead:<phone>` would FORK the thread — the agent would
    // answer with no enquiry context and the lead's timeline would never show
    // the reply. Unknown leads keep the `lead:` key the webhook uses for them.
    dentallyPatientId: lead.dentallyPatientId ?? `lead:${lead.phone ?? lead.email ?? lead.id}`,
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
  // Attach the Twilio StatusCallback (sms/whatsapp only) so a delivery FAILURE for this
  // direct send is reported back to /api/webhooks/twilio/status, which resets the lead
  // to retryable. Without it, the undelivered-retry path is dead: a lead whose first SMS
  // silently fails downstream is never re-contacted. Mirrors the drain; only attached
  // when PUBLIC_BASE_URL is a real https endpoint (deployed app / tunnel).
  const base = process.env.PUBLIC_BASE_URL ?? "";
  const statusCallbackUrl =
    lead.channel === "email" || !base.startsWith("https://")
      ? undefined
      : `${base}/api/webhooks/twilio/status`;

  let result: Awaited<ReturnType<typeof sendMessage>>;
  try {
    result = await sendMessage({ channel: lead.channel, to, body, statusCallbackUrl });
  } catch {
    // Delivery failed (transient provider error or unreachable on this channel).
    // The drafted message is already logged on the conversation; record the failed
    // attempt and leave the lead retryable (the caller's claim release / the sweep
    // re-picks it up). This is the ONLY path that keeps the lead retryable.
    await insertAttempt({ leadId: lead.id, channel: lead.channel, toAddress: to, body, status: "failed" });
    return;
  }

  // ── RULING W2-C/2 (3 Sep 2026), the anti-overlap daily cap ──────────────────
  // A speed-to-lead first contact is a REPLY to an inbound enquiry, so it sits on
  // one side of the cap only:
  //
  //   IT DOES NOT CONSULT IT. A patient who has just asked us something must be
  //   answered, whatever unsolicited text some other sweep sent them earlier the
  //   same day. There is deliberately no wasContactedToday call anywhere above.
  //
  //   IT MUST STAMP IT. Once we have replied, the UNSOLICITED sweeps — recall,
  //   reactivation, no-show, coordinator, closer, collection, post-op — hold off
  //   for the rest of the London day, because they all read this same log before
  //   they send (src/app/api/messaging/drain/route.ts, src/lib/messaging/
  //   frequency.ts, message_daily_log). Without the stamp, a lead who enquired at
  //   nine could be chased by a recall text at ten.
  //
  // Keyed exactly as the sweeps key it: site + the canonical address (E.164 for
  // sms/whatsapp, lower-cased email — leads are normalised at every intake
  // boundary by src/lib/messaging/phone.ts) + the London day. A brand-new
  // enquirer has no patient id, and needs none: the cap has never been keyed on
  // one.
  //
  // Stamped BEFORE the rest of the bookkeeping and outside its try, so a failed
  // insertAttempt cannot cost the patient the quiet afternoon the stamp buys.
  // recordContacted swallows its own errors (the cap is fatigue control, not a
  // safety gate) so this can neither throw nor delay the send that already went.
  await recordContacted(lead.siteId, to, londonDayKey(new Date()), "speed-to-lead");

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
