import Anthropic from "@anthropic-ai/sdk";
import type { CadenceStep } from "./cadence";
import type { RecallTarget, RecallType } from "./types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getSite } from "@/lib/mock/clients";
import { uspPromptLine } from "@/lib/usp/prompt";
import { listActiveUspTexts } from "@/lib/usp/repository";
import { FREE_TEXT_IS_DATA, sanitiseName } from "@/lib/agent/free-text";
import {
  RECALL_MAX_UNITS,
  RecallDraftTooLongError,
  measureRecallBody,
  normaliseGsm7Typography,
} from "./sms-budget";

const RECALL_TYPE_GUIDANCE: Record<RecallType, string> = {
  dentist:
    "This patient is due for their routine dental checkup recall, the date the dentist set. Remind them warmly that their checkup is coming up and invite them to book it in. This is proactive and routine, not a chase.",
  hygienist:
    "This patient is due for their hygiene recall, a scale and polish with the hygienist. Remind them their hygiene visit is coming up and invite them to book it in. Keep it friendly and routine.",
};

const PURPOSE_TONE: Record<CadenceStep["purpose"], string> = {
  nudge: "This is a first, gentle reminder. Keep it short and friendly.",
  offer: "This is a follow up. Make it easy to act now and offer to find a time that suits them.",
  final: "This is a final, polite reminder. Make it easy to say yes and signal we will not keep chasing.",
};

/**
 * THE LENGTH RULE, IN THE UNIT THE CHANNEL IS BILLED IN.
 *
 * This line used to read "Under 90 words" for every channel, which is both the
 * wrong unit and the wrong number for a text message: 90 words is around 500
 * GSM-7 septets, four billed segments, against a 1.69-segment break-even with the
 * per-message bill this platform replaces. A model asked for a character budget
 * hits it; a model asked for a word count writes what it likes. The prompt is
 * still only an instruction — ./sms-budget.ts is the ceiling — but an instruction
 * the model can actually satisfy is what keeps the ceiling from firing.
 *
 * Email keeps the word count. It is not billed per segment, its ceiling is a
 * runaway guard rather than a cost rule, and shortening the practice's follow-up
 * email to the length of a text would change the message for no gain.
 */
const LENGTH_RULE: Record<TouchChannel, string> = {
  sms:
    `- Your whole message, greeting included, must be at most ${RECALL_MAX_UNITS.sms} characters. ` +
    "Count them before you answer. Friendly, not pushy.",
  whatsapp:
    `- Your whole message, greeting included, must be at most ${RECALL_MAX_UNITS.whatsapp} characters. ` +
    "Friendly, not pushy.",
  email: "- Under 90 words. Friendly, not pushy.",
};

export function buildRecallPrompt(
  t: RecallTarget,
  channel: TouchChannel,
  step: CadenceStep,
  usps?: string[],
) {
  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    "Write a short recall reminder inviting a patient to book their due appointment.",
    RECALL_TYPE_GUIDANCE[t.recallType],
    PURPOSE_TONE[step.purpose],
    "Rules:",
    "- Lead with the patient by first name.",
    "- Give one clear next step (book the recall appointment).",
    LENGTH_RULE[channel] ?? LENGTH_RULE.sms,
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    // The alphabet rule, and it is a money rule. One curly apostrophe forces the
    // whole text out of GSM 03.38 into UCS-2, which takes a single segment from
    // 160 characters down to 70 and can turn one billed message into three. The
    // pound sign is safe: GSM 03.38 carries it (see ./sms-budget.ts).
    "- Use straight quotes and plain hyphens, and no ellipsis character. The £ sign is fine; decorative punctuation is not.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    uspPromptLine(usps),
    "- Plain text only, suitable for the requested channel.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const overdue =
    t.overdueDays > 0
      ? `${t.overdueDays} days overdue`
      : t.overdueDays < 0
        ? `due in ${Math.abs(t.overdueDays)} days`
        : "due today";

  const user = [
    `Channel: ${channel}`,
    `Cadence step: ${step.step} (${step.purpose})`,
    // SANITISED: the name is Dentally free text (src/lib/agent/free-text.ts).
    //
    // AND THE BOUNDARY IS SAID OUT LOUD, immediately above the values it is about,
    // exactly as the live booking agent's own prompt says it (ruling W1-B/3, charter
    // §0.8). The sanitiser strips the SHAPE of an injected instruction; this line
    // strips its AUTHORITY. Either alone is weaker than both.
    FREE_TEXT_IS_DATA,
    `Patient: ${sanitiseName(t.patientName)}`,
    `Recall type: ${t.recallType}`,
    `Recall due: ${t.dueAt} (${overdue})`,
    `Last visit: ${t.lastVisitAt ?? "unknown"}`,
  ].join("\n");

  return { system, user };
}

