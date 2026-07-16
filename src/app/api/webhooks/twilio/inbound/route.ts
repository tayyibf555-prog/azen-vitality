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
  setTargetStatus as setOutreachTargetStatus,
  getCampaignIdForTarget as getOutreachCampaignIdForTarget,
  getCampaign as getOutreachCampaign,
} from "@/lib/outreach/repository";
import { handleNoshowInbound } from "@/lib/noshow/inbound";
import {
  findTargetByAddress as findCoordinatorTargetByAddress,
  insertInboundTouch as insertCoordinatorInboundTouch,
} from "@/lib/coordinator/repository";
import { isOutsideHours, getSiteById } from "@/lib/after-hours/hours";
import { insertCapture, hasOpenCaptureFrom } from "@/lib/after-hours/repository";
import Anthropic from "@anthropic-ai/sdk";
import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { getSite, getSites, getClient } from "@/lib/mock/clients";
import { findLeadByConversation } from "@/lib/speed-to-lead/repository";
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
} from "@/lib/agent/repository";
import type { AgentContext, PhoneIdentity } from "@/lib/agent/types";
import { isSystemEnabled, isSystemEnabledForSend } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// Site to attribute an inbound from an unrecognised number to (one practice
// number serves every site in this pilot). Overridable per deployment.
const DEFAULT_SITE_ID = process.env.AGENT_DEFAULT_SITE_ID ?? "site-cc";

// Per-sender cost/rate ceiling on the agent turn. A spammer texting the practice
// number must not be able to run unbounded Claude tool-loops. Matches the
// consumeBudget() guard the sibling public AI endpoints use. Overridable.
const SENDER_BUDGET_LIMIT = Number(process.env.AGENT_SENDER_BUDGET_LIMIT ?? "20");
const SENDER_BUDGET_WINDOW_SECONDS = Number(process.env.AGENT_SENDER_BUDGET_WINDOW ?? "3600");

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

function twiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(request: Request): Promise<Response> {
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

  // Segment-outreach reply linkage. A reply from an outreach target pauses its
  // cadence (status 'replied') so the sweep stops texting once the patient engages,
  // and carries a campaign HINT into the agent context below so the booking agent
  // offers the campaign's clinician first. Correlated by the resolved to_address of
  // the last send (exactly the recall pattern), not the raw phone, so it matches the
  // precise address messaged. Best-effort: any lookup failure must never break the
  // webhook, so the whole block is guarded.
  let outreachInvite: AgentContext["outreachInvite"] | undefined;
  try {
    const outreachTarget = await findOutreachTargetByAddress(from);
    if (outreachTarget) {
      const campaignId = await getOutreachCampaignIdForTarget(outreachTarget.targetId);
      await insertOutreachInboundTouch({
        targetId: outreachTarget.targetId,
        campaignId,
        siteId: outreachTarget.siteId,
        channel,
        body,
      });
      // Pause: 'replied' is excluded from the sweep's due set and clears next_due_at.
      await setOutreachTargetStatus(outreachTarget.targetId, "replied", {
        nextDueAt: null,
        endedAt: new Date().toISOString(),
      });
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
            : null;
      // This webhook only ever receives phone channels; the same number gets both.
      const channels: MessageChannel[] = ["sms", "whatsapp"];
      const clientId = getSite(siteId)?.clientId ?? "vitality";
      const suppressSites = new Set<string>(getSites(clientId).map((s) => s.id));
      // Belt and braces: always include the resolved site and any matched target's
      // own site, so the opt-out covers them even if the site list is incomplete.
      suppressSites.add(siteId);
      if (target) suppressSites.add(target.siteId);
      if (recallTarget) suppressSites.add(recallTarget.siteId);
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
  // Owner kill switch: the SMS agent ("booking-agent") and the WhatsApp agent are
  // switched independently. When the relevant one is off, hand to a human with no
  // auto-reply. The inbound is already recorded above, and STOP/opt-out was
  // handled earlier, so turning the agent off never blocks opt-out.
  const agentClientId = getSite(siteId)?.clientId ?? "vitality";
  const agentSystem = channel === "whatsapp" ? "whatsapp" : "booking-agent";
  if (!(await isSystemEnabledForSend(agentClientId, agentSystem))) {
    await setConversationStatus(conversation.id, "needs_human");
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
    await alertStaffHandover({ patientName: displayName, reason: "throttled" });
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

  const context: AgentContext = {
    patientId,
    siteId,
    phone: from,
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
    const prior = await listMessages(conversation.id);
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
      systemPrompt: buildSystemPrompt(context),
      tools: AGENT_TOOLS,
    });
    replyText = result.replyText;

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
      const booked = result.toolCalls.some((t) => t.name === "book");
      if (result.escalated || !replyText) {
        await setConversationStatus(conversation.id, "needs_human");
        handoverReason = result.escalated ? "escalated" : "no_reply";
      } else if (booked) {
        await setConversationStatus(conversation.id, "booked");
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
    await alertStaffHandover({ patientName: displayName, reason: handoverReason });
  }
  } finally {
    await releaseCronLock(turnLock);
  }
  return twiml();
}
