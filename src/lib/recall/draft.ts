import Anthropic from "@anthropic-ai/sdk";
import type { CadenceStep } from "./cadence";
import type { RecallTarget, RecallType } from "./types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getSite } from "@/lib/mock/clients";
import { uspPromptLine } from "@/lib/usp/prompt";
import { listActiveUspTexts } from "@/lib/usp/repository";
import { FREE_TEXT_IS_DATA, sanitiseName } from "@/lib/agent/free-text";

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
    "- Under 90 words. Friendly, not pushy.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
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

export async function draftRecall(
  t: RecallTarget,
  channel: TouchChannel,
  step: CadenceStep,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const usps = await listActiveUspTexts(getSite(t.siteId)?.clientId ?? "");
  const { system, user } = buildRecallPrompt(t, channel, step, usps);
  const rationale = RECALL_RATIONALE[t.recallType](t);
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
