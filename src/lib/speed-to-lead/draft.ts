import Anthropic from "@anthropic-ai/sdk";
import { SONNET } from "@/lib/ai/models";
import type { Client } from "@/lib/types";
import type { LeadChannel, SpeedToLeadLead } from "./types";

/** First name for a warm opener, falling back to the whole name. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

export function buildFirstContactPrompt(lead: SpeedToLeadLead, channel: LeadChannel, client?: Client) {
  const practice = client?.name ?? "our dental practice";
  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    `You work for ${practice}.`,
    "Someone has just enquired with the practice. Write the very first reply that reaches them within seconds of their enquiry.",
    "Make it feel personal and human, not a templated auto-reply. Acknowledge their interest and invite them to book.",
    "Rules:",
    "- Lead with the person by first name.",
    "- Give one clear next step: offer to find them a time that suits.",
    lead.treatmentInterest
      ? `- Mention what they enquired about (${lead.treatmentInterest}) naturally, without overpromising.`
      : "- Keep it general, since they did not say what they are interested in.",
    "- Under 60 words. Friendly, brief, never pushy.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    "- Plain text only, suitable for the requested channel.",
  ].join("\n");

  const user = [
    `Channel: ${channel}`,
    `Name: ${firstName(lead.name)}`,
    `Treatment interest: ${lead.treatmentInterest ?? "not specified"}`,
    `Enquiry source: ${lead.source}`,
  ].join("\n");

  return { system, user };
}

export interface FirstContactResult {
  body: string;
}

export async function draftFirstContact(
  lead: SpeedToLeadLead,
  channel: LeadChannel,
  client?: Client,
  anthropic: Anthropic = new Anthropic(),
): Promise<FirstContactResult> {
  const { system, user } = buildFirstContactPrompt(lead, channel, client);
  const msg = await anthropic.messages.create({
    model: SONNET,
    max_tokens: 300,
    system,
    messages: [{ role: "user", content: user }],
  });
  const body = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { body };
}
