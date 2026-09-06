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
import { normaliseGsm7Typography } from "@/lib/recall/sms-budget";
import { gsm7LengthUnits, smsCost } from "@/lib/triage/sms-cost";
import {
  FREE_TEXT_IS_DATA,
  sanitiseName,
  sanitisePractitioner,
  sanitiseReason,
} from "@/lib/agent/free-text";

// ===========================================================================
// WHAT AN OUTREACH MESSAGE IS ALLOWED TO COST.
//
// Segment outreach is marketing SMS to a cohort the owner chose: three texts
// per patient over ten days, up to 100 patients a day per campaign, several
// campaigns at once. Until this block existed the ONLY thing between a model-
// written body and Twilio was the prompt line "- Under 90 words", which is an
// instruction rather than a ceiling, and in the wrong unit besides: 90 words of
// ordinary English is roughly 500 GSM-7 septets, FOUR billed segments, and one
// typographic apostrophe in that body (the character a model reaches for in
// "we'll") forces the whole message into UCS-2 at 67 units a segment — EIGHT.
// Nothing downstream would have caught it either: the drain's one universal
// backstop, checkAgentReply, tests for funding jargon, clinical advice and
// prices, never for length or alphabet.
//
// It is the number the client was shown. Dentally bills per MESSAGE (7p flat on
// the real August 2026 invoice); Twilio bills per SEGMENT; the break-even is
// 1.69 segments. Above it this platform is more expensive than the system it
// replaces, on the exact figure the fee was justified with, with nothing on any
// screen recording that it happened.
//
// The rule, the measure and the argument are src/lib/recall/sms-budget.ts's,
// written there by the recall lane and deliberately left dependency-free so it
// could be lifted; its own header names outreach as one of the modules still
// missing it. This module imports the typography pass from it and the measure
// from src/lib/triage/sms-cost.ts rather than growing a third copy of either
// (src/lib/agent/free-text.ts's header says why a third copy is worse than a
// cross-module import). The ceiling below is stated here because it is THIS
// module's contract; the shared home for all of it is checkAgentReply and the
// messaging drain, so a future send surface cannot forget — that lift is a
// handoff, not this lane's file.
// ===========================================================================

/**
 * The per-channel ceiling, in the unit that channel is billed in.
 *
 * SMS is ONE GSM-7 credit — the same 160 recall ships under (RECALL_MAX_UNITS)
 * and the same the pre-visit message ships under (src/lib/triage/copy.ts), so
 * the platform's highest-volume patient texts all cost the same to send. A
 * limit set at two segments would simply let every message grow to two.
 *
 * WhatsApp and email are not billed per segment; their numbers are the ones the
 * tree already uses as runaway guards in src/lib/collection/draft.ts, not
 * numbers invented here. OUTREACH_CADENCE is SMS-only by design, so `sms` is
 * the only ceiling a real send has ever met; the other two exist because the
 * channel is a parameter.
 */
export const OUTREACH_MAX_UNITS: Record<TouchChannel, number> = {
  sms: 160,
  whatsapp: 480,
  email: 1400,
};

/** The neutral invitation used when a campaign names no angle, and the last rung of the fallback ladder. */
export const DEFAULT_ANGLE = "an appointment";

export interface OutreachBodyBudget {
  /** Within this channel's ceiling. */
  ok: boolean;
  /** The measured size, in the unit the ceiling is expressed in (septets; escape-table characters count twice). */
  units: number;
  /** The ceiling that was applied. */
  limit: number;
  /** What the practice would actually be billed for, honestly counted. */
  segments: number;
  encoding: "gsm7" | "ucs2";
}

/**
 * Measure a composed body against its channel's ceiling.
 *
 * `units` is the LENGTH measure (a non-GSM letter counts as one, exactly as
 * src/lib/triage/sms-cost.ts rules: a patient is never left unmessaged because
 * of how their name is spelled). `segments` is the COST measure, reported
 * alongside so a log line can say WHY a message costs what it costs.
 */
export function measureOutreachBody(body: string, channel: TouchChannel): OutreachBodyBudget {
  const text = body ?? "";
  const limit = OUTREACH_MAX_UNITS[channel] ?? OUTREACH_MAX_UNITS.sms;
  const units = gsm7LengthUnits(text);
  const cost = smsCost(text);
  return { ok: units <= limit, units, limit, segments: cost.segments, encoding: cost.encoding };
}

