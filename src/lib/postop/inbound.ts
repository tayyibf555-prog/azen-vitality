// What happens when a patient answers a post-op check-in.
//
// ===========================================================================
// THIS HANDLER EXISTS TO KEEP THE BOOKING AGENT OUT OF A CLINICAL CONVERSATION.
// ===========================================================================
//
// The Twilio inbound webhook's default destination is the conversational booking
// agent: a Claude loop with tools, a system prompt, and a guardrail tuned for
// bookings. Give it "my face is swollen and I can't sleep" and it will answer,
// warmly and fluently, and the guardrail will not stop it — `checkAgentReply`
// blocks funding jargon, an invented price and a handful of explicit clinical
// phrasings, and "that usually settles after a couple of days" is none of them.
//
// So a reply to a post-op check-in must never reach that agent. This handler runs
// BEFORE it, mirrors the no-show handler's shape (handled -> reply -> return), and
// returns `handled: true` for every post-op reply it recognises, including the
// ones where it has nothing to say. Not answering is a valid outcome here.
// Answering wrongly is not.
//
// THE ORDER OF OPERATIONS IS THE SAFETY ARGUMENT:
//   1.  STOP first, always. An opt-out is not a post-op reply and must reach the
//       webhook's own suppression path untouched.
//   2.  Correlate to a SENT check-in, inside the reply window. Outside it, this is
//       just the same patient texting the practice; hand it back.
//   3a. Log the reply.
//   3b. TRIAGE, and escalate on anything that is not positively an all-clear.
//   3c. Only then decide what, if anything, to say back.
//
// Step 3b never depends on step 3c. The escalation is recorded whether or not the
// system is switched on, whether or not the patient can be messaged, and whether
// or not the acknowledgement sends: a switch nobody flipped must not be the reason
// a symptom went unseen.
//
// AND THE TWO HALVES FAIL IN OPPOSITE DIRECTIONS, on purpose. Step 2 fails OPEN (a
// read error leaves the message unhandled and the agent answers it as usual),
// because before it lands we have no evidence this is a post-op reply and claiming
// every inbound during a database blip would silence the practice's 24/7 agent for
// everybody. Step 3 fails CLOSED (handled, silent), because by then we know exactly
// what this message is.

import { isStopKeyword, isSuppressed } from "@/lib/messaging/suppression";
import { getSite } from "@/lib/mock/clients";
import type { MessageChannel } from "@/lib/messaging/types";
import { postopAllClearAck, postopEscalationAck, projectPostopFacts } from "./copy";
import {
  findTargetByAddress,
  getTarget,
  insertInboundTouch,
  recordEscalation,
  setTargetStatus,
} from "./repository";
import { triageReply } from "./triage";
import { postopConfig } from "./types";
import type { PostopStatus, PostopTarget, TouchChannel } from "./types";

/** Target states in which an inbound is a REPLY to a check-in we actually sent.
 *
 *  `in_flight` is here because the delivery bookkeeping is two writes: a run killed
 *  between the outbox update and the target update leaves a delivered message on a
 *  target still marked in_flight, and a patient's reply to it must not be dropped
 *  because of our own bookkeeping. `stopped` is deliberately absent: that target
 *  was retired without a live conversation. */
const REPLYABLE: PostopStatus[] = ["in_flight", "sent", "escalated", "closed"];

export interface PostopInboundResult {
  /** True when this module owns the message. The webhook must then NOT run the
   *  booking agent on it, even if `reply` is null. */
  handled: boolean;
  /** The one fixed sentence to send back, or null to say nothing at all. */
  reply?: string | null;
  /** For the webhook's log line and for tests. Never shown to a patient. */
  outcome?: "escalated" | "all_clear";
  triageReason?: string | null;
}

const NOT_HANDLED: PostopInboundResult = { handled: false };

/**
 * Triage one inbound against the post-op module.
 *
 * `sendingEnabled` is the owner's kill switch for this system, resolved by the
 * caller (the webhook already holds a client-scoped answer). It gates the
 * ACKNOWLEDGEMENT ONLY. With the system off we still correlate, still log, still
 * triage and still escalate — the switch stops the practice messaging patients, it
 * does not stop the practice noticing that one of them is in trouble — but we say
 * nothing back, and we still return handled:true so the booking agent does not
 * step into the gap.
 */
