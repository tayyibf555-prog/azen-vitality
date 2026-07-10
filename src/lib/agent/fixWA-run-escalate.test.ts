// FIX 5: escalate short-circuits mutating tools in the same round.
import { describe, it, expect, vi } from "vitest";
import { runAgentTurn } from "./run";

function multiToolMessage(tools: { id: string; name: string; input: object }[]) {
  return {
    stop_reason: "tool_use",
    content: tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
  };
}
function textMessage(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

describe("run: escalate + mutating tool in one round", () => {
  it("does NOT dispatch a mutating tool when escalate is present in the same round", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        multiToolMessage([
          { id: "t1", name: "book", input: { slotStart: "2026-07-01T09:00:00Z", treatment: "Checkup" } },
          { id: "t2", name: "escalate_to_human", input: { reason: "clinical question" } },
        ]),
      )
      .mockResolvedValueOnce(textMessage("A member of our team will be in touch shortly."));
    const dispatch = vi.fn().mockResolvedValue("{}");
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "s", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "book me in, also a clinical q" }], deps);

    // escalate was dispatched, book was NOT.
    const dispatched = dispatch.mock.calls.map((c) => c[0]);
    expect(dispatched).toContain("escalate_to_human");
    expect(dispatched).not.toContain("book");
    expect(r.escalated).toBe(true);
  });

  it("still dispatches a mutating tool normally when NO escalate is present", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        multiToolMessage([
          { id: "t1", name: "book", input: { slotStart: "2026-07-01T09:00:00Z", treatment: "Checkup" } },
        ]),
      )
      .mockResolvedValueOnce(textMessage("Booked."));
    const dispatch = vi.fn().mockResolvedValue("{}");
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "s", tools: [] };

    await runAgentTurn(
      [
        // The confirmation gate requires the affirmative to answer a read-back.
        { role: "assistant", content: "I can do Wednesday 1 July at 9:00am. Shall I book that in?" },
        { role: "user", content: "yes, book me in" },
      ],
      deps,
    );
    expect(dispatch.mock.calls.map((c) => c[0])).toContain("book");
  });
});