const RECALL_RATIONALE: Record<RecallType, (t: RecallTarget) => string> = {
  dentist: (t) =>
    `Dentist recall due ${new Date(t.dueAt).toLocaleDateString("en-GB")}. Book the checkup.`,
  hygienist: (t) =>
    `Hygiene recall due ${new Date(t.dueAt).toLocaleDateString("en-GB")}. Book the hygiene visit.`,
};

export interface DraftResult { body: string; rationale: string; }

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
 * numbers, and asked for the same message inside the budget.
 *
 * It carries the FIRST draft in the conversation rather than starting again,
 * because a rewrite of a message the model can see is far likelier to keep the
 * two things that must survive (the patient's name and the invitation to book)
 * than a fresh attempt at the same prompt with a smaller number in it.
 */
function repairInstruction(units: number, limit: number): string {
  return (
    `That message is ${units} characters. The limit is ${limit}. ` +
    `Rewrite the same message in ${limit} characters or fewer, keeping the greeting by first name ` +
    "and the invitation to book. Reply with the message only, no preamble."
  );
}

/**
 * Draft one recall reminder, bounded.
 *
 * WHAT CHANGED AND WHY (6 Sep 2026). This function used to return the model's
 * body untouched: there was no character ceiling, no encoding rule and no
 * measurement anywhere between here and Twilio, and the only limit in the whole
 * path was the prompt line above. Recall is the platform's highest-volume send
 * surface, Twilio bills per 160-character segment against Dentally's flat
 * per-message price, and the break-even is 1.69 segments — so an unbounded body
 * does not merely look untidy, it quietly inverts the saving the practice was
 * shown. See ./sms-budget.ts for the full argument and the numbers.
 *
 * THREE STEPS, IN THIS ORDER:
 *   1. Normalise OUR OWN typography (curly quotes, dashes, ellipsis, the
 *      invisible spaces) into characters GSM 03.38 carries. Never a letter: a
 *      patient's name is not ours to rewrite, and a name outside the alphabet
 *      costs money but never costs that patient their reminder.
 *   2. Measure against the channel's ceiling.
 *   3. Over budget: ONE repair turn, then refuse. Nothing is truncated — a
 *      half-sentence about a dental appointment is worse than no message, and a
 *      trim would as happily cut the invitation to book as anything else.
 *
 * The refusal is a throw, and it fails CLOSED: the sweep's tick ends having sent
 * nothing rather than queueing a message nobody bounded (ruling W1-B/1-5, a
 * skipped tick is a delay). The cadence is untouched because this runs before
 * insertTouch, so the same target is simply drafted again on the next tick.
 */
export async function draftRecall(
  t: RecallTarget,
  channel: TouchChannel,
  step: CadenceStep,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const usps = await listActiveUspTexts(getSite(t.siteId)?.clientId ?? "");
  const { system, user } = buildRecallPrompt(t, channel, step, usps);
  const rationale = RECALL_RATIONALE[t.recallType](t);

  const firstTurn = await ask(client, system, [{ role: "user", content: user }]);
  const firstBody = normaliseGsm7Typography(firstTurn);
  const firstBudget = measureRecallBody(firstBody, channel);
  if (firstBudget.ok) return { body: firstBody, rationale };

  const repairedTurn = await ask(client, system, [
    { role: "user", content: user },
    { role: "assistant", content: firstTurn },
    { role: "user", content: repairInstruction(firstBudget.units, firstBudget.limit) },
  ]);
  const body = normaliseGsm7Typography(repairedTurn);
  const budget = measureRecallBody(body, channel);
  if (!budget.ok) throw new RecallDraftTooLongError(channel, budget);
  return { body, rationale };
}
