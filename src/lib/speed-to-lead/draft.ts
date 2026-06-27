import Anthropic from "@anthropic-ai/sdk";
import { SONNET } from "@/lib/ai/models";
import type { Client } from "@/lib/types";
import { getSite } from "@/lib/mock/clients";
import { uspPromptLine } from "@/lib/usp/prompt";
import { listActiveUspTexts } from "@/lib/usp/repository";
import type { LeadChannel, SpeedToLeadLead } from "./types";

/** First name for a warm opener, falling back to the whole name. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

/**
 * Optional campaign tailoring. When a lead came through a targeted Smile Assessment
 * campaign, the goal orients the message and the ideal-customer note tunes the TONE
 * only. The ideal-customer text is INTERNAL targeting copy and must never be quoted
 * back to the patient.
 */
export interface CampaignContext {
  goal: string; // human label, e.g. "Dental implants"
  idealCustomer: string | null;
}

export function buildFirstContactPrompt(
  lead: SpeedToLeadLead,
  channel: LeadChannel,
  client?: Client,
  campaign?: CampaignContext,
  usps?: string[],
) {
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
    campaign
      ? `- This enquiry came through a campaign about ${campaign.goal}. Orient the message gently around that area.`
      : null,
    campaign?.idealCustomer
      ? `- INTERNAL audience note (never quote this back to them, use it only to pitch the tone): ${campaign.idealCustomer}`
      : null,
    "- Under 60 words. Friendly, brief, never pushy.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    uspPromptLine(usps),
    "- Plain text only, suitable for the requested channel.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

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
  campaign?: CampaignContext,
  anthropic: Anthropic = new Anthropic(),
): Promise<FirstContactResult> {
  const usps = await listActiveUspTexts(getSite(lead.siteId)?.clientId ?? "");
  const { system, user } = buildFirstContactPrompt(lead, channel, client, campaign, usps);
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
