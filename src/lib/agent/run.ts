import type Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  TextBlock,
  TextBlockParam,
  Tool,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { AgentTurnResult } from "./types";
import { SONNET, NO_THINKING } from "@/lib/ai/models";

/**
 * What the turn actually DID, on top of what the model said.
 *
 * `toolCalls` records what the model ATTEMPTED, which is not the same thing: a
 * call can be blocked by the confirmation gate, refused by the tool, or fail at
 * Dentally. Anything downstream that must only fire on a real write (marking a
 * conversation booked, marking a lead booked) keys off these outcome fields,
 * which are read from the tool RESULTS, never off an attempt.
 */
export interface AgentTurnOutcome extends AgentTurnResult {
  /** True only when a `book` result confirmed a real appointment. */
  booked: boolean;
  /** Dentally id of a patient `register_patient` created this turn, if any. */
  registeredPatientId: string | null;
  /** The name they were registered under, for the directory and the thread. */
  registeredPatientName: string | null;
}

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

// Signatures of tool-call markup written into the TEXT channel (a rare model slip:
// the call belongs in a tool_use block, never in prose a user will read). Matched
// against the model's reply only, where XML of any kind is never legitimate copy.
const LEAKED_TOOL_MARKUP = /<(?:antml:)?invoke\b|<function_calls|<tool_use\b|<parameter\b/i;
const DEFAULT_MAX_TOKENS = 700;
const MODEL = SONNET;

// ---------------------------------------------------------------------------
// PROMPT CACHING
// ---------------------------------------------------------------------------
//
// WHAT IS BEING PAID FOR TWICE. This loop is the only agent loop in the product:
// the 24/7 SMS booking agent runs it up to 4 rounds per inbound message, and the
// owner co-pilot runs it up to 6 rounds per question. Every one of those rounds
// re-sends the ENTIRE tool schema and the ENTIRE system prompt, because the
// Messages API is stateless. Measured on this tree:
//
//   booking agent   AGENT_TOOLS   ~1,470 tok  +  system ~1,240-1,740 tok
//   co-pilot        COPILOT_TOOLS ~5,860 tok  +  system ~4,110 tok
//
// So a single co-pilot question that takes 4 rounds pays for ~40,000 input
// tokens of prompt that never changed between the rounds. That is the whole cost
// of the feature, and none of it is the owner's question.
//
// WHAT THIS DOES. One ephemeral cache breakpoint on the system block. The wire
// order is tools -> system -> messages, so a breakpoint on the last system block
// covers BOTH the tools and the system prompt in one cached prefix. Round 1 pays
// a 1.25x write; every later round in the turn, and every later turn inside the
// 5-minute TTL, pays 0.1x for that prefix instead of 1x.
//
// WHY IT IS SAFE. cache_control is a billing/latency directive. It is not visible
// to the model, it does not change the rendered prompt, and it cannot change what
// the model says. A prefix under the model's cacheable minimum (1,024 tokens on
// Sonnet 5) is silently not cached rather than rejected, which is why the unit
// tests here — whose systemPrompt is "sys" and whose tools are [] — keep passing
// unchanged.
//
// WHAT WOULD BREAK IT. Caching is a byte-exact PREFIX match, so anything that
// varies per request and sits ahead of the breakpoint destroys the hit rate. Both
// callers are clean today and must stay that way:
//   - buildSystemPrompt (agent) interpolates only per-PATIENT facts (name, treatment,
//     last visit, recall date, the practice's USPs). Stable for a whole conversation.
//   - buildCopilotSystemPrompt interpolates the current DAY and the site-scope label.
//     Stable for a day, and identical across every owner on the same scope.
// Never interpolate a timestamp, a request id, or a per-turn counter into either
// one: it would not fail, it would just quietly stop caching. Pinned by
// prompt-caching.test.ts.
const CACHE_EPHEMERAL = { type: "ephemeral" } as const;

/** The system prompt as a single cached block (covers `tools` too — see above). */
function cachedSystem(prompt: string): TextBlockParam[] {
  return [{ type: "text", text: prompt, cache_control: CACHE_EPHEMERAL }];
}

// Appointment WRITES that must never happen without an explicit patient confirmation.
const APPOINTMENT_MUTATIONS = new Set(["book", "reschedule", "cancel"]);

// Co-pilot COMMIT steps that go live the moment they fire with confirm:true: a send_sms
// / send_email (a message to a real patient), a launch_outreach_campaign (starts texting
// a segment), a launch_landing_page (publishes a public page), a publish_meta_campaign
// (the confirmed take-it-live step), a create_patient (writes a real person into the
// practice's Dentally book), or a nudge_lead (re-fires first contact to a real enquirer).
// These run through this same loop (the owner co-pilot dispatches via runAgentTurn), so
// they get the SAME deterministic latest-turn floor as an appointment write: the prompt +
// each tool's own two-step already ask for a read-back, and this makes a same-turn confirm
// inert regardless of what the model tries. The per-tool guards (consent, suppression,
// toggle, IDOR, angle, Meta-connection, dedupe, the atomic lead claim) stay as
// belt-and-braces.
const CONFIRM_COMMIT_TOOLS = new Set([
  "send_sms",
  "send_email",
  "launch_outreach_campaign",
  "launch_landing_page",
  "publish_meta_campaign",
  "create_patient",
  "nudge_lead",
]);

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

