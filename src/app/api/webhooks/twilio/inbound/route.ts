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
import { getSite } from "@/lib/mock/clients";
import { listActiveUspTexts } from "@/lib/usp/repository";
import { AGENT_TOOLS, makeDispatch } from "@/lib/agent/tools";
import { runAgentTurn } from "@/lib/agent/run";
import { identifyByPhone } from "@/lib/agent/identify";
import { checkAgentReply, SAFE_HANDOVER } from "@/lib/agent/guardrail";
import { claimInboundMessage } from "@/lib/agent/idempotency";
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
import { isSystemEnabled } from "@/lib/systems/repository";

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
  const noshow = await handleNoshowInbound({ from, body, channel, dentally });
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
  // A reply may instead correlate to a recall outbound (recall has its own outbox).
  const recallTarget = target ? null : await findRecallTargetByAddress(from);
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

  // Cadence side-effects when this number is in a cadence. A reply pauses the
  // active sequence so we stop chasing once the patient engages. The reply may
  // correlate to either a reactivation or a recall cadence.
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
  } else if (recallTarget) {
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
  } else {
    // A reply may instead correlate to a treatment-coordinator follow-up. Log it
    // as an inbound coordinator_touch so the coordinator sweep pauses the cadence
    // (it skips any opportunity with an inbound touch) and stops chasing.
    const coordTarget = await findCoordinatorTargetByAddress(from);
    if (coordTarget) {
      await insertCoordinatorInboundTouch({
        opportunityId: coordTarget.opportunityId,
        siteId: coordTarget.siteId,
        channel,
        body,
      });
    }
  }

  // STOP keyword: suppress the right ref and do not reply.
  if (isStopKeyword(body)) {
    // A failed suppression WRITE must not surface a 500: Twilio would retry the
    // STOP webhook, and the retry would hit the same DB error and loop. The
    // inbound is already recorded above as an inbound touch, so staff can see
    // the opt-out even if this write failed; the next STOP (or the status
    // webhook) will re-attempt it. Swallow and still return a clean 2xx TwiML.
    try {
      if (target) {
        await addSuppression(target.siteId, channel, `patient:${target.targetId.split(":")[1]}`, "stop");
      } else if (recallTarget) {
        await addSuppression(recallTarget.siteId, channel, `patient:${recallTarget.targetId.split(":")[1]}`, "stop");
      } else if (identity) {
        await addSuppression(siteId, channel, `patient:${identity.patientId}`, "stop");
      } else {
        // Unrecognised number (e.g. a speed-to-lead lead): suppress by address so
        // the opt-out is honoured on the channel they actually used.
        await addSuppression(siteId, channel, from, "stop");
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
  const agentClientId = getSite(siteId)?.clientId;
  const agentSystem = channel === "whatsapp" ? "whatsapp" : "booking-agent";
  if (agentClientId && !(await isSystemEnabled(agentClientId, agentSystem))) {
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
    return twiml();
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
  };

  let replyText = "";
  try {
    const prior = await listMessages(conversation.id);
    const history = prior.map((m) => ({
      role: m.role === "patient" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    }));
    const result = await runAgentTurn(history, {
      anthropic: new Anthropic(),
      dispatch: makeDispatch({ dentally, context }),
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
    } else {
      const booked = result.toolCalls.some((t) => t.name === "book");
      if (result.escalated || !replyText) {
        await setConversationStatus(conversation.id, "needs_human");
      } else if (booked) {
        await setConversationStatus(conversation.id, "booked");
      }
    }
  } catch {
    await setConversationStatus(conversation.id, "needs_human");
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
  return twiml();
}
