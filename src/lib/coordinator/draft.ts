import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import type { TouchChannel, TreatmentOpportunity } from "./types";
import { getSite } from "@/lib/mock/clients";
import { uspPromptLine } from "@/lib/usp/prompt";
import { listActiveUspTexts } from "@/lib/usp/repository";

export function buildDraftPrompt(o: TreatmentOpportunity, channel: TouchChannel, usps?: string[]) {
  const system = [
    "You are a warm, professional treatment coordinator for a UK dental practice.",
    "Write a short outreach message to a patient who accepted treatment but has not completed it.",
    "Rules:",
    "- Lead with the patient by first name and the specific treatment.",
    "- Reference the outstanding value in GBP using the £ symbol.",
    "- Offer to discuss finance or a payment plan.",
    "- Give one clear next step (book a call or an appointment).",
    "- Under 90 words. Friendly, not pushy.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    uspPromptLine(usps),
    "- Plain text only, suitable for the requested channel.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const user = [
    `Channel: ${channel}`,
    `Patient: ${o.patientName}`,
    `Treatment: ${o.treatment}`,
    `Planned value (GBP): ${o.plannedValue}`,
    `Outstanding (GBP): ${o.amountOutstanding}`,
    `Accepted at: ${o.acceptedAt}`,
    `Finance already presented: ${o.financePresented ? "yes" : "no"}`,
  ].join("\n");

  return { system, user };
}

export interface DraftResult { body: string; rationale: string; }

export async function draftOutreach(
  o: TreatmentOpportunity,
  channel: TouchChannel,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const usps = await listActiveUspTexts(getSite(o.siteId)?.clientId ?? "");
  const { system, user } = buildDraftPrompt(o, channel, usps);
  const rationale =
    `£${o.amountOutstanding} outstanding on ${o.treatment}, ` +
    `${o.financePresented ? "finance presented" : "finance not yet presented"}.`;
  const msg = await client.messages.create({
    model: SONNET,
    thinking: NO_THINKING,
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: user }],
  });
  const body = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { body, rationale };
}
