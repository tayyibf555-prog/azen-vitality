import Anthropic from "@anthropic-ai/sdk";
import type { NoshowStep } from "./cadence";
import type { NoshowTarget } from "./types";
import type { TouchChannel } from "@/lib/reactivation/types";
import { SONNET, NO_THINKING } from "@/lib/ai/models";

const PURPOSE_TONE: Record<NoshowStep["purpose"], string> = {
  confirm: "This is the first confirmation request, a couple of days before. Ask warmly if they can still make it.",
  reminder: "This is a reminder the day before. Nudge them to confirm if they have not already.",
  final: "This is a short final reminder a few hours before. Keep it brief and friendly.",
};

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

export function buildNoshowPrompt(t: NoshowTarget, channel: TouchChannel, step: NoshowStep) {
  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    "Write a short appointment confirmation or reminder message.",
    PURPOSE_TONE[step.purpose],
    "Rules:",
    "- Lead with the patient by first name.",
    "- State the appointment day and time clearly.",
    "- Ask them to reply YES to confirm, or to reply if they need to change or cancel it.",
    "- Under 60 words. Friendly, not pushy.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    "- Plain text only, suitable for the requested channel.",
  ].join("\n");

  const user = [
    `Channel: ${channel}`,
    `Cadence step: ${step.step} (${step.purpose})`,
    `Patient: ${t.patientName}`,
    `Appointment: ${whenLabel(t.appointmentStartAt)}`,
    t.practitioner ? `With: ${t.practitioner}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

export interface DraftResult {
  body: string;
  rationale: string;
}

export async function draftNoshow(
  t: NoshowTarget,
  channel: TouchChannel,
  step: NoshowStep,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const { system, user } = buildNoshowPrompt(t, channel, step);
  const rationale = `Confirmation step ${step.step} for ${whenLabel(t.appointmentStartAt)}.`;
  const msg = await client.messages.create({
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
  return { body, rationale };
}

/**
 * Slot-offer copy is templated, not model-generated: the exact freed date/time
 * must be correct, so we never risk an LLM paraphrasing it. Reply YES claims it.
 */
export function draftSlotOffer(input: {
  patientName: string;
  startAt: string;
  practitioner: string | null;
}): string {
  const first = input.patientName.split(/\s+/)[0] || "there";
  const when = whenLabel(input.startAt);
  const withWho = input.practitioner ? ` with ${input.practitioner}` : "";
  return `Hi ${first}, good news, an earlier appointment has just opened up on ${when}${withWho}. Reply YES to take it and we will book you straight in, or NO to keep waiting for another time.`;
}