// The send/launch/publish equivalent of PROPOSAL: a co-pilot read-back that OFFERS to
// send a message, launch a campaign, publish a landing page or Meta campaign, or override
// today's one-per-day cap. Kept as its OWN pattern (not folded into PROPOSAL) so the co-
// pilot commit gate can recognise a send/publish read-back WITHOUT ever widening the
// stricter appointment-write proposal test above. Deliberately OFFER-shaped ("shall I
// send", "send it?", "launch it", "publish it", "override") rather than any mention of a
// send/publish word, so a prior turn that merely REFERS to a past action ("I published
// that yesterday") cannot be mistaken for an offer a later "yes" confirms.
const SEND_PROPOSAL =
  /shall i (send|text|email|message|launch|publish|go ahead)|want me to (send|text|email|message|launch|publish)|would you like me to (send|text|email|message|launch|publish)|ready to (send|launch|publish)|send (it|this|that|them)\??|launch (it|this|that|the campaign)|publish (it|this|that|the page|the campaign)|go live|happy for me to|override|to confirm|can i confirm/i;

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

/** A tool result as an object, or an empty object when it is not JSON. */
function parseToolResult(result: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runAgentTurn(
  history: MessageParam[],
  deps: AgentRunDeps,
): Promise<AgentTurnOutcome> {
  const messages: MessageParam[] = [...history];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  let escalated = false;
  // Real outcomes, read from tool RESULTS (see AgentTurnOutcome).
  let booked = false;
  let registeredPatientId: string | null = null;
  let registeredPatientName: string | null = null;
  // Fixed for the whole turn. Compute the shared pieces once: the latest inbound text,
  // the assistant read-back before it, and whether that inbound is a clear affirmative.
  const latestInbound = latestPatientText(history);
  const priorReadback = assistantTextBeforeLatestPatient(history);
  const latestIsAffirmative = looksAffirmative(latestInbound);
  // Appointment writes (book/reschedule/cancel) require an affirmative answering an
  // APPOINTMENT proposal (a time/day/"shall I book"). Unchanged, and never widened.
  const patientConfirmed = latestIsAffirmative && PROPOSAL.test(priorReadback);
  // Co-pilot commit sends/launch (with confirm:true) require an affirmative answering a
  // SEND/LAUNCH read-back (or an appointment one). Separate pattern so this can never
  // loosen the appointment gate above; a same-turn confirm has no prior read-back to
  // answer, so priorReadback is empty and this is false — exactly the case we refuse.
  const commitConfirmed =
    latestIsAffirmative && (SEND_PROPOSAL.test(priorReadback) || PROPOSAL.test(priorReadback));

  // Every exit from the loop reports the same outcome fields, read at the moment
  // of return so a write in the last round is never dropped from the result.
  const outcome = (replyText: string, wasEscalated = escalated): AgentTurnOutcome => ({
    replyText,
    toolCalls,
    escalated: wasEscalated,
    booked,
    registeredPatientId,
    registeredPatientName,
  });

  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  for (let round = 0; round < maxRounds; round++) {
    const msg = await deps.anthropic.messages.create({
      model: MODEL,
      thinking: NO_THINKING,
      max_tokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Cached prefix: tools + system. See the PROMPT CACHING note above.
      system: cachedSystem(deps.systemPrompt),
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
      // Leaked tool-markup guard: rarely the model WRITES its tool call as plain
      // text instead of emitting a real tool_use block, and that raw XML would
      // otherwise be shown to the user verbatim. With rounds left, hand the slip
      // back so the model re-issues the call through the tools interface; on the
      // last round return empty so the caller's safe fallback copy is used.
      if (LEAKED_TOOL_MARKUP.test(replyText)) {
        console.warn("[agent] model wrote tool markup as plain text; retrying the round");
        if (round < maxRounds - 1) {
          messages.push({ role: "assistant", content: replyText });
          messages.push({
            role: "user",
            content:
              "SYSTEM NOTE: your previous message wrote a tool call as plain text, which the user must never see. Make the call through the tools interface for real, or answer in plain English with no tool markup.",
          });
          continue;
        }
        return outcome("");
      }
      return outcome(replyText);
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
      // Same deterministic floor for the co-pilot's commit steps: a confirm:true send or
      // launch is refused unless the owner's LATEST turn is an affirmative answering a
      // prior read-back. A confirm set in the SAME turn as the original ask (no prior
      // read-back to answer) is turned back into a read-back-and-ask, never the action.
      // Only the COMMIT (confirm:true) is gated: a bare preview/read-back (no confirm) is
      // always allowed, since that is how the read-back the owner then answers is produced.
      if (CONFIRM_COMMIT_TOOLS.has(tu.name) && input.confirm === true && !commitConfirmed) {
        console.warn(`[agent] ${tu.name} confirm blocked: latest owner turn is not an affirmative answering a read-back`);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            error:
              "Not confirmed in this turn. Do not set confirm true in the same message as the request. Call this tool again WITHOUT confirm to read it back to the owner, then set confirm true only after they clearly say yes in a later reply.",
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
      // Record what really happened, from the RESULT. A booking that was blocked,
      // refused because the slot had gone, or thrown by Dentally reports nothing
      // here, so no caller can mistake the attempt for an appointment.
      const parsed = parseToolResult(result);
      if (tu.name === "book" && parsed.booked === true) booked = true;
      if (tu.name === "register_patient" && parsed.registered === true && typeof parsed.patientId === "string") {
        registeredPatientId = parsed.patientId;
        const firstName = typeof input.firstName === "string" ? input.firstName.trim() : "";
        const lastName = typeof input.lastName === "string" ? input.lastName.trim() : "";
        registeredPatientName = [firstName, lastName].filter(Boolean).join(" ") || null;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }

  return outcome("", true);
}
