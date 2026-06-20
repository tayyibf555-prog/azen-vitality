import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { isStopKeyword, addSuppression } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  findTargetByAddress,
  insertInboundTouch,
  getCadenceByTarget,
  updateCadence,
  getTargetContext,
} from "@/lib/reactivation/repository";
import Anthropic from "@anthropic-ai/sdk";
import { DentallyClient } from "@/lib/dentally/client";
import { sendMessage } from "@/lib/messaging/send";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { AGENT_TOOLS, makeDispatch } from "@/lib/agent/tools";
import { runAgentTurn } from "@/lib/agent/run";
import {
  findOrCreateConversation,
  listMessages,
  appendMessage,
  setConversationStatus,
  stampInbound,
  isAgentEnabled,
} from "@/lib/agent/repository";
import type { AgentContext } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

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
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (token) {
    const sig = request.headers.get("x-twilio-signature") ?? "";
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/inbound"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const rawFrom = params["From"] ?? "";
  const isWhatsapp = rawFrom.startsWith("whatsapp:");
  const channel: MessageChannel = isWhatsapp ? "whatsapp" : "sms";
  const from = rawFrom.replace(/^whatsapp:/, "");
  const body = params["Body"] ?? "";

  const match = await findTargetByAddress(from);
  if (match) {
    const cadence = await getCadenceByTarget(match.targetId);
    await insertInboundTouch({
      targetId: match.targetId,
      cadenceId: cadence?.id ?? null,
      siteId: match.siteId,
      channel,
      body,
    });

    if (isStopKeyword(body)) {
      await addSuppression(match.siteId, channel, `patient:${match.targetId.split(":")[1]}`, "stop");
      return twiml();
    }

    if (cadence && cadence.status === "active") {
      await updateCadence(cadence.id, { status: "paused" });
    }

    const patientId = match.targetId.split(":")[1];
    const ctxRow = await getTargetContext(match.targetId);
    const conversation = await findOrCreateConversation({
      siteId: match.siteId,
      dentallyPatientId: patientId,
      patientName: ctxRow?.patientName ?? "there",
      channel,
      treatment: ctxRow?.treatment ?? null,
      fundingType: ctxRow?.fundingType ?? null,
    });
    await appendMessage({ conversationId: conversation.id, role: "patient", body });
    await stampInbound(conversation.id);

    if (!(await isAgentEnabled(match.siteId))) {
      // Agent paused for this site from the dashboard: route to a human, no auto-reply.
      await setConversationStatus(conversation.id, "needs_human");
      return twiml();
    }

    if (conversation.status === "needs_human") {
      return twiml(); // already handed over; log only
    }

    const context: AgentContext = {
      patientId,
      siteId: match.siteId,
      patientName: conversation.patientName,
      treatment: conversation.treatment,
      fundingType: conversation.fundingType,
    };

    let replyText = "";
    let escalated = false;
    try {
      const apiKey = process.env.DENTALLY_API_KEY ?? "";
      const dentally = new DentallyClient({ apiKey, baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co" });
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
      escalated = result.escalated;
      const booked = result.toolCalls.some((t) => t.name === "book");
      if (escalated || !replyText) {
        await setConversationStatus(conversation.id, "needs_human");
      } else if (booked) {
        await setConversationStatus(conversation.id, "booked");
      }
    } catch {
      escalated = true;
      await setConversationStatus(conversation.id, "needs_human");
    }

    const outbound = replyText || "Thanks, a member of our team will be in touch shortly.";
    await appendMessage({ conversationId: conversation.id, role: "agent", body: outbound });
    await sendMessage({ channel, to: from, body: outbound });
    return twiml();
  }

  return twiml();
}
