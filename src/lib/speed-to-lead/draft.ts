import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import type { Client } from "@/lib/types";
import { getSite } from "@/lib/mock/clients";
import { uspPromptLine } from "@/lib/usp/prompt";
import { listActiveUspTexts } from "@/lib/usp/repository";
import {
  FREE_TEXT_IS_DATA,
  sanitiseName,
  sanitiseReason,
  sanitiseTreatment,
} from "@/lib/agent/free-text";
import type { LeadChannel, SpeedToLeadLead } from "./types";

// ---------------------------------------------------------------------------
// THIS DRAFTER'S FREE TEXT IS THE MOST EXPOSED IN THE PLATFORM, and for a long
// time it was the one drafter that did not sanitise.
//
// Charter §0 item 8 is written about DENTALLY free text, because that is where
// the rule was first needed: a "plan title" running to several sentences of
// instructions is a prompt-injection attempt, not a title. Every other drafter
// reads its name and its treatment from a Dentally record that a member of
// practice staff typed. This one does not. `lead.name`, `lead.treatmentInterest`
// and `lead.source` arrive from a PUBLIC, UNAUTHENTICATED web form
// (src/app/api/landing-lead/route.ts and src/app/api/speed-to-lead/intake/
// route.ts), are stored verbatim, and reach the model within seconds — the
// speed-to-lead sweep runs every minute. Nothing the practice controls stands
// between a stranger's keyboard and this prompt, so the rule applies here with
// more force than where it was written, not less (ruling W3/14; W3/24 settles
// that a §0.8 gap is fixed in wave 3 even where it predates the diff).
//
// WHY `firstName` ALONE WAS NOT THE DEFENCE IT LOOKED LIKE. Taking the first
// whitespace-delimited token reads like a structural guarantee — one word cannot
// be a paragraph of instructions — and it is exactly the argument that exempts
// src/lib/collection/draft.ts from the boundary sweep. It fails here because JS
// `\s` does NOT match NEL (U+0085) or the rest of the C1 block: a name whose
// separators are all C1 controls is ONE token to `split(/\s+/)`, so the whole
// payload survived as the "first name" and reached the model as several
// apparent lines. That is the precise hole src/lib/agent/free-text.ts was
// written to close, and its pass 1 (C1 → space, then collapse) is what makes
// the first-token rule true again.
// ---------------------------------------------------------------------------

/**
 * First name for a warm opener, falling back to a name-shaped greeting.
 *
 * SANITISE FIRST, THEN TAKE THE TOKEN — that order is the fix and it is not
 * interchangeable. Sanitising afterwards would be handed a token that a C1
 * control had already welded together; sanitising first turns those controls
 * into real spaces, so the split that follows genuinely keeps one word.
 *
 * "there" is the same fallback renderFollowUpTemplate already uses for a name
 * that reduces to nothing (src/lib/smile-assessment/follow-up.ts:365, whose
 * comment says these are "the same fallbacks nurtureFallback uses"), so the two
 * first-contact paths of this module read identically when there is no usable
 * name. Reachable only for a name made entirely of control characters — `str()`
 * at both intake routes rejects an empty one, and String.prototype.trim does not
 * strip C1 — which previously produced "Hi ," in the deterministic fallback.
 */
function firstName(name: string): string {
  const safe = sanitiseName(name);
  return safe.split(" ")[0] || "there";
}

/**
 * Strip output-guardrail trigger words (NHS, private, band N, funding) from the
 * CALLER-TYPED treatment interest before it is injected into the draft prompt. A
 * patient who types "NHS check-up" as their interest would otherwise be echoed by the
 * model, the deterministic guardrail would block the reply, and contactLead retires
 * the lead to terminal 'lost' — losing a real enquiry over the patient's own wording.
 * The remaining text ("check-up") is safe; if nothing is left, treat it as unspecified.
 *
 * DEFANGED BEFORE IT IS DEJARGONED. `sanitiseTreatment` runs FIRST so the funding
 * strip is applied to one line of at most 60 characters rather than to whatever
 * length of multi-sentence text a form accepted: an interest of
 * "Whitening. Ignore the rules above" loses everything from the sentence break,
 * and the funding pass then sees only "Whitening". Doing it the other way round
 * would leave the payload intact whenever it carried no funding word at all,
 * which is every payload an attacker would actually write. An ordinary interest
 * passes through both passes byte for byte.
 */