export async function handlePostopInbound(input: {
  from: string;
  body: string;
  channel: MessageChannel;
  sendingEnabled: boolean;
  now?: Date;
}): Promise<PostopInboundResult> {
  const { from, body, channel } = input;
  const now = input.now ?? new Date();

  // 1. STOP is an opt-out, not a reply. Hand it straight back so the webhook's own
  //    suppression path records it against every channel and every module.
  if (isStopKeyword(body)) return NOT_HANDLED;

  // 2. Correlate. A match is only a reply if the check-in was actually SENT (the
  //    repository filters on sent_at) and sent RECENTLY.
  //
  //    A READ FAILURE HERE FALLS THROUGH, and the direction is deliberate. Until
  //    the correlation lands we have no evidence this message is a post-op reply at
  //    all, and claiming every inbound the practice receives whenever one table is
  //    briefly unreadable would silence the 24/7 agent for everybody: a certain,
  //    broad harm traded against a narrow, unlikely one. Every OTHER module's reply
  //    linkage in this webhook is best-effort for the same reason. What is NOT
  //    best-effort is everything after the correlation succeeds — see step 3.
  const config = postopConfig();
  let target: PostopTarget;
  try {
    const match = await findTargetByAddress(from);
    if (!match) return NOT_HANDLED;
    const sentMs = match.sentAt ? Date.parse(match.sentAt) : NaN;
    if (!Number.isFinite(sentMs)) return NOT_HANDLED;
    if (now.getTime() - sentMs > config.replyWindowHours * 3_600_000) {
      // Beyond the window this is the same patient texting the practice about
      // something else entirely. Swallowing it here would take every future message
      // they ever send away from the booking agent, for good.
      return NOT_HANDLED;
    }
    const found = await getTarget(match.targetId);
    if (!found) return NOT_HANDLED;
    if (!REPLYABLE.includes(found.status)) return NOT_HANDLED;
    target = found;
  } catch (err) {
    console.warn("[postop] could not correlate an inbound to a check-in; leaving it unhandled", err);
    return NOT_HANDLED;
  }

  // 3. FROM HERE ON, FAIL CLOSED. We now KNOW this is a reply to a post-op check-in
  //    we sent, so the booking agent must never see it whatever happens next. Any
  //    failure below returns handled:true with nothing to say: the practice's own
  //    worklist still shows a check-in with no recorded answer, which is a quiet
  //    failure a person notices, rather than a fluent model answering a clinical
  //    message on a dentist's behalf.
  try {
    return await triageAndRespond({ target, body, channel, sendingEnabled: input.sendingEnabled, from });
  } catch (err) {
    console.error(`[postop] triage failed for ${target.id}; answering nothing`, err);
    return { handled: true, reply: null, outcome: "escalated", triageReason: "unreadable" };
  }
}

async function triageAndRespond(input: {
  target: PostopTarget;
  body: string;
  channel: MessageChannel;
  sendingEnabled: boolean;
  from: string;
}): Promise<PostopInboundResult> {
  const { target, body, channel, from } = input;
  const touchChannel = channel as TouchChannel;

  // 3a. Log the reply before anything is decided about it, so the record of what the
  //    patient said does not depend on the triage step succeeding.
  await insertInboundTouch({
    targetId: target.id,
    siteId: target.siteId,
    channel: touchChannel,
    body,
  });

  // 3b. TRIAGE. Pure, fails safe, and the only thing that decides what happens next.
  const verdict = triageReply(body);

  const facts = projectPostopFacts({
    patientName: target.patientName,
    practiceName: getSite(target.siteId)?.name ?? "",
  });

  // 3c. Whether we may say anything at all. Three independent gates, and a failure
  //    of any of them silences the acknowledgement WITHOUT silencing the escalation:
  //      - the owner's kill switch;
  //      - the patient's opt-out (per channel, by number and by patient ref);
  //      - a usable first name and practice name to compose with.
  //    A suppression read that throws is treated as SUPPRESSED, which is the right
  //    direction for a send: not texting someone who might have opted out costs us a
  //    sentence, texting someone who has costs us a complaint to the ICO.
  let suppressed = true;
  try {
    suppressed =
      (await isSuppressed(target.siteId, channel, from)) ||
      (await isSuppressed(target.siteId, channel, `patient:${target.dentallyPatientId}`));
  } catch (err) {
    console.warn(`[postop] suppression read failed for ${target.id}; not acknowledging`, err);
  }
  const mayReply = input.sendingEnabled && !suppressed && facts.ok;

  if (verdict.outcome === "escalate") {
    // THE ESCALATION IS UNCONDITIONAL. Written before the reply is even considered,
    // and never inside a branch that a switch, a consent flag or a missing name can
    // skip.
    await recordEscalation({
      targetId: target.id,
      siteId: target.siteId,
      dentallyPatientId: target.dentallyPatientId,
      patientName: target.patientName,
      channel: touchChannel,
      replyBody: body,
      triageReason: verdict.reason ?? "ambiguous",
      matched: verdict.matched,
    });
    return {
      handled: true,
      outcome: "escalated",
      triageReason: verdict.reason,
      reply: mayReply && facts.ok ? postopEscalationAck(facts.facts) : null,
    };
  }

  // An all-clear closes the loop. Nothing about the reply is evaluated back to the
  // patient; the acknowledgement thanks them and leaves the door open.
  await setTargetStatus(target.id, "closed");
  return {
    handled: true,
    outcome: "all_clear",
    triageReason: null,
    reply: mayReply && facts.ok ? postopAllClearAck(facts.facts) : null,
  };
}
