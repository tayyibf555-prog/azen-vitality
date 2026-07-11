import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
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
 * Strip output-guardrail trigger words (NHS, private, band N, funding) from the
 * CALLER-TYPED treatment interest before it is injected into the draft prompt. A
 * patient who types "NHS check-up" as their interest would otherwise be echoed by the
 * model, the deterministic guardrail would block the reply, and contactLead retires
 * the lead to terminal 'lost' — losing a real enquiry over the patient's own wording.
 * The remaining text ("check-up") is safe; if nothing is left, treat it as unspecified.
 */
export function sanitiseInterest(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\bnhs\b/gi, "")
    .replace(/\bprivate(?:ly)?\b/gi, "")
    .replace(/\bband\s*[123]\b/gi, "")
    .replace(/\bfunding\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
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
  assessment?: string[],
) {
  const practice = client?.name ?? "our dental practice";
  const interest = sanitiseInterest(lead.treatmentInterest);
  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    `You work for ${practice}.`,
    "Someone has just enquired with the practice. Write the very first reply that reaches them within seconds of their enquiry.",
    "Make it feel personal and human, not a templated auto-reply. Acknowledge their interest and invite them to book.",
    "Rules:",
    "- Lead with the person by first name.",
    "- Give one clear next step: offer to find them a time that suits.",
    interest
      ? `- Mention what they enquired about (${interest}) naturally, without overpromising.`
      : "- Keep it general, since they did not say what they are interested in.",
    campaign
      ? `- This enquiry came through a campaign about ${campaign.goal}. Orient the message gently around that area.`
      : null,
    campaign?.idealCustomer
      ? `- INTERNAL audience note (never quote this back to them, use it only to pitch the tone): ${campaign.idealCustomer}`
      : null,
    assessment && assessment.length > 0
      ? "- Their smile assessment answers are provided as context. Use them ONLY to pitch tone and urgency (for example how soon they want to start). Never recite their answers back, never mention the questionnaire mechanics, and never reference money or how they would pay."
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
    `Treatment interest: ${interest ?? "not specified"}`,
    `Enquiry source: ${lead.source}`,
    ...(assessment && assessment.length > 0
      ? ["Smile assessment context (their own answers):", ...assessment.map((l) => `- ${l}`)]
      : []),
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
  assessment?: string[],
  anthropic: Anthropic = new Anthropic(),
): Promise<FirstContactResult> {
  const usps = await listActiveUspTexts(getSite(lead.siteId)?.clientId ?? "");
  const { system, user } = buildFirstContactPrompt(lead, channel, client, campaign, usps, assessment);
  const msg = await anthropic.messages.create({
    model: SONNET,
    thinking: NO_THINKING,
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
