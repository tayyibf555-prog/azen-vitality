import Anthropic from "@anthropic-ai/sdk";
import type { CadenceStep } from "./cadence";
import type { OutreachCampaign, OutreachTarget } from "./types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getSite } from "@/lib/mock/clients";
import { uspPromptLine } from "@/lib/usp/prompt";
import { listActiveUspTexts } from "@/lib/usp/repository";
import { checkAgentReply } from "@/lib/agent/guardrail";

const PURPOSE_TONE: Record<CadenceStep["purpose"], string> = {
  nudge: "This is a first, warm invitation. Keep it short and friendly.",
  offer: "This is a follow up. Make it easy to act now and offer to find a time that suits them.",
  final: "This is a final, polite invitation. Make it easy to say yes and signal we will not keep messaging.",
};

/** The patient's first name, for a warm greeting. */
export function firstName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "there";
  return trimmed.split(/\s+/)[0];
}

/** The treatment angle phrase, defaulting gently when the campaign left it blank. */
function angle(campaign: OutreachCampaign): string {
  const a = (campaign.messageAngle ?? "").trim();
  return a || "an appointment";
}

export function buildOutreachPrompt(
  target: OutreachTarget,
  campaign: OutreachCampaign,
  channel: TouchChannel,
  step: CadenceStep,
  usps?: string[],
) {
  const withClinician = campaign.practitionerName
    ? `We would love to see them with ${campaign.practitionerName}. Mention ${campaign.practitionerName} by name warmly as the person they would see.`
    : "Invite them to book in with the practice.";

  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    `Write a short SMS inviting a patient back for ${angle(campaign)}. It has been a while since they were last in, and we would like to welcome them back.`,
    withClinician,
    PURPOSE_TONE[step.purpose],
    "Rules:",
    "- Lead with the patient by first name.",
    "- Give one clear next step (reply to book their appointment).",
    "- Under 90 words. Warm and inviting, never pushy.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    "- Never give clinical advice or say what treatment they need. This is a friendly invitation, not a diagnosis.",
    uspPromptLine(usps),
    "- Plain text only, suitable for SMS.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const user = [
    `Channel: ${channel}`,
    `Cadence step: ${step.step} (${step.purpose})`,
    `Patient: ${target.name}`,
    `Invitation is for: ${angle(campaign)}`,
    campaign.practitionerName ? `Clinician to see: ${campaign.practitionerName}` : `Clinician: not specified`,
    target.matchedReason ? `Context (do not quote verbatim): last relevant visit was ${target.matchedReason}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { system, user };
}

/**
 * Deterministic, guardrail-safe SMS used when the model call fails OR its output
 * trips the guardrail. British English, no em-dash, no funding/clinical wording.
 * Pure (no I/O) so it is unit-testable.
 */
export function outreachFallbackBody(
  target: OutreachTarget,
  campaign: OutreachCampaign,
  step: CadenceStep,
): string {
  const name = firstName(target.name);
  const what = angle(campaign);
  const site = getSite(target.siteId);
  const practice = site?.name ?? "the practice";
  const withClinician = campaign.practitionerName ? ` with ${campaign.practitionerName}` : "";

  if (step.purpose === "final") {
    return (
      `Hi ${name}, one last note from ${practice}. If you would like to come in for ${what}${withClinician}, ` +
      `just reply and we will find a time that suits you. We will not message again after this.`
    );
  }
  if (step.purpose === "offer") {
    return (
      `Hi ${name}, it has been a while since we saw you at ${practice}. We would love to welcome you back for ${what}${withClinician}. ` +
      `Reply and we will sort a time that works for you.`
    );
  }
  return (
    `Hi ${name}, it is ${practice}. It has been a while since your last visit and we would love to see you again for ${what}${withClinician}. ` +
    `Reply to this message and we will help you book a time that suits you.`
  );
}

export interface DraftResult {
  body: string;
  /** True when the deterministic fallback was used (model failed or was blocked). */
  usedFallback: boolean;
}

/**
 * Draft one outreach SMS. Calls Sonnet (thinking disabled, the platform default),
 * then guardrail-checks the result with checkAgentReply BEFORE it can be queued.
 * If the model call throws OR its output trips the guardrail, fall back to the
 * deterministic template so a step is never queued empty and never queues jargon.
 */
export async function draftOutreach(
  target: OutreachTarget,
  campaign: OutreachCampaign,
  channel: TouchChannel,
  step: CadenceStep,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const fallback = outreachFallbackBody(target, campaign, step);
  let usps: string[] = [];
  try {
    usps = await listActiveUspTexts(getSite(target.siteId)?.clientId ?? "");
  } catch {
    // Selling points are optional context; never block a draft on them.
  }

  try {
    const { system, user } = buildOutreachPrompt(target, campaign, channel, step, usps);
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

    // Guardrail the model output. Price is excluded here (an invitation carries no
    // firm figure; a stray "from £X" USP is legitimate) but the funding + clinical
    // rules are hard. A trip or an empty body falls back to the safe template.
    if (!body) return { body: fallback, usedFallback: true };
    const guard = checkAgentReply(body, { includePrice: false });
    if (!guard.ok) {
      console.warn(
        `[outreach] draft blocked by guardrail (${guard.category}: ${JSON.stringify(guard.matched)}); using fallback`,
      );
      return { body: fallback, usedFallback: true };
    }
    return { body, usedFallback: false };
  } catch (err) {
    console.error("[outreach] draft model call failed; using deterministic fallback", err);
    return { body: fallback, usedFallback: true };
  }
}
