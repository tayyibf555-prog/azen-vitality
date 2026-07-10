import type Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  TextBlock,
  Tool,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { AgentTurnResult } from "./types";
import { SONNET, NO_THINKING } from "@/lib/ai/models";

export interface AgentRunDeps {
  anthropic: Anthropic;
  dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
  systemPrompt: string;
  tools: Tool[];
  /** Max tool-calling rounds before giving up (default 4). */
  maxRounds?: number;
  /** Max output tokens per model call (default 700). */
  maxTokens?: number;
}

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_TOKENS = 700;
const MODEL = SONNET;

// Appointment WRITES that must never happen without an explicit patient confirmation.
const APPOINTMENT_MUTATIONS = new Set(["book", "reschedule", "cancel"]);

// A patient must give a clear affirmative before the agent is allowed to WRITE an
// appointment change. This is the deterministic floor beneath the prompt's "read it
// back and get a clear yes" instruction: a booking/reschedule/cancel is never written
// on a question or an ambiguous message, even if the model tries. A false negative just
// forces one more confirming turn (safe); the model's own judgement is the sufficient
// condition on top, so this only ever makes a write harder, never easier.
const AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|ok|okay|sure|confirm(ed)?|correct|that'?s (right|correct|fine|great|perfect|good)|sounds? good|that works|works for me|go ahead|go for it|book (it|me)|do it|please do|perfect|great|lovely|brilliant|absolutely|definitely)\b/i;

function looksAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(text);
}

/** Text of the most recent patient (user) message, for the confirmation gate. */
function latestPatientText(history: MessageParam[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const text = m.content
      .filter((b): b is TextBlock => (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text;
  }
  return "";
}

// An affirmative only counts as CONFIRMATION when it answers a read-back: the
// assistant's preceding message must have proposed something concrete (a time, a
// day, or an explicit "shall I book / does that suit" question). Without this, a
// cold "ok, book me" satisfied the gate with zero read-back and the very first
// model round could write an appointment nobody had spelled out.
const PROPOSAL =
  /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(am|pm)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|shall i (book|go ahead|cancel|move)|would you like me to|book (that|this|you) in|does that (work|suit)|(can|may) i confirm|to confirm/i;

/** Text of the assistant message immediately before the final patient message. */
function assistantTextBeforeLatestPatient(history: MessageParam[]): string {
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  for (let i = lastUser - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    const text = m.content
      .filter((b): b is TextBlock => (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text;
  }
  return "";
}

export async function runAgentTurn(
  history: MessageParam[],
  deps: AgentRunDeps,
): Promise<AgentTurnResult> {
  const messages: MessageParam[] = [...history];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  let escalated = false;
  // Fixed for the whole turn: the patient's latest inbound is a clear affirmative
  // AND it answers a concrete proposal the agent just made (read-back). Appointment
  // writes (book/reschedule/cancel) are gated on BOTH below.
  const patientConfirmed =
    looksAffirmative(latestPatientText(history)) &&
    PROPOSAL.test(assistantTextBeforeLatestPatient(history));

  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  for (let round = 0; round < maxRounds; round++) {
    const msg = await deps.anthropic.messages.create({
      model: MODEL,
      thinking: NO_THINKING,
      max_tokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: deps.systemPrompt,
      tools: deps.tools,
      messages,
    });

    const toolUses = msg.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    if (msg.stop_reason !== "tool_use" || toolUses.length === 0) {
      const replyText = msg.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return { replyText, toolCalls, escalated };
    }

    // ContentBlock[] is structurally compatible with ContentBlockParam[] for the
    // blocks returned in a tool_use response, so we cast via unknown.
    messages.push({
      role: "assistant",
      content: msg.content as unknown as ContentBlockParam[],
    });

    // If the model asks to escalate in this round, a human is taking over: do
    // NOT also run any mutating tool it emitted in the same round (book,
    // reschedule, cancel, register_patient). Otherwise an escalate alongside a
    // book would still hit Dentally before the handover. Read-only tools may
    // still run so their tool_result is available, but the mutation is skipped.
    const escalatingThisRound = toolUses.some((tu) => tu.name === "escalate_to_human");
    const MUTATING = new Set(["book", "reschedule", "cancel", "register_patient"]);

    const results: ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: tu.name, input });
      if (tu.name === "escalate_to_human") escalated = true;
      if (escalatingThisRound && MUTATING.has(tu.name)) {
        // Short-circuit: skip the mutation, hand the model a refusal result so it
        // does not believe the action happened.
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ error: "Skipped: handing over to a human." }),
        });
        continue;
      }
      // Hard confirmation gate: an appointment WRITE is refused unless the patient's
      // latest inbound is an explicit affirmative. Hand the model a refusal so it asks
      // for a clear yes rather than believing the booking already happened. This is the
      // deterministic backstop to the prompt-level "read it back and confirm" rule, so
      // the AI can never book, move or cancel a real appointment off an ambiguous reply.
      if (APPOINTMENT_MUTATIONS.has(tu.name) && !patientConfirmed) {
        console.warn(`[agent] ${tu.name} blocked: no explicit patient confirmation in the latest message`);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            error: "Not confirmed. Read back the exact date, time, site and treatment and get a clear yes from the patient before this can be done.",
          }),
        });
        continue;
      }
      // A tool throwing must NOT abort the whole turn: an earlier tool in this same
      // round may have already mutated Dentally (e.g. booked), and aborting here
      // would discard the model's chance to confirm it to the patient. Hand the model
      // an error tool_result so it can recover, AND flag the turn escalated so the
      // conversation still reaches a human — a failed action must never pass silently.
      let result: string;
      try {
        result = await deps.dispatch(tu.name, input);
      } catch (err) {
        console.error(`[agent] tool ${tu.name} threw; returning an error result and escalating`, err);
        result = JSON.stringify({ error: "That action could not be completed just now. Try again, or let me pass you to a colleague." });
        escalated = true;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }

  return { replyText: "", toolCalls, escalated: true };
}
