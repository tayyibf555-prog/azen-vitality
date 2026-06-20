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

export interface AgentRunDeps {
  anthropic: Anthropic;
  dispatch: (name: string, input: Record<string, unknown>) => Promise<string>;
  systemPrompt: string;
  tools: Tool[];
}

const MAX_ROUNDS = 4;
const MODEL = "claude-sonnet-4-6";

export async function runAgentTurn(
  history: MessageParam[],
  deps: AgentRunDeps,
): Promise<AgentTurnResult> {
  const messages: MessageParam[] = [...history];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  let escalated = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const msg = await deps.anthropic.messages.create({
      model: MODEL,
      max_tokens: 700,
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

    const results: ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: tu.name, input });
      if (tu.name === "escalate_to_human") escalated = true;
      const result = await deps.dispatch(tu.name, input);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }

  return { replyText: "", toolCalls, escalated: true };
}