/**
 * A body that will not fit its channel's ceiling even at the shortest rung of
 * the deterministic ladder below.
 *
 * Thrown rather than returned because the sweep destructures `{ body }` and
 * would otherwise have to be taught a new shape to ignore: a throw cannot be
 * ignored. It fails CLOSED — the outreach sweep isolates each campaign in its
 * own try/catch, so this campaign sends nothing this tick and the others are
 * untouched. A skipped tick is a delay; an unbounded message is a bill.
 *
 * Unreachable with ordinary data (see the ladder: the last rung is a 40-capped
 * first name, a site name and a fourteen-character invitation, ~150 units) and
 * kept anyway, because "cannot happen" is not a thing this file gets to assert
 * about a value that arrives from a database.
 */
export class OutreachDraftTooLongError extends Error {
  readonly channel: TouchChannel;
  readonly units: number;
  readonly limit: number;
  constructor(channel: TouchChannel, budget: OutreachBodyBudget) {
    super(
      `[outreach] fallback ${channel} body is ${budget.units} units against a ${budget.limit} ceiling ` +
        `(${budget.segments} billed segments, ${budget.encoding}); refused rather than truncated`,
    );
    this.name = "OutreachDraftTooLongError";
    this.channel = channel;
    this.units = budget.units;
    this.limit = budget.limit;
  }
}

const PURPOSE_TONE: Record<CadenceStep["purpose"], string> = {
  nudge: "This is a first, warm invitation. Keep it short and friendly.",
  offer: "This is a follow up. Make it easy to act now and offer to find a time that suits them.",
  final: "This is a final, polite invitation. Make it easy to say yes and signal we will not keep messaging.",
};

/**
 * THE LENGTH RULE, IN THE UNIT THE CHANNEL IS BILLED IN.
 *
 * This line used to read "Under 90 words" for every channel, which is both the
 * wrong unit and the wrong number for a text message. A model asked for a
 * character budget hits it; a model asked for a word count writes what it
 * likes. The prompt is still only an instruction — the ceiling is
 * measureOutreachBody — but an instruction the model can actually satisfy is
 * what keeps the ceiling (and the repair turn it costs) from firing.
 *
 * Email keeps the word count: it is not billed per segment, and shortening a
 * marketing email to the length of a text would change the message for no gain.
 */
