import Anthropic from "@anthropic-ai/sdk";
import type { CadenceStep } from "./cadence";
import type { ReactivationReason, TouchChannel, ReactivationTarget } from "./types";
import { gbp } from "@/lib/utils";

const REASON_GUIDANCE: Record<ReactivationReason, string> = {
  lapsed:
    "This patient has not visited in a long time. Warmly invite them back for a checkup. Say we have missed them. Do not mention money.",
  overdue_recall:
    "This patient is overdue for their dental or hygiene recall. Remind them their recall is due and invite them to book it in.",
  stalled_plan:
    "This patient accepted treatment but did not finish it. Reference the treatment, mention the outstanding value in GBP using the £ symbol, and offer to discuss finance or a payment plan.",
};

const PURPOSE_TONE: Record<CadenceStep["purpose"], string> = {
  nudge: "This is a first, gentle nudge. Keep it short and friendly.",
  offer: "This is a follow up. Add a concrete reason to act now, such as a free checkup or a flexible payment plan.",
  final: "This is a final, polite touch. Make it easy to say yes and signal we will not keep chasing.",
};

export function buildDraftPrompt(t: ReactivationTarget, channel: TouchChannel, step: CadenceStep) {
  const system = [
    "You are a warm, professional patient coordinator for a UK dental practice.",
    "Write a short re-engagement message to a dormant patient.",
    REASON_GUIDANCE[t.reason],
    PURPOSE_TONE[step.purpose],
    "Rules:",
    "- Lead with the patient by first name.",
    "- Give one clear next step (book a checkup, a call, or an appointment).",
    "- Under 90 words. Friendly, not pushy.",
    "- Any money figure is in GBP using the £ symbol.",
    "- Use no em-dash characters anywhere. Use commas or full stops.",
    "- Never use internal funding or treatment category wording like NHS or private. These are internal labels, not patient-facing language.",
    "- Plain text only, suitable for the requested channel.",
  ].join("\n");

  const user = [
    `Channel: ${channel}`,
    `Cadence step: ${step.step} (${step.purpose})`,
    `Patient: ${t.patientName}`,
    `Reason: ${t.reason}`,
    `Treatment: ${t.treatment ?? "none on file"}`,
    `Recoverable value (GBP): ${t.recoverableValue}`,
    `Last visit: ${t.lastVisitAt ?? "unknown"}`,
    `Recall due: ${t.recallDueAt ?? "n/a"}`,
  ].join("\n");

  return { system, user };
}

const REASON_RATIONALE: Record<ReactivationReason, (t: ReactivationTarget) => string> = {
  lapsed: (t) => `Lapsed patient, last visit ${t.lastVisitAt ?? "unknown"}. Invite back for a checkup.`,
  overdue_recall: (t) => `Recall overdue since ${t.recallDueAt ?? "unknown"}. Book the recall.`,
  stalled_plan: (t) => `${gbp(t.recoverableValue)} outstanding on ${t.treatment ?? "treatment"}. Re-present finance.`,
};

export interface DraftResult { body: string; rationale: string; }

export async function draftReactivation(
  t: ReactivationTarget,
  channel: TouchChannel,
  step: CadenceStep,
  client: Anthropic = new Anthropic(),
): Promise<DraftResult> {
  const { system, user } = buildDraftPrompt(t, channel, step);
  const rationale = REASON_RATIONALE[t.reason](t);
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
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
