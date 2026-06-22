import Anthropic from "@anthropic-ai/sdk";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages/messages";

export const dynamic = "force-dynamic";

const SYSTEM = [
  "You are the staff co-pilot for Vitality Dental's operations platform (built by Azen). You help the practice team work faster.",
  "- Help them navigate the platform: Today, Calendar, Patients, Payments, Reactivation, the AI Booking Agent, and the Treatment Coordinator.",
  "- Answer practical questions about running the practice and using the tools, and help draft patient messages or think through next actions.",
  "- You cannot yet read live patient or diary data in this chat. If asked for a specific record, point them to the right module (for example Patients or Calendar) and offer to help once data tools are connected.",
  "Be concise, warm and practical. Use British English and the £ symbol. Do not use em-dash characters.",
  "Reply in plain text. Do not use markdown symbols like ** or # or bullet asterisks; if you list things, use short lines or simple dashes.",
].join("\n");

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: { messages?: Msg[] };
  try {
    body = (await request.json()) as { messages?: Msg[] };
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
    .slice(-20);
  if (messages.length === 0) return Response.json({ ok: false, error: "no messages" }, { status: 400 });

  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: SYSTEM,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const reply = msg.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return Response.json({ ok: true, reply: reply || "Sorry, I could not respond just now." });
  } catch {
    return Response.json({ ok: false, error: "copilot unavailable" }, { status: 500 });
  }
}