const LENGTH_RULE: Record<TouchChannel, string> = {
  sms:
    `- Your whole message, greeting included, must be at most ${OUTREACH_MAX_UNITS.sms} characters. ` +
    "Count them before you answer. Warm and inviting, never pushy.",
  whatsapp:
    `- Your whole message, greeting included, must be at most ${OUTREACH_MAX_UNITS.whatsapp} characters. ` +
    "Warm and inviting, never pushy.",
  email: "- Under 90 words. Warm and inviting, never pushy.",
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
  return chosen || DEFAULT_ANGLE;
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
    LENGTH_RULE[channel] ?? LENGTH_RULE.sms,
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    // The alphabet rule, and it is a money rule rather than a style one. One curly
    // apostrophe forces the whole text out of GSM 03.38 into UCS-2, which takes a
    // single segment from 160 characters down to 70 and can turn one billed message
    // into three. The pound sign is safe: GSM 03.38 carries it. normaliseGsm7Typography
    // repairs our own punctuation afterwards either way; this line is what stops the
    // model reaching for it in the first place.
    "- Use straight quotes and plain hyphens, and no ellipsis character. The £ sign is fine; decorative punctuation is not.",
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
 * One whole, complete invitation. Never a fragment: every rung of the ladder
 * below is a message a patient could receive as it stands.
 */
function fallbackShape(
  purpose: CadenceStep["purpose"],
  name: string,
  practice: string,
  what: string,
  withClinician: string,
): string {
  if (purpose === "final") {
    return (
      `Hi ${name}, a last note from ${practice}. Reply if you would like ${what}${withClinician}. ` +
      `We will not message again.`
    );
  }
  if (purpose === "offer") {
    return (
      `Hi ${name}, ${practice} here. Would you like ${what}${withClinician}? ` +
      `Reply and we will find a time that suits you.`
    );
  }
  return (
    `Hi ${name}, ${practice} here. We would love to see you for ${what}${withClinician}. ` +
    `Reply and we will find you a time.`
  );
}

/**
 * Pick the first rung that fits, or refuse.
 *
 * NOTHING IS TRUNCATED. A half-sentence about a dental appointment is worse
 * than no message at all (src/lib/calendar/draft.ts and src/lib/recall/
 * sms-budget.ts both say this in the same words), and a trim would as happily
 * cut the invitation to reply — the only reason the message exists — as
 * anything else. So the ladder drops whole OPTIONAL CLAUSES in a stated order
 * and each rung is a complete message; when none fits, this refuses.
 *
 * Exported so the refusal has a behavioural test: with a 40-capped first name
 * and a real site the last rung is ~150 units and the throw is unreachable
 * through outreachFallbackBody, which is the right posture for a backstop and
 * a poor reason to leave one unpinned.
 */
export function chooseFallbackBody(rungs: readonly string[], channel: TouchChannel): string {
  let last = "";
  for (const rung of rungs) {
    last = normaliseGsm7Typography(rung);
    if (measureOutreachBody(last, channel).ok) return last;
  }
  throw new OutreachDraftTooLongError(channel, measureOutreachBody(last, channel));
}

/**
 * Deterministic, guardrail-safe SMS used when the model call fails OR its output
 * trips the guardrail OR it will not fit the channel's ceiling. British English,
 * no em-dash, no funding/clinical wording. Pure (no I/O) so it is unit-testable.
 *
 * WITHIN ONE BILLED CREDIT, AND THAT COST THE COPY SOME WORDS (6 Sep 2026). The
 * three shapes used to measure 222 / 192 / 205 GSM-7 units for the ordinary case
 * this module's own tests are written around (a first name, "N15 Vitality Dental",
 * a campaign angle, "with Dr Patel") — TWO BILLED SEGMENTS EACH, before a model was
 * involved at all, so the ceiling this module now enforces on the model could not
 * have been met by its own safety net. They were
 * shortened until they fit, keeping every element the module is held to: the
 * greeting by first name, who is texting, what the campaign is inviting them to,
 * the clinician by name, one clear next step, and the final step's promise not to
 * message again. Nothing was added and no meaning was reversed.
 *
 * THE LADDER, IN ORDER, EACH RUNG A COMPLETE MESSAGE:
 *   1. Everything: practice, invitation, clinician.
 *   2. Without the clinician clause. It is already optional (a campaign with no
 *      practitioner named ships rung 1 without it), so dropping it takes nothing
 *      the message needs — and a 60-character diary name is the likeliest single
 *      reason a body overruns.
 *   3. Without the clinician AND with the neutral invitation. Reached when the
 *      owner's own angle is long ("a free Invisalign consultation with our
 *      treatment coordinator" is 61 characters). The patient still learns who is
 *      texting and what to do; a message that does not say who it is from would
 *      be the worse trade.
 *
 * The first name is SANITISED before it is used. This body goes STRAIGHT TO A
 * PATIENT with nothing downstream to trim it, the name is Dentally free text, and
 * the 40-character cap is also what makes rung 3 bounded. A name of nothing but
 * control characters lands on "Hi there," — the same fallback renderFollowUpTemplate
 * ships for the same situation (ruling W3/37).
 */
export function outreachFallbackBody(
  target: OutreachTarget,
  campaign: OutreachCampaign,
  step: CadenceStep,
  variant: Variant = "a",
  channel: TouchChannel = "sms",
): string {
  const name = firstName(sanitiseName(target.name));
  const what = angle(campaign, variant);
  const site = getSite(target.siteId);
  const practice = site?.name ?? "the practice";
  // Sanitised too, and here it goes STRAIGHT TO A PATIENT: this is the templated
  // fallback used when the model is unavailable, so nothing downstream would trim
  // a pathological clinician name before it was sent.
  const clinician = sanitisePractitioner(campaign.practitionerName);
  const withClinician = clinician ? ` with ${clinician}` : "";

  return chooseFallbackBody(
    [
      fallbackShape(step.purpose, name, practice, what, withClinician),
      fallbackShape(step.purpose, name, practice, what, ""),
      fallbackShape(step.purpose, name, practice, DEFAULT_ANGLE, ""),
    ],
    channel,
  );
}

export interface DraftResult {
  body: string;
  /** True when the deterministic fallback was used (model failed, was blocked, or would not fit). */
  usedFallback: boolean;
}

/** One model turn, flattened to the text the patient would read. */
async function ask(
  client: Anthropic,
  system: string,
  messages: Anthropic.MessageParam[],
): Promise<string> {
  const msg = await client.messages.create({
    model: SONNET,
    thinking: NO_THINKING,
    max_tokens: 400,
    system,
    messages,
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * The repair turn: the model is shown its own over-long draft, told the real
 * numbers, and asked for the same message inside the budget. It carries the FIRST
 * draft in the conversation rather than starting again, because a rewrite of a
 * message the model can see is far likelier to keep the two things that must
 * survive (the patient's name and the invitation to reply) than a fresh attempt.
 */
function repairInstruction(units: number, limit: number): string {
  return (
    `That message is ${units} characters. The limit is ${limit}. ` +
    `Rewrite the same message in ${limit} characters or fewer, keeping the greeting by first name ` +
    "and the invitation to reply. Reply with the message only, no preamble."
  );
}

type Verdict = "ok" | "blocked" | "too-long";

/**
 * Is this model output sendable? Safety first, then cost: a body that is both
 * blocked and over-long is BLOCKED, because a repair turn on unsafe copy is a
 * second chance nothing asked for.
 *
 * The guardrail is run with includePrice: true. This is patient-facing MARKETING
 * SMS with priced USPs injected into the prompt, and an invitation never carries a
 * legitimate firm figure, so an invented "just £99" trips it and forces the
 * deterministic fallback. A genuinely hedged "from £X" USP is whitelisted by the
 * guardrail and still passes.
 */
function classify(body: string, channel: TouchChannel): Verdict {
  if (!body) return "blocked";
  const guard = checkAgentReply(body, { includePrice: true });
  if (!guard.ok) {
    console.warn(
      `[outreach] draft blocked by guardrail (${guard.category}: ${JSON.stringify(guard.matched)}); using fallback`,
    );
    return "blocked";
  }
  return measureOutreachBody(body, channel).ok ? "ok" : "too-long";
}

/**
 * Draft one outreach SMS. Calls Sonnet (thinking disabled, the platform default),
 * then guardrail-checks AND measures the result BEFORE it can be queued. If the
 * model call throws, its output trips the guardrail, or it will not fit the
 * channel's ceiling even after one repair turn, fall back to the deterministic
 * template so a step is never queued empty, never queues jargon, and never queues
 * a body nobody bounded.
 *
 * FOUR STEPS, IN THIS ORDER:
 *   1. Normalise OUR OWN typography (curly quotes, dashes, ellipsis, the invisible
 *      spaces) into characters GSM 03.38 carries. Never a letter: a patient's name
 *      is not ours to rewrite, and a name outside the alphabet costs money but
 *      never costs that patient their invitation.
 *   2. Guardrail. Unsafe copy goes to the fallback and is never repaired.
 *   3. Measure against the channel's ceiling.
 *   4. Over budget: ONE repair turn, held to the SAME guardrail, then the
 *      deterministic fallback. Nothing is truncated.
 *
 * `variant` selects which message angle to write from ('b' uses the campaign's second
 * angle when set). It only changes the angle phrase: the model call, the guardrail /
 * compliance check, the ceiling and the deterministic fallback are identical for both
 * variants, so a variant 'b' draft is held to exactly the same bar as 'a'.
 */
export async function draftOutreach(
  target: OutreachTarget,
  campaign: OutreachCampaign,
  channel: TouchChannel,
  step: CadenceStep,
  client: Anthropic = new Anthropic(),
  variant: Variant = "a",
): Promise<DraftResult> {
  const fallback = outreachFallbackBody(target, campaign, step, variant, channel);
  let usps: string[] = [];
  try {
    usps = await listActiveUspTexts(getSite(target.siteId)?.clientId ?? "");
  } catch {
    // Selling points are optional context; never block a draft on them.
  }

  try {
    const { system, user } = buildOutreachPrompt(target, campaign, channel, step, variant, usps);
    const firstTurn = await ask(client, system, [{ role: "user", content: user }]);
    const firstBody = normaliseGsm7Typography(firstTurn);
    const firstVerdict = classify(firstBody, channel);
    if (firstVerdict === "ok") return { body: firstBody, usedFallback: false };
    if (firstVerdict === "blocked") return { body: fallback, usedFallback: true };

    const over = measureOutreachBody(firstBody, channel);
    const repairedTurn = await ask(client, system, [
      { role: "user", content: user },
      { role: "assistant", content: firstTurn },
      { role: "user", content: repairInstruction(over.units, over.limit) },
    ]);
    const repaired = normaliseGsm7Typography(repairedTurn);
    const repairedVerdict = classify(repaired, channel);
    if (repairedVerdict === "ok") return { body: repaired, usedFallback: false };

    // A blocked repair has already said so in classify; only the length case needs
    // its own line, and it says the cost so a log reader knows what was avoided.
    if (repairedVerdict === "too-long") {
      const after = measureOutreachBody(repaired, channel);
      console.warn(
        `[outreach] draft still ${after.units} units against a ${after.limit} ceiling after one repair turn ` +
          `(${after.segments} billed segments, ${after.encoding}); using the deterministic fallback`,
      );
    }
    return { body: fallback, usedFallback: true };
  } catch (err) {
    console.error("[outreach] draft model call failed; using deterministic fallback", err);
    return { body: fallback, usedFallback: true };
  }
}
