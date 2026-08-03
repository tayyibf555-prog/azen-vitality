// DEV/TEST harness for the booking agent (browser chat at /agent-test).
// Bypasses Twilio/SMS: a pure in-browser conversation against live Claude + the
// mock Dentally diary. Not for production; remove or gate before going live.
import Anthropic from "@anthropic-ai/sdk";
import { DentallyClient } from "@/lib/dentally/client";
import { buildSystemPrompt } from "@/lib/agent/prompt";
import { AGENT_TOOLS, makeDispatch } from "@/lib/agent/tools";
import { runAgentTurn } from "@/lib/agent/run";
import {
  findOrCreateConversation,
  listMessages,
  appendMessage,
  setConversationStatus,
  stampInbound,
} from "@/lib/agent/repository";
import type { AgentContext } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const TEST_PATIENT = { siteId: "site-cc", dentallyPatientId: "pat-010", patientName: "Harold Pemberton" };

export async function POST(request: Request): Promise<Response> {
  // Dev-only harness: it runs the booking agent with no auth, so it must never
  // be reachable in production (the live deploy locks every other route down).
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    treatment?: string;
    reset?: boolean;
  };
  const message = (body.message ?? "").trim();
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  const treatment = body.treatment?.trim() || "Invisalign";

  // On reset, close any open test conversation so the next one starts fresh.
  if (body.reset) {
    const open = await findOrCreateConversation({
      ...TEST_PATIENT, channel: "test", treatment, fundingType: "private",
    });
    await setConversationStatus(open.id, "closed");
  }

  const conversation = await findOrCreateConversation({
    ...TEST_PATIENT, channel: "test", treatment, fundingType: "private",
  });
  await appendMessage({ conversationId: conversation.id, role: "patient", body: message });
  await stampInbound(conversation.id);

  const context: AgentContext = {
    patientId: conversation.dentallyPatientId,
    siteId: conversation.siteId,
    patientName: conversation.patientName,
    treatment: conversation.treatment,
    fundingType: conversation.fundingType,
  };
  // THE ONE CLIENT IN THIS APP THAT IS DELIBERATELY WRITABLE OUTSIDE write.ts.
  //
  // This harness drives the real booking agent, so makeDispatch's book / cancel /
  // register_patient tools call createAppointment / cancelAppointment /
  // createPatient on it. DentallyClient now defaults to readOnly, so the false is
  // written out loud rather than inherited: this is the intent, not an omission.
  //
  // TWO THINGS KEEP IT SAFE, AND NEITHER IS THIS LINE. The route 404s whenever
  // NODE_ENV === "production" (above), and makeDispatch refuses every write tool
  // unless isDentallyWriteEnabled(). Note what this line does NOT do: baseUrl
  // still falls back to https://api.dentally.co when DENTALLY_BASE_URL is unset,
  // so a dev machine with a real key and no base URL is pointed at the live book.
  // Set DENTALLY_BASE_URL to the local mock before using this harness.
  const dentally = new DentallyClient({
    apiKey: process.env.DENTALLY_API_KEY ?? "x",
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
    readOnly: false,
  });

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
  }).catch(() => null);

  let reply: string;
  let status = conversation.status;
  if (!result || result.escalated || !result.replyText) {
    reply = result?.replyText || "Thanks, a member of our team will be in touch shortly.";
    status = "needs_human";
    await setConversationStatus(conversation.id, "needs_human");
  } else {
    reply = result.replyText;
    if (result.toolCalls.some((t) => t.name === "book")) {
      status = "booked";
      await setConversationStatus(conversation.id, "booked");
    }
  }
  await appendMessage({ conversationId: conversation.id, role: "agent", body: reply });

  return Response.json({
    conversationId: conversation.id,
    reply,
    status,
    toolCalls: result?.toolCalls ?? [],
  });
}
