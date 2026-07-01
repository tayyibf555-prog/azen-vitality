// RESILIENCE: the agent run loop must not corrupt state or hang when the
// Anthropic API throws or returns malformed tool args. The inbound webhook
// wraps runAgentTurn in try/catch and hands over to a human on any throw, so
// the contract this suite pins is:
//  - messages.create throwing rejects cleanly (so the caller's catch fires) and
//    does not loop forever
//  - a tool_use block with null / non-object input does not crash; dispatch is
//    still called with a plain object
//  - a dispatch that throws propagates cleanly (caller hands over) rather than
//    leaving an unhandled rejection
//  - a runaway model that only ever asks for tools terminates at maxRounds and
//    returns escalated=true instead of looping forever
import { describe, it, expect, vi } from "vitest";
import { runAgentTurn } from "./run";
import type { AgentRunDeps } from "./run";

function toolMessage(tools: { id: string; name: string; input: unknown }[]) {
  return {
    stop_reason: "tool_use",
    content: tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
  };
}
function textMessage(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

function deps(create: (...a: unknown[]) => unknown, dispatch: (...a: unknown[]) => Promise<string>): AgentRunDeps {
  return { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "s", tools: [] };
}

describe("run: Anthropic API throwing", () => {
  it("rejects cleanly so the caller can hand over (no swallowed hang)", async () => {
    const create = vi.fn(async (..._a: unknown[]) => {
      throw new Error("anthropic 529 overloaded");
    });
    const dispatch = vi.fn(async (..._a: unknown[]): Promise<string> => "{}");
    await expect(
      runAgentTurn([{ role: "user", content: "hi" }], deps(create, dispatch)),
    ).rejects.toThrow("anthropic 529 overloaded");
    // No tool was dispatched on a first-call failure.
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("run: malformed tool args", () => {
  it("null input does not crash - dispatch receives a plain object", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolMessage([{ id: "t1", name: "book", input: null }]))
      .mockResolvedValueOnce(textMessage("done"));
    const dispatch = vi.fn(async (..._a: unknown[]): Promise<string> => "{}");
    const r = await runAgentTurn([{ role: "user", content: "book" }], deps(create, dispatch));
    expect(r.replyText).toBe("done");
    // Dispatched with an object (the ?? {} fallback), never undefined/null.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const arg = dispatch.mock.calls[0][1];
    expect(typeof arg).toBe("object");
    expect(arg).not.toBeNull();
  });

  it("a tool_use block missing input entirely still dispatches without throwing", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "book" }], // no input field
      })
      .mockResolvedValueOnce(textMessage("ok"));
    const dispatch = vi.fn(async (..._a: unknown[]): Promise<string> => "{}");
    const r = await runAgentTurn([{ role: "user", content: "book" }], deps(create, dispatch));
    expect(r.replyText).toBe("ok");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("run: dispatch throwing", () => {
  it("propagates cleanly (caller hands over) rather than an unhandled rejection", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolMessage([{ id: "t1", name: "book", input: { slotStart: "x" } }]));
    const dispatch = vi.fn(async (..._a: unknown[]): Promise<string> => {
      throw new Error("dentally write failed");
    });
    await expect(
      runAgentTurn([{ role: "user", content: "book" }], deps(create, dispatch)),
    ).rejects.toThrow("dentally write failed");
  });
});

describe("run: runaway tool loop", () => {
  it("terminates at maxRounds and returns escalated=true, never loops forever", async () => {
    // The model ALWAYS asks for a tool and never finishes.
    const create = vi.fn(async (..._a: unknown[]) =>
      toolMessage([{ id: "t1", name: "lookup", input: {} }]),
    );
    const dispatch = vi.fn(async (..._a: unknown[]): Promise<string> => "{}");
    const r = await runAgentTurn([{ role: "user", content: "loop" }], {
      ...deps(create, dispatch),
      maxRounds: 3,
    });
    // Bounded: exactly maxRounds model calls, then a safe escalation.
    expect(create).toHaveBeenCalledTimes(3);
    expect(r.escalated).toBe(true);
    expect(r.replyText).toBe("");
  });
});

describe("run: model returns no content at all", () => {
  it("returns an empty reply without throwing (caller falls back to a safe message)", async () => {
    const create = vi.fn(async (..._a: unknown[]) => ({ stop_reason: "end_turn", content: [] }));
    const dispatch = vi.fn(async (..._a: unknown[]): Promise<string> => "{}");
    const r = await runAgentTurn([{ role: "user", content: "hi" }], deps(create, dispatch));
    expect(r.replyText).toBe("");
    expect(r.escalated).toBe(false);
  });
});
