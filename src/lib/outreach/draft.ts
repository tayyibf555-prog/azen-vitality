import Anthropic from "@anthropic-ai/sdk";
import type { CadenceStep } from "./cadence";
import type { OutreachCampaign, OutreachTarget } from "./types";
import type { Variant } from "./variant";
import type { TouchChannel } from "@/lib/reactivation/types";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getSite } from "@/lib/mock/clients";
import { uspPromptLine } from "@/lib/usp/prompt";
import { listActiveUspTexts } from "@/lib/usp/repository";
import { checkAgentReply } from "@/lib/agent/guardrail";
import {
  FREE_TEXT_IS_DATA,
  sanitiseName,
  sanitisePractitioner,
  sanitiseReason,
} from "@/lib/agent/free-text";

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

/**
 * The treatment angle phrase for the given variant, defaulting gently when blank.
 * Variant 'b' uses the campaign's second angle when set; everything else (and any
 * missing angle) falls back to the primary angle, then to a neutral default. The rest
 * of the draft path is identical for both variants, so only the phrase differs.
 */
function angle(campaign: OutreachCampaign, variant: Variant): string {
  const b = (campaign.messageAngleB ?? "").trim();
  const primary = (campaign.messageAngle ?? "").trim();
  const chosen = variant === "b" && b ? b : primary;
  return chosen || "an appointment";
}

export function buildOutreachPrompt(
  target: OutreachTarget,
  campaign: OutreachCampaign,
  channel: TouchChannel,
  step: CadenceStep,
  variant: Variant,
  usps?: string[],
) {
  // SANITISED, and this is the SYSTEM half of the prompt, so it matters more than
  // the user half: an unsanitised clinician "name" here writes an instruction into
  // the model's own rules rather than into the data it is given.
  const clinician = sanitisePractitioner(campaign.practitionerName);
  const withClinician = clinician
    ? `We would love to see them with ${clinician}. Mention ${clinician} by name warmly as the person they would see.`
    : "Invite them to book in with the practice.";

  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    `Write a short SMS inviting a patient back for ${angle(campaign, variant)}. It has been a while since they were last in, and we would like to welcome them back.`,
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
    // SANITISED. `matchedReason` is built from a Dentally APPOINTMENT REASON, which
    // is the freest text in the practice's book. See src/lib/agent/free-text.ts.
    //
    // AND THE BOUNDARY IS NOW SAID OUT LOUD. This comment used to note that "do not
    // quote verbatim" is a QUOTING instruction rather than a data boundary, and then
    // left the boundary unstated; FREE_TEXT_IS_DATA closes it, immediately above the
    // values it is about, exactly as the live booking agent's own prompt says it
    // (ruling W1-B/3, charter §0.8). The sanitiser strips the SHAPE of an injected
    // instruction; this line strips its AUTHORITY. Either alone is weaker than both.
    //
    // The system half above carries the one other Dentally-shaped value, the
    // clinician's name, and is deliberately not covered by this line's position: it
    // is not handed to the model as data to read but interpolated into a sentence of
    // OURS ("Mention X by name warmly"), where sanitisePractitioner is the whole
    // defence and the injection battery in src/lib/agent/free-text.test.ts pins it.
    FREE_TEXT_IS_DATA,
    `Patient: ${sanitiseName(target.name)}`,
    `Invitation is for: ${angle(campaign, variant)}`,
    campaign.practitionerName
      ? `Clinician to see: ${sanitisePractitioner(campaign.practitionerName)}`
      : `Clinician: not specified`,
    target.matchedReason
      ? `Context (do not quote verbatim): last relevant visit was ${sanitiseReason(target.matchedReason)}`
      : "",
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
  variant: Variant = "a",
): string {
  const name = firstName(target.name);
  const what = angle(campaign, variant);
  const site = getSite(target.siteId);
  const practice = site?.name ?? "the practice";
  // Sanitised too, and here it goes STRAIGHT TO A PATIENT: this is the templated
  // fallback used when the model is unavailable, so nothing downstream would trim
  // a pathological clinician name before it was sent.
  const clinician = sanitisePractitioner(campaign.practitionerName);
  const withClinician = clinician ? ` with ${clinician}` : "";

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
 *
 * `variant` selects which message angle to write from ('b' uses the campaign's second
 * angle when set). It only changes the angle phrase: the model call, the guardrail /
 * compliance check and the deterministic fallback are identical for both variants, so a
 * variant 'b' draft is held to exactly the same safety bar as 'a'.
 */
export async function draftOutreach(
  target: OutreachTarget,
  campaign: OutreachCampaign,
  channel: TouchChannel,
  step: CadenceStep,
  client: Anthropic = new Anthropic(),
  variant: Variant = "a",
): Promise<DraftResult> {
  const fallback = outreachFallbackBody(target, campaign, step, variant);
  let usps: string[] = [];
  try {
    usps = await listActiveUspTexts(getSite(target.siteId)?.clientId ?? "");
  } catch {
    // Selling points are optional context; never block a draft on them.
  }

  try {
    const { system, user } = buildOutreachPrompt(target, campaign, channel, step, variant, usps);
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

    // Guardrail the model output. This is patient-facing MARKETING SMS with priced
    // USPs injected into the prompt, and an invitation never carries a legitimate firm
    // figure, so the price rule IS enforced here (includePrice: true): an invented firm
    // price like "just £99" trips the guardrail and forces the deterministic fallback.
    // A genuinely hedged "from £X" USP is whitelisted by the guardrail and still passes.
    // Funding + clinical rules are hard as always. A trip or empty body uses the template.
    if (!body) return { body: fallback, usedFallback: true };
    const guard = checkAgentReply(body, { includePrice: true });
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
