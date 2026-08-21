import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { isStopKeyword, addSuppression, isSuppressed } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  findTargetByAddress,
  insertInboundTouch,
  getCadenceByTarget,
  updateCadence,
  getTargetContext,
} from "@/lib/reactivation/repository";
import {
  findTargetByAddress as findRecallTargetByAddress,
  getCadenceByTarget as getRecallCadenceByTarget,
  updateCadence as updateRecallCadence,
  insertInboundTouch as insertRecallInboundTouch,
} from "@/lib/recall/repository";
import {
  findTargetByAddress as findOutreachTargetByAddress,
  insertInboundTouch as insertOutreachInboundTouch,
  markOutreachReplied,
  markOutreachBookedByAddress,
  getCampaignIdForTarget as getOutreachCampaignIdForTarget,
  getCampaign as getOutreachCampaign,
  getTarget as getOutreachTarget,
} from "@/lib/outreach/repository";
import type { OutreachTarget, OutreachTargetStatus } from "@/lib/outreach/types";
import { handleNoshowInbound } from "@/lib/noshow/inbound";
import { handlePostopInbound } from "@/lib/postop/inbound";
import {
  findTargetByAddress as findCoordinatorTargetByAddress,
  insertInboundTouch as insertCoordinatorInboundTouch,
} from "@/lib/coordinator/repository";
import {
  findTargetByAddress as findCloserTargetByAddress,
  insertInboundTouch as insertCloserInboundTouch,
  stopOpportunity as stopCloserOpportunity,
} from "@/lib/closer/repository";
import { classifyInboundReply } from "@/lib/closer/cadence";
import {
  findTargetByAddress as findCollectionTargetByAddress,
  insertInboundTouch as insertCollectionInboundTouch,
  stopTarget as stopCollectionTarget,
} from "@/lib/collection/repository";
import {
  classifyCollectionReply,
  stopReasonForReply,
  escalationForReply,
} from "@/lib/collection/cadence";
import { isOutsideHours, getSiteById } from "@/lib/after-hours/hours";
import { insertCapture, hasOpenCaptureFrom } from "@/lib/after-hours/repository";
import Anthropic from "@anthropic-ai/sdk";
import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { getSite, getSites, getClient } from "@/lib/mock/clients";
import { findLeadByConversation, setLeadStage } from "@/lib/speed-to-lead/repository";
import { latestResponseByLead } from "@/lib/smile-assessment/repository";
import { answerLines } from "@/lib/smile-assessment/summary";
import { listActiveUspTexts } from "@/lib/usp/repository";
import { AGENT_TOOLS, makeDispatch } from "@/lib/agent/tools";
import { runAgentTurn } from "@/lib/agent/run";
import { dentallyAgentClient } from "@/lib/dentally/write";
import { identifyByPhone } from "@/lib/agent/identify";
import { checkAgentReply, SAFE_HANDOVER } from "@/lib/agent/guardrail";
import { alertStaffHandover, type HandoverReason } from "@/lib/agent/alerts";
import { claimInboundMessage } from "@/lib/agent/idempotency";
import { tryAcquireLease, releaseCronLock } from "@/lib/cron-lock";
import { consumeBudget } from "@/lib/rate-budget";
import {
  findOrCreateConversation,
  listMessages,
  appendMessage,
  setConversationStatus,
  setConversationName,
  stampInbound,
  isAgentEnabled,
  upsertPhoneIdentity,
} from "@/lib/agent/repository";
import type { AgentContext, PhoneIdentity } from "@/lib/agent/types";
import { chooseReplyContext } from "@/lib/agent/reply-context";
import { collectReplyContext } from "@/lib/agent/reply-context-repository";
import { isSystemEnabled, isSystemEnabledForSend } from "@/lib/systems/repository";
import { serviceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Site to attribute an inbound from an unrecognised number to (one practice
// number serves every site in this pilot). Overridable per deployment.
const DEFAULT_SITE_ID = process.env.AGENT_DEFAULT_SITE_ID ?? "site-cc";

// Per-sender cost/rate ceiling on the agent turn. A spammer texting the practice
// number must not be able to run unbounded Claude tool-loops. Matches the
// consumeBudget() guard the sibling public AI endpoints use. Overridable.
const SENDER_BUDGET_LIMIT = Number(process.env.AGENT_SENDER_BUDGET_LIMIT ?? "20");
const SENDER_BUDGET_WINDOW_SECONDS = Number(process.env.AGENT_SENDER_BUDGET_WINDOW ?? "3600");

// How much of the thread the MODEL is shown. The staff inbox still renders the
// whole conversation; this bounds only what is re-sent to Claude on every round of
// every turn.
//
// A conversation is per (site, patient, channel) and lives until it is closed, so
// a returning patient's thread accumulates for years: first contact, nurture
// touches, every booking and change, and up to SENDER_BUDGET_LIMIT (20) agent
// turns an hour on top. Unbounded, that is a bill that only grows, on a table that
// only grows.
//
// 60 messages is 30 exchanges — deliberately far past any real booking
// conversation (the guardrail hands a stuck thread to a human long before then,
// and the per-sender budget caps a single hour at 20 turns), so this trims a tail
// nobody reaches rather than shortening the agent's memory of a live chat.
const AGENT_HISTORY_MESSAGES = Number(process.env.AGENT_HISTORY_MESSAGES ?? "60");

// Segment-outreach reply-linkage guards (see the linkage block in POST). Only an
// ACTIVE, RECENT campaign target may be regressed to 'replied' and used to prime the
// booking agent - mirrors how recall/reactivation pause ONLY an active cadence.
const OUTREACH_ACTIVE_STATES = new Set<OutreachTargetStatus>(["pending", "queued", "contacted"]);
// A reply-to-outbound correlation older than this is stale (an unrelated later
// inbound that merely address-matches a long-finished campaign): do not regress or
// prime on it. Comfortably covers the outreach cadence window (roughly days 0/3/10).
const OUTREACH_MATCH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether the matched outreach target's last cadence activity is recent enough that
 * this inbound plausibly answers it (vs a stale, long-finished campaign match). Uses
 * the most recent available activity timestamp; an active target's last update is its
 * last send/advance.
 */
function outreachMatchRecent(target: OutreachTarget, nowMs: number): boolean {
  const ts = target.updatedAt ?? target.startedAt ?? target.createdAt ?? null;
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) && nowMs - t <= OUTREACH_MATCH_MAX_AGE_MS;
}

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

/**
 * Tell the agent which channel this conversation is actually on. The same agent
 * answers SMS and WhatsApp, so a fixed "you speak by SMS" line has it offering to
 * text a patient who is messaging on WhatsApp, which reads as though we have lost
 * track of who we are talking to. Appended last so it settles the question.
 */
function channelPromptNote(channel: MessageChannel): string {
  if (channel === "whatsapp") {
    return [
      "CHANNEL: this conversation is happening on WhatsApp, not by text message.",
      "Where anything above says SMS or text, it means this WhatsApp thread. Never tell them you will text or SMS them; say you will message them here.",
    ].join(" ");
  }
  return "CHANNEL: this conversation is happening by text message (SMS). Reply as a text message.";
}

/**
 * Re-key a conversation onto a new Dentally patient id.
 *
 * When the agent registers a brand new patient mid-thread, that person's id
 * changes from the "lead:<number>" placeholder to a real Dentally id. Threads are
 * found by (site, patient id, channel), so without this their next message opens
 * a SECOND, empty thread: the agent, with no history, starts the conversation
 * again and refuses the booking it had just confirmed. Adopting the thread keeps
 * the history, the staff inbox entry and the booking together.
 */
async function adoptConversationPatientId(
  conversationId: string,
  dentallyPatientId: string,
  patientName: string | null,
): Promise<void> {
  const db = serviceClient();
  const patch: Record<string, unknown> = {
    dentally_patient_id: dentallyPatientId,
    updated_at: new Date().toISOString(),
  };
  if (patientName) patch.patient_name = patientName;
  const { error } = await db.from("agent_conversation").update(patch).eq("id", conversationId);
  if (error) throw error;
}

function twiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Malformed / non-form POST (scanner, bad content-type): reject cleanly
    // rather than throwing an unhandled 500. Matches the voice webhook.
    return Response.json({ error: "malformed payload" }, { status: 400 });
  }
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    // Fail closed in production: never accept unsigned webhooks on a public deploy.
    if (process.env.NODE_ENV === "production") {
      return Response.json({ error: "TWILIO_AUTH_TOKEN not configured" }, { status: 403 });
    }
  } else {
    const sig = request.headers.get("x-twilio-signature") ?? "";
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/inbound"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const rawFrom = params["From"] ?? "";
  const isWhatsapp = rawFrom.startsWith("whatsapp:");
  const channel: MessageChannel = isWhatsapp ? "whatsapp" : "sms";
  const from = rawFrom.replace(/^whatsapp:/, "");
  // A WhatsApp/MMS message can carry only media (a photo of a tooth, an X-ray)
  // with an EMPTY Body. Handing the agent an empty user turn makes Anthropic
  // reject the request and poisons the thread, so give media-only messages a
  // placeholder the agent can respond to. A truly empty inbound (no text, no
  // media) is acked and dropped below.
  const hasMedia = Number(params["NumMedia"] ?? "0") > 0;
  const body = (params["Body"] ?? "").trim() || (hasMedia ? "[Patient sent a photo or attachment]" : "");
  if (!from) return twiml();
  if (!body) return twiml();

  // Idempotency: Twilio retries an inbound webhook on a timeout, which would
  // otherwise re-run the whole agent turn (double book / double reply). Claim the
  // MessageSid once; a retry of the same SID is a clean no-op. Status and voice
  // webhooks lean on natural dedup; the agent turn has no such key so we gate on
  // the SID here.
  const messageSid = params["MessageSid"] ?? "";
  if (!(await claimInboundMessage(messageSid))) {
    return twiml();
  }

  const dentally = new DentallyClient({
    apiKey: process.env.DENTALLY_API_KEY ?? "",
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
    // IDENTIFY ONLY. Both write paths on this route build their own client from
    // dentallyAgentClient() (the no-show handler and the booking agent below), so
    // this one never writes. Arming the latch keeps it that way: a future caller
    // that reaches for the handy client already in scope throws instead.
    readOnly: true,
  });

  // No-show defence: a structured YES/CANCEL reply to a confirmation, or a
  // YES/NO to a waitlist slot offer, is handled before the general agent. If
  // handled we reply and stop; otherwise (free-text, e.g. a reschedule request)
  // we fall through to the booking agent below.
  //
  // Site scoping: one practice number can serve several sites, so the same
  // patient number may hold a live offer on more than one site. The site is not
  // resolved until further below (line ~139), after several lookups this offer
  // check must precede. We therefore let findOpenOfferByAddress pin the offer to
  // the site of the most-recent offer SMS actually sent to this number, so a
  // reply can never resolve or flip an offer belonging to a different site.
  // Writes (the CANCEL path) must go through the gated agent client so they use
  // the write key when enabled — the plain read client above cannot cancel.
  // Owner kill switch: with No-show defence OFF, structured YES/CANCEL replies
  // are NOT auto-answered — no reply SMS and no Dentally cancel. The inbound
  // still falls through to the normal flow below, so it is recorded on the
  // conversation for a human to answer. Single-tenant deployment, so the gate is
  // client-level (matches the drain). Fail-closed once messaging is live.
  let noshow: Awaited<ReturnType<typeof handleNoshowInbound>> = { handled: false };
  if (await isSystemEnabledForSend("vitality", "no-show-defence")) {
    noshow = await handleNoshowInbound({ from, body, channel, dentally: dentallyAgentClient() });
  }
  if (noshow.handled) {
    if (noshow.reply) {
      try {
        await sendMessage({ channel, to: from, body: noshow.reply });
      } catch {
        // Reply logged intent only; swallow delivery errors so Twilio does not retry.
      }
    }
    return twiml();
  }

  // POST-OP CHECK-IN: a reply to an aftercare check is TRIAGED HERE AND NEVER REACHES
  // THE BOOKING AGENT.
  //
  // This is the compliance-critical branch of the whole webhook. The agent below is a
  // fluent Claude loop, and `checkAgentReply` — the only thing standing between it and
  // the patient — blocks funding jargon, an invented price and a short list of explicit
  // clinical phrasings. "That usually settles after a day or two" is none of those. So a
  // reply to "how are you feeling after your extraction" must be answered by a fixed
  // sentence or not at all, and never by a model.
  //
  // handlePostopInbound returns handled:true for every reply it recognises, INCLUDING
  // the ones it has nothing to say to (system switched off, patient opted out). That is
  // deliberate: staying silent is a valid outcome and the agent must not fill the gap.
  // It returns handled:false for a STOP (which belongs to the suppression path below),
  // for a number with no recent post-op check-in, and for one whose check-in is outside
  // the reply window — all of which are ordinary conversations the agent should have.
  //
  // The kill switch gates the ACKNOWLEDGEMENT only. Triage and escalation run whatever
  // the switch says: a system the practice turned off afterwards must never be the
  // reason a symptom went unseen.
  try {
    const postop = await handlePostopInbound({
      from,
      body,
      channel,
      sendingEnabled: await isSystemEnabledForSend("vitality", "postop-checkin"),
    });
    if (postop.handled) {
      if (postop.reply) {
        try {
          await sendMessage({ channel, to: from, body: postop.reply });
        } catch {
          // The escalation is already recorded; a failed acknowledgement must not
          // make Twilio retry the whole webhook and escalate the same reply twice.
        }
      }
      console.warn(
        `[inbound] post-op reply handled: ${postop.outcome}` +
          (postop.triageReason ? ` (${postop.triageReason})` : ""),
      );
      return twiml();
    }
  } catch (err) {
    // A failure here must NOT hand a clinical reply to the booking agent as a
    // consolation prize. Answer Twilio and stop: the message is still in the Twilio
    // log and the practice's own worklist still shows the check-in as unanswered,
    // which is a quiet failure rather than a wrong reply.
    console.error("[inbound] post-op triage failed; not answering this message", err);
    return twiml();
  }

  // Who is texting us? Reactivation linkage drives cadence side-effects; the
  // identity drives who the agent thinks it is talking to. Either may be absent.
  const target = await findTargetByAddress(from);
  // A reply may ALSO correlate to a recall outbound (recall has its own outbox). Resolve
  // it unconditionally, not only when reactivation misses: a patient enrolled in BOTH
  // cadences must have BOTH paused when they reply, otherwise the recall sweep keeps
  // chasing a patient who has already engaged.
  const recallTarget = await findRecallTargetByAddress(from);
  let identity: PhoneIdentity | null = await identifyByPhone(from, { dentally });

  // When the directory and Dentally both miss but this number is in a cadence,
  // fall back to the reactivation target's context so we still know the patient.
  if (!identity && target) {
    const ctxRow = await getTargetContext(target.targetId);
    if (ctxRow) {
      identity = {
        patientId: target.targetId.split(":")[1] ?? target.targetId,
        siteId: target.siteId,
        patientName: ctxRow.patientName,
        treatment: ctxRow.treatment,
        fundingType: ctxRow.fundingType,
        lastVisitAt: null,
        recallDueAt: null,
        source: "reactivation",
      };
    }
  }

  const siteId = identity?.siteId || target?.siteId || recallTarget?.siteId || DEFAULT_SITE_ID;

  // After-hours capture: if this message landed while the site was closed, log it
  // to the after-hours worklist so staff see overnight contact. Best-effort and
  // non-blocking: the booking agent below still responds normally. Deduped so a
  // back-and-forth in one closed evening makes at most one open capture.
  try {
    if (isOutsideHours(getSiteById(siteId), new Date())) {
      const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      if (!(await hasOpenCaptureFrom(siteId, from, dayAgoIso))) {
        await insertCapture({
          siteId,
          fromNumber: from,
          dentallyPatientId: identity?.patientId ?? null,
          patientName: identity?.patientName ?? `Unknown ${from.slice(-4)}`,
          channel,
          body,
        });
      }
    }
  } catch {
    // Capture is a side log; never let it affect the agent reply.
  }

  // Cadence side-effects when this number is in a cadence. A reply pauses the active
  // sequence so we stop chasing once the patient engages. Crucially this pauses EVERY
  // cadence the number is enrolled in, not just the first match: a patient in both
  // reactivation and recall (and/or a coordinator follow-up) should have ALL of them
  // stop the moment they reply, otherwise the un-paused one keeps chasing them.
  if (target) {
    const cadence = await getCadenceByTarget(target.targetId);
    await insertInboundTouch({
      targetId: target.targetId,
      cadenceId: cadence?.id ?? null,
      siteId: target.siteId,
      channel,
      body,
    });
    if (cadence && cadence.status === "active") {
      await updateCadence(cadence.id, { status: "paused" });
    }
  }
  if (recallTarget) {
    const cadence = await getRecallCadenceByTarget(recallTarget.targetId);
    await insertRecallInboundTouch({
      targetId: recallTarget.targetId,
      cadenceId: cadence?.id ?? null,
      siteId: recallTarget.siteId,
      channel,
      body,
    });
    if (cadence && cadence.status === "active") {
      await updateRecallCadence(cadence.id, { status: "paused" });
    }
  }
  // A reply may also correlate to a treatment-coordinator follow-up. Log it as an
  // inbound coordinator_touch so the coordinator sweep pauses that cadence too (it
  // skips any opportunity with an inbound touch) and stops chasing.
  const coordTarget = await findCoordinatorTargetByAddress(from);
  if (coordTarget) {
    await insertCoordinatorInboundTouch({
      opportunityId: coordTarget.opportunityId,
      siteId: coordTarget.siteId,
      channel,
      body,
    });
  }
  // The same reply may correlate to a treatment-plan CLOSER follow-up. Unlike the
  // cadences above, the closer is stopped here and now rather than at the next
  // sweep tick: the minutes between a reply landing and a sweep running are
  // exactly the window in which an already-drafted follow-up could be approved and
  // sent to someone who has just answered. A dispute ("this is wrong", "I already
  // paid") is recorded as its own reason so it surfaces as needing a person, not
  // as a patient who simply went quiet. Best effort, and never allowed to break
  // the webhook.
  // Hoisted out of the try below so the recall-aware reply context can see it: a
  // reply that DISPUTES what we sent is never primed towards a booking, whatever
  // else the number correlates to. Left null when the lookup fails, which primes
  // nothing extra and takes nothing away.
  let closerReplyKind: ReturnType<typeof classifyInboundReply> | null = null;
  try {
    const closerTarget = await findCloserTargetByAddress(from);
    if (closerTarget) {
      await insertCloserInboundTouch({
        opportunityId: closerTarget.opportunityId,
        siteId: closerTarget.siteId,
        channel,
        body,
      });
      const kind = classifyInboundReply(body);
      closerReplyKind = kind;
      await stopCloserOpportunity(
        closerTarget.opportunityId,
        closerTarget.siteId,
        kind === "dispute" ? "dispute" : kind === "optout" ? "opted_out" : "patient_replied",
      );
    }
  } catch (err) {
    console.error("[inbound] closer reply linkage failed; continuing", err);
  }

  // The same reply may correlate to a BALANCE REMINDER, and this module's escape
  // hatch is the widest in the platform. Every inbound reply at all stops the
  // conversation for good AND raises a work item for a person, including a reply
  // the classifier cannot place: somebody replying to a message about money is
  // telling the practice something about their finances, and there is no version
  // of that a machine should be answering. The stop happens here and now rather
  // than at the next sweep tick, because the minutes between a reply landing and a
  // sweep running are exactly the window in which an already-drafted reminder could
  // be approved and sent to somebody who has just said "I already paid this".
  //
  // Nothing in this block replies to the patient. Best effort, and never allowed to
  // break the webhook.
  try {
    const collectionTarget = await findCollectionTargetByAddress(from);
    if (collectionTarget) {
      await insertCollectionInboundTouch({
        patientId: collectionTarget.patientId,
        siteId: collectionTarget.siteId,
        channel,
        body,
      });
      const kind = classifyCollectionReply(body);
      await stopCollectionTarget(
        collectionTarget.patientId,
        collectionTarget.siteId,
        stopReasonForReply(kind),
        escalationForReply(kind),
      );
    }
  } catch (err) {
    console.error("[inbound] collection reply linkage failed; continuing", err);
  }

  // Segment-outreach reply linkage. A reply from an outreach target pauses its
  // cadence (status 'replied') so the sweep stops texting once the patient engages,
  // and carries a campaign HINT into the agent context below so the booking agent
  // offers the campaign's clinician first. Correlated by the resolved to_address of
  // the last send (exactly the recall pattern), not the raw phone, so it matches the
  // precise address messaged. Best-effort: any lookup failure must never break the
  // webhook, so the whole block is guarded.
  let outreachInvite: AgentContext["outreachInvite"] | undefined;
  // STOP opt-out also needs the outreach match's patient-ref (used in the STOP block
  // below). A STOP from a number known ONLY via an outreach campaign - no
  // reactivation/recall target and no resolved Dentally identity - must still be
  // suppressed by patient:<id>, not by address alone. Capture it inside THIS
  // best-effort lookup so a lookup failure leaves it null and the STOP still
  // suppresses by address (opt-out is never broken), mirroring the recall/
  // reactivation branches which likewise derive the ref from a matched target.
  let outreachStopPatientRef: string | null = null;
  let outreachStopSiteId: string | null = null;
  try {
    const outreachTarget = await findOutreachTargetByAddress(from);
    if (outreachTarget) {
      const campaignId = await getOutreachCampaignIdForTarget(outreachTarget.targetId);
      // Always RECORD the reply as an inbound touch (audit; harmless on a terminal
      // target since the sweep only ever acts on active targets). This mirrors
      // recall/reactivation, which likewise always log the inbound touch.
      await insertOutreachInboundTouch({
        targetId: outreachTarget.targetId,
        campaignId,
        siteId: outreachTarget.siteId,
        channel,
        body,
      });
      // STATUS + RECENCY guard (mirrors recall/reactivation, which pause ONLY an
      // ACTIVE cadence). findOutreachTargetByAddress returns the LATEST outbox
      // address-match with no guard on the target's state or age, so without this an
      // unrelated later inbound would drag an already-'booked'/'exhausted'/'replied'
      // target back to 'replied' and mis-prime the booking agent with a stale
      // campaign's clinician/angle. Only regress + prime when the matched target is
      // still in an active cadence state AND the correlating send is recent.
      const fullTarget = await getOutreachTarget(outreachTarget.targetId);
      // Opt-out ref for the STOP block below: derived from the matched outreach
      // target regardless of the linkage recency/status guard that follows (that
      // guard governs agent-priming, NOT opt-out - a STOP is a global opt-out for the
      // matched patient however stale the campaign).
      if (fullTarget?.patientId) {
        outreachStopPatientRef = `patient:${fullTarget.patientId}`;
        outreachStopSiteId = fullTarget.siteId;
      }
      const linkable =
        !!fullTarget &&
        OUTREACH_ACTIVE_STATES.has(fullTarget.status) &&
        outreachMatchRecent(fullTarget, Date.now());
      if (linkable) {
        // Pause + attribute: 'replied' is excluded from the sweep's due set and clears
        // next_due_at, and replied_at is stamped ONCE (durable, for the per-variant
        // read-back). The active-state + recency guard above already ensures this runs
        // once per target; markOutreachReplied's null guard is belt-and-braces.
        await markOutreachReplied(outreachTarget.targetId);
        if (campaignId) {
          const campaign = await getOutreachCampaign(campaignId);
          if (campaign) {
            outreachInvite = {
              treatmentAngle: campaign.messageAngle ?? "an appointment",
              practitionerName: campaign.practitionerName,
              practitionerId: campaign.practitionerId,
            };
          }
        }
      }
    }
  } catch (err) {
    console.error("[inbound] outreach reply linkage failed; continuing", err);
  }

  // STOP keyword: suppress the right ref and do not reply.
  if (isStopKeyword(body)) {
    // A failed suppression WRITE must not surface a 500: Twilio would retry the
    // STOP webhook, and the retry would hit the same DB error and loop. The
    // inbound is already recorded above as an inbound touch, so staff can see
    // the opt-out even if this write failed; the next STOP (or the status
    // webhook) will re-attempt it. Swallow and still return a clean 2xx TwiML.
    try {
      // One STOP means STOP EVERYWHERE. Record it by ADDRESS and (when known) by
      // patient ref, on BOTH phone channels (the same number receives SMS and
      // WhatsApp), for EVERY site of the practice — every downstream check is
      // keyed to its own row's site/channel/ref, and a narrower write left gaps:
      // a patient-ref-only record missed the same person arriving later as a
      // public-form lead; an SMS-only record let WhatsApp keep sending; a
      // single-site record let another site's cadence text the opted-out number.
      const patientRef = target
        ? `patient:${target.targetId.split(":")[1]}`
        : recallTarget
          ? `patient:${recallTarget.targetId.split(":")[1]}`
          : identity
            ? `patient:${identity.patientId}`
            : // Outreach-only recipient (no reactivation/recall target, unresolved
              // identity): fall back to the patient-ref captured from the outreach
              // match above, so the STOP suppresses patient:<id> and not the address
              // alone. Null when no outreach match either.
              outreachStopPatientRef;
      // This webhook only ever receives phone channels; the same number gets both.
      const channels: MessageChannel[] = ["sms", "whatsapp"];
      const clientId = getSite(siteId)?.clientId ?? "vitality";
      const suppressSites = new Set<string>(getSites(clientId).map((s) => s.id));
      // Belt and braces: always include the resolved site and any matched target's
      // own site, so the opt-out covers them even if the site list is incomplete.
      suppressSites.add(siteId);
      if (target) suppressSites.add(target.siteId);
      if (recallTarget) suppressSites.add(recallTarget.siteId);
      if (outreachStopSiteId) suppressSites.add(outreachStopSiteId);
      const refs = patientRef ? [from, patientRef] : [from];
      for (const sid of suppressSites) {
        for (const ch of channels) {
          for (const ref of refs) {
            await addSuppression(sid, ch, ref, "stop");
          }
        }
      }
    } catch (err) {
      console.error(`[inbound] STOP suppression write failed for ${from}; opt-out logged as an inbound touch, will retry`, err);
    }
    return twiml();
  }

  // Conversation. Known patients are addressed by name; unknown numbers show a
  // masked label in the dashboard and are treated as a brand new enquiry.
  const knownPatient = !!identity;
  const patientId = identity?.patientId ?? `lead:${from}`;
  const displayName = identity?.patientName ?? `Unknown ${from.slice(-4)}`;
  // The MessageSid is already claimed above, so a 500 here would make Twilio's retry
  // no-op on the claim and the patient's message would be lost forever. Guard the
  // durable-record ops: on a transient failure, log the FULL inbound (recoverable by
  // staff) and return a clean TwiML rather than dropping it silently.
  let conversation: Awaited<ReturnType<typeof findOrCreateConversation>>;
  try {
    conversation = await findOrCreateConversation({
      siteId,
      dentallyPatientId: patientId,
      patientName: displayName,
      channel,
      treatment: identity?.treatment ?? null,
      fundingType: identity?.fundingType ?? null,
    });
    await appendMessage({ conversationId: conversation.id, role: "patient", body });
    await stampInbound(conversation.id);
  } catch (err) {
    console.error(
      `[inbound] failed to record message SID=${messageSid} from=${from} body=${JSON.stringify(body)}; not retrying`,
      err,
    );
    return twiml();
  }

  // Keep a reused conversation's name in step with the current directory, so a
  // renamed contact is reflected straight away rather than staying stale.
  if (identity && conversation.patientName !== identity.patientName) {
    await setConversationName(conversation.id, identity.patientName);
  }

  if (!(await isAgentEnabled(siteId))) {
    // Agent paused for this site from the dashboard: route to a human, no reply.
    await setConversationStatus(conversation.id, "needs_human");
    return twiml();
  }
  // Owner kill switch: the SMS agent ("booking-agent") and the WhatsApp agent
  // ("whatsapp-agent") are switched independently. When the relevant one is off,
  // hand to a human with no auto-reply. The inbound is already recorded above, and
  // STOP/opt-out was handled earlier, so turning the agent off never blocks opt-out.
  //
  // The inbound agent deliberately uses its OWN slug, distinct from the 'whatsapp'
  // slug the messaging drain reads as its OUTBOUND channel gate (and which
  // migration 0047 seeds off). Sharing one slug meant switching WhatsApp SENDING
  // off also silenced every inbound WhatsApp enquiry, so a patient could message
  // the practice and get nothing back with nobody any the wiser.
  const agentClientId = getSite(siteId)?.clientId ?? "vitality";
  const agentSystem = channel === "whatsapp" ? "whatsapp-agent" : "booking-agent";
  if (!(await isSystemEnabledForSend(agentClientId, agentSystem))) {
    await setConversationStatus(conversation.id, "needs_human");
    // Silence must never be invisible: the patient has messaged us and will get no
    // automatic reply, so ping the practice the same way every other handover does.
    // Best-effort and hourly-capped inside alertStaffHandover.
    await alertStaffHandover({
      patientName: displayName,
      reason: "no_reply",
      conversationId: conversation.id,
    });
    return twiml();
  }
  if (conversation.status === "needs_human") {
    return twiml(); // already handed over; log only
  }

  // Opt-out gate: if this number texted STOP (suppressed by address or, for a known
  // patient, by patient id), do NOT let the conversion-oriented agent auto-reply.
  // Hand to a human so an opted-out patient is never re-engaged by an automated,
  // promotional message. Their inbound is already logged above for a manual reply.
  // Structured transactional no-show replies (YES/CANCEL) are handled earlier and
  // are exempt, since those answer the patient's own action.
  const optedOut =
    (await isSuppressed(siteId, channel, from)) ||
    (identity ? await isSuppressed(siteId, channel, `patient:${identity.patientId}`) : false);
  if (optedOut) {
    await setConversationStatus(conversation.id, "needs_human");
    return twiml();
  }

  // The practice's selling points, so the agent can weave them in for conversion.
  // Resilient: listActiveUspTexts already swallows errors and returns [].
  const uspClientId = getSite(siteId)?.clientId;
  const usps = uspClientId ? await listActiveUspTexts(uspClientId) : [];

  // Per-sender cost guard: bound how many agent turns a single sender can run in
  // the window before we throttle. A spammer texting the number cannot run
  // unbounded Claude spend; over the cap we send a safe throttle reply and never
  // call the model. Fails OPEN on a DB error (consumeBudget), so a transient
  // outage does not break genuine patients. Runs before any model call.
  const withinBudget = await consumeBudget(
    `agent-inbound:${from}`,
    SENDER_BUDGET_LIMIT,
    SENDER_BUDGET_WINDOW_SECONDS,
  );
  if (!withinBudget) {
    const throttle = "Thanks for your messages. A member of our team will be in touch shortly.";
    await appendMessage({ conversationId: conversation.id, role: "agent", body: throttle });
    await setConversationStatus(conversation.id, "needs_human");
    try {
      await sendMessage({ channel, to: from, body: throttle });
    } catch {
      // Reply logged; swallow delivery errors so Twilio does not retry.
    }
    await alertStaffHandover({
      patientName: displayName,
      reason: "throttled",
      conversationId: conversation.id,
    });
    return twiml();
  }

  // A lead conversation carries the enquirer's smile-assessment answers (when
  // they completed one), so the agent's replies are grounded in what they told
  // us. Best-effort context: a lookup failure never blocks the turn.
  let assessmentAnswers: string[] | undefined;
  try {
    const lead = await findLeadByConversation(conversation.id);
    if (lead) {
      const response = await latestResponseByLead(lead.id);
      const lines = answerLines(response?.responses);
      if (lines.length > 0) assessmentAnswers = lines;
    }
  } catch {
    /* context only */
  }

  // The group's practices (+ public booking links when online booking is on), so
  // the agent can ask a new enquiry where they are based and route them to the
  // most convenient practice. Links only on a real https deployment.
  let practiceSites: AgentContext["practiceSites"];
  try {
    const agentClient = uspClientId ? getClient(uspClientId) : undefined;
    if (agentClient) {
      const bookingOn = await isSystemEnabled(agentClient.id, "online-booking");
      const base = process.env.PUBLIC_BASE_URL ?? "";
      const withLinks = bookingOn && base.startsWith("https://");
      practiceSites = getSites(agentClient.id).map((s) => ({
        id: s.id,
        name: s.name,
        bookingUrl: withLinks ? `${base}/book/${agentClient.slug}?site=${s.id}` : undefined,
      }));
    }
  } catch {
    /* context only */
  }

  // RECALL-AWARE BOOKING REPLIES.
  //
  // Recall and reactivation have thousands of patients queued. When one of them
  // replies "yes please" to an invite we sent yesterday, everything above has
  // already paused their cadence and logged the touch, and then the booking agent
  // opens a COLD conversation and asks a patient who has already answered what it
  // is they need. This resolves the outbound the reply plausibly answers and hands
  // the agent an opening state that already knows it.
  //
  // FOUR REASONS IT CANNOT MISFIRE, and each holds on its own:
  //   1. The owner's switch. DEFAULT-OFF (catalog + migration 0092), and
  //      isSystemEnabledForSend fails CLOSED for a default-off slug, so an
  //      unreadable toggle table primes nothing.
  //   2. The correlation is site- AND patient-scoped inside chooseReplyContext,
  //      and requires a KNOWN patient on both sides, so a shared family handset or
  //      another practice's record can never prime this thread.
  //   3. STOP, a no-show reply and a post-op reply have all already returned far
  //      above; a dispute and a recent balance reminder refuse here.
  //   4. Any failure at all leaves replyContext undefined, and undefined makes
  //      buildSystemPrompt emit the exact bytes it emitted before this existed.
  //
  // It does NOT touch the confirmation gate: the agent still has to read the slot
  // back and get a clear yes before anything is written (src/lib/agent/run.ts).
  let replyContext: AgentContext["replyContext"];
  try {
    if (await isSystemEnabledForSend(agentClientId, "booking-reply-context")) {
      const { candidates, vetoes } = await collectReplyContext(from);
      replyContext =
        chooseReplyContext({
          candidates,
          vetoes,
          conversationSiteId: siteId,
          conversationPatientId: identity?.patientId ?? null,
          disputed: closerReplyKind === "dispute",
          now: Date.now(),
        }) ?? undefined;
      if (replyContext) {
        console.warn(
          `[inbound] reply context: ${replyContext.module} ${replyContext.reference} -> ${replyContext.bookingTreatment}`,
        );
      }
    }
  } catch (err) {
    // Context only. A patient's reply must never fail because we could not work
    // out what it was answering.
    console.error("[inbound] reply-context resolution failed; answering without it", err);
    replyContext = undefined;
  }

  const context: AgentContext = {
    patientId,
    siteId,
    phone: from,
    channel,
    patientName: identity ? identity.patientName : "there",
    treatment: conversation.treatment,
    fundingType: conversation.fundingType,
    lastVisitAt: identity?.lastVisitAt ?? null,
    recallDueAt: identity?.recallDueAt ?? null,
    isKnownPatient: knownPatient,
    usps,
    assessmentAnswers,
    practiceSites,
    outreachInvite,
    replyContext,
  };

  // Serialize agent turns per conversation: two rapid inbounds (distinct
  // MessageSids, so SID idempotency does not catch them) otherwise run two
  // concurrent turns over the same history — interleaved replies and, worst
  // case, a double booking. The inbound is already recorded above, so if the
  // lease cannot be won after a short wait we simply skip this turn: the
  // message sits in the history the patient's next turn (or a human) reads.
  // Fail OPEN if the lock table is unreachable ("error"): an unserialised turn
  // beats silently dropping a patient's message on a DB blip.
  const turnLock = `agent-turn:${conversation.id}`;
  let lease = await tryAcquireLease(turnLock, 120);
  for (let attempt = 0; lease === "held" && attempt < 4; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    lease = await tryAcquireLease(turnLock, 120);
  }
  if (lease === "held") return twiml();

  let replyText = "";
  // Set at the moment a handover happens, so staff can be pinged AFTER the
  // patient-facing reply has gone out (the ping must never delay or break it).
  let handoverReason: HandoverReason | null = null;
  try {
  try {
    const prior = await listMessages(conversation.id, { limit: AGENT_HISTORY_MESSAGES });
    const history = prior.map((m) => ({
      role: m.role === "patient" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }));
    const result = await runAgentTurn(history, {
      anthropic: new Anthropic(),
      // Booking writes (book/reschedule/cancel/register) go through the gated write
      // client: default-OFF (same target as `dentally` above, i.e. the mock in the
      // pilot), targeting a real/sandbox book only when DENTALLY_WRITE_ENABLED is set.
      dispatch: makeDispatch({ dentally: dentallyAgentClient(), context }),
      systemPrompt: `${buildSystemPrompt(context)}\n\n${channelPromptNote(channel)}`,
      tools: AGENT_TOOLS,
    });
    replyText = result.replyText;

    // A brand new patient was registered mid-thread, so their id has just changed
    // from the "lead:<number>" placeholder to a real Dentally id. Move THIS thread
    // onto the new id and remember the number, so their next message lands back in
    // this conversation, with its history, instead of opening a fresh one the agent
    // would answer as a stranger. Both steps are best-effort: the patient's reply
    // must go out either way.
    if (result.registeredPatientId) {
      const registeredName = result.registeredPatientName ?? conversation.patientName;
      try {
        await adoptConversationPatientId(conversation.id, result.registeredPatientId, registeredName);
      } catch (err) {
        console.error(`[inbound] could not adopt conversation ${conversation.id} onto the new patient id`, err);
      }
      try {
        await upsertPhoneIdentity(from, {
          patientId: result.registeredPatientId,
          siteId,
          patientName: registeredName,
          treatment: conversation.treatment,
          fundingType: conversation.fundingType,
          lastVisitAt: null,
          recallDueAt: null,
          source: "dentally",
        });
      } catch (err) {
        console.error(`[inbound] could not cache the identity for ${from} after registration`, err);
      }
    }

    // OUTPUT GUARDRAIL: the no-clinical-advice / no-unverified-price /
    // no-NHS-or-private-or-funding rules are enforced in the prompt, but a prompt
    // is a soft control. Scan the model's reply deterministically; on any hit do
    // NOT send the model text. Replace it with a safe handover and hand the
    // conversation to a human. This guarantees a violating reply never reaches the
    // patient verbatim, whatever the model produced.
    const guard = checkAgentReply(replyText);
    if (!guard.ok) {
      replyText = SAFE_HANDOVER;
      await setConversationStatus(conversation.id, "needs_human");
      handoverReason = "guardrail";
    } else {
      // A REAL appointment only: result.booked comes from the book tool's own
      // result, so a booking the model merely attempted (blocked for want of a
      // confirmation, refused because the slot had gone, or failed at Dentally)
      // never marks the thread booked. It used to key off the attempt, which
      // over-reported the Booked figure and let staff skip a patient who in fact
      // had no appointment.
      if (result.escalated || !replyText) {
        await setConversationStatus(conversation.id, "needs_human");
        handoverReason = result.escalated ? "escalated" : "no_reply";
      } else if (result.booked) {
        await setConversationStatus(conversation.id, "booked");
        // Outreach A/B attribution: stamp booked_at when this number belongs to a
        // recent outreach target (self-guarded: stamp-once + 30-day recency; no-op
        // otherwise). Best-effort - attribution must never break the patient's reply.
        try {
          await markOutreachBookedByAddress(from);
        } catch {}
        // Speed-to-lead: an enquiry the agent has just booked is done. Without
        // this the lead sits in the worklist as still-to-chase and staff ring a
        // patient who already has an appointment in the diary. Best-effort, and
        // only ever forward: a lead already marked booked is left alone.
        try {
          const lead = await findLeadByConversation(conversation.id);
          if (lead && lead.stage !== "booked") await setLeadStage(lead.id, "booked");
        } catch (err) {
          console.error(`[inbound] could not mark the lead booked for conversation ${conversation.id}`, err);
        }
      }
    }
  } catch {
    await setConversationStatus(conversation.id, "needs_human");
    handoverReason = "agent_error";
  }

  const outbound = replyText || "Thanks, a member of our team will be in touch shortly.";
  await appendMessage({ conversationId: conversation.id, role: "agent", body: outbound });
  try {
    await sendMessage({ channel, to: from, body: outbound });
  } catch {
    // Delivery failed (a transient provider error, or the recipient is not reachable
    // on this channel yet). The reply is already logged. Swallow so we still return
    // 200 and Twilio does not retry the webhook and double-run the agent. Leave the
    // conversation active so the agent keeps responding; delivery state is tracked
    // separately by the Twilio status webhook.
  }
  if (handoverReason) {
    // AFTER the patient reply: ping the practice's alert number so a human picks
    // the thread up. No-op until STAFF_ALERT_PHONE is set; never throws.
    await alertStaffHandover({
      patientName: displayName,
      reason: handoverReason,
      conversationId: conversation.id,
    });
  }
  } finally {
    await releaseCronLock(turnLock);
  }
  return twiml();
}

// Every Dentally read inside this handler is CRITICAL work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): a patient mid-booking, or the
// 24/7 agent answering one, outranks every dashboard and every sweep and is served to
// 95% consumption. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("critical", () => handleWithDentallyPriority(request));
}