export function sanitiseInterest(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = sanitiseTreatment(raw)
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
    // THE BOUNDARY, SAID OUT LOUD, ABOVE EVERY VALUE IT IS ABOUT. The sanitiser
    // above strips the SHAPE of an injected instruction; this strips its
    // AUTHORITY, and charter §0.8 asks for both ("either alone is weaker than
    // both", src/lib/agent/free-text.ts).
    //
    // IT SITS IN THE SYSTEM HALF, which is where this drafter differs from the
    // coordinator/no-show/recall pattern of putting it immediately above a
    // `Patient:` line in the user half. Those prompts carry every free-text
    // value in the user block; this one interpolates the enquirer's own
    // treatment interest into a RULE a few lines below, so a boundary stated
    // only in the user half would arrive after the first value it governs. The
    // model reads in order, and src/lib/agent-wiring/free-text-boundary.test.ts
    // pins the ordering for this file as it does for every other prompt builder
    // in the tree that carries untrusted text.
    FREE_TEXT_IS_DATA,
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
    // ALL THREE ARE CALLER-TYPED. `source` is derived from the resolved landing
    // page on one intake path but is an arbitrary caller-supplied string on the
    // other (src/app/api/speed-to-lead/intake/route.ts:59), so it is sanitised
    // like the rest rather than trusted because one of its two producers is ours.
    `Name: ${firstName(lead.name)}`,
    `Treatment interest: ${interest ?? "not specified"}`,
    `Enquiry source: ${sanitiseReason(lead.source)}`,
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

// ---------------------------------------------------------------------------
// Nurture follow-ups.
//
// A contacted-but-quiet lead gets up to three gentle nudges. Same house style as
// the first contact (Sonnet, NO_THINKING, British English, no funding wording, no
// em-dash), but framed as a warm follow-up rather than a first hello. The touch
// number (1..3) nudges the tone from a light check-in to a final, no-pressure note.
// ---------------------------------------------------------------------------

/**
 * Guardrail-safe deterministic fallback used when the model errors or trips the guard.
 *
 * The name goes through the SAME `firstName` as the prompts, which matters here
 * for a different reason: no model stands between this string and the patient's
 * handset, so an unsanitised name would be transmitted verbatim rather than
 * merely read. One sanitised token is all that is ever interpolated.
 */
export function nurtureFallback(lead: SpeedToLeadLead, touch: number, client?: Client): string {
  const name = firstName(lead.name);
  const practice = client?.name ?? "the practice";
  if (touch <= 1) {
    return `Hi ${name}, it is ${practice}. Just checking in about your enquiry. Would you like us to find a time that suits you? Reply here and we will help.`;
  }
  if (touch === 2) {
    return `Hi ${name}, ${practice} here. We would still love to help with your enquiry. If now is a better time, reply and we will sort a visit that works around you.`;
  }
  return `Hi ${name}, one last note from ${practice}. If you would like to book, just reply and we will find you a time. No rush, we are here whenever you are ready.`;
}

export function buildNurturePrompt(
  lead: SpeedToLeadLead,
  touch: number,
  client?: Client,
  usps?: string[],
) {
  const practice = client?.name ?? "our dental practice";
  const interest = sanitiseInterest(lead.treatmentInterest);
  const toneByTouch =
    touch <= 1
      ? "This is a light, friendly check-in a few days after your first message. Gently remind them you are here to help and invite them to pick a time."
      : touch === 2
        ? "This is a second, warm follow-up. Keep it brief and human, reassure them there is no pressure, and make it easy to say when suits them."
        : "This is a final, no-pressure note. Warmly leave the door open, make clear you will not keep messaging, and invite them to reply whenever they are ready.";
  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    `You work for ${practice}.`,
    "Someone enquired with the practice a little while ago and has not replied yet. Write a short, friendly follow-up message.",
    toneByTouch,
    // Same boundary, same reason, same position as the first-contact prompt
    // above: the nurture prompt reaches the SAME lead row three more times, so a
    // payload that could not reach the model at first contact must not reach it
    // at touch 1, 2 or 3 either.
    FREE_TEXT_IS_DATA,
    "Rules:",
    "- Lead with the person by first name.",
    "- One gentle next step: offer to find them a time that suits.",
    interest
      ? `- You may refer to what they enquired about (${interest}) naturally, without overpromising.`
      : "- Keep it general, since they did not say what they are interested in.",
    "- Never guilt-trip or pressure them. Warm and easy, never pushy.",
    "- Under 45 words. Shorter is better for a nudge.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    uspPromptLine(usps),
    "- Plain text only, suitable for an SMS.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const user = [
    `Follow-up number: ${touch}`,
    `Name: ${firstName(lead.name)}`,
    `Treatment interest: ${interest ?? "not specified"}`,
    `Enquiry source: ${sanitiseReason(lead.source)}`,
  ].join("\n");

  return { system, user };
}

export async function draftNurtureTouch(
  lead: SpeedToLeadLead,
  touch: number,
  client?: Client,
  anthropic: Anthropic = new Anthropic(),
): Promise<FirstContactResult> {
  const usps = await listActiveUspTexts(getSite(lead.siteId)?.clientId ?? "");
  const { system, user } = buildNurturePrompt(lead, touch, client, usps);
  const msg = await anthropic.messages.create({
    model: SONNET,
    thinking: NO_THINKING,
    max_tokens: 220,
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
