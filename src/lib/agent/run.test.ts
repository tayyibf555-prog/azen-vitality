import { describe, it, expect, vi } from "vitest";
import { runAgentTurn } from "./run";

function toolUseMessage(id: string, name: string, input: object) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}
function textMessage(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

describe("runAgentTurn", () => {
  it("executes a tool call then returns the final reply", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "find_slots", { treatment: "Invisalign" }))
      .mockResolvedValueOnce(textMessage("Hi Harold, we have Monday 9am or Tuesday 11am. Which suits?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ slots: [{ start_time: "2026-06-22T09:00:00Z" }] }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "yes please" }], deps);
    expect(dispatch).toHaveBeenCalledWith("find_slots", { treatment: "Invisalign" });
    expect(r.replyText).toContain("Which suits?");
    expect(r.toolCalls.map((t) => t.name)).toEqual(["find_slots"]);
    expect(r.escalated).toBe(false);
  });

  it("flags escalation when the agent calls escalate_to_human", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "escalate_to_human", { reason: "complaint" }))
      .mockResolvedValueOnce(textMessage("Thanks, a member of our team will be in touch shortly."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ escalated: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "this is terrible" }], deps);
    expect(r.escalated).toBe(true);
    expect(r.replyText).toContain("team will be in touch");
  });

  it("BLOCKS a booking write when the patient has not explicitly confirmed", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "book", { slotStart: "2026-06-22T09:00:00Z", treatment: "Invisalign" }))
      .mockResolvedValueOnce(textMessage("Just to confirm, shall I book you in for Monday 22 June at 9am?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ booked: true, appointmentId: "appt-1" }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    // The inbound is a question, not a confirmation, so the write must be refused.
    const r = await runAgentTurn([{ role: "user", content: "what have you got on tuesday?" }], deps);
    expect(dispatch).not.toHaveBeenCalled(); // book never reached Dentally
    expect(r.replyText).toContain("confirm");
  });

  it("ALLOWS a booking write once the patient has explicitly confirmed", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "book", { slotStart: "2026-06-22T09:00:00Z", treatment: "Invisalign" }))
      .mockResolvedValueOnce(textMessage("Booked. See you Monday 22 June at 9am."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ booked: true, appointmentId: "appt-1" }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn(
      [
        // The gate requires a read-back: the affirmative must answer a concrete proposal.
        { role: "assistant", content: "I can do Monday 22 June at 9:00am with Dr Khan. Shall I book that in?" },
        { role: "user", content: "yes please, book it" },
      ],
      deps,
    );
    expect(dispatch).toHaveBeenCalledWith("book", expect.objectContaining({ slotStart: "2026-06-22T09:00:00Z" }));
    expect(r.replyText).toContain("Booked");
  });

  it("returns escalated with empty reply if it never stops calling tools", async () => {
    const create = vi.fn().mockResolvedValue(toolUseMessage("tu", "find_slots", { treatment: "x" }));
    const dispatch = vi.fn().mockResolvedValue("{}");
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "hi" }], deps);
    expect(r.replyText).toBe("");
    expect(r.escalated).toBe(true);
  });
});

describe("leaked tool-markup guard", () => {
  const LEAK = '<invoke name="patient_record">\n<parameter name="query">Connor Mallon</parameter>\n</invoke>';

  it("retries when the model writes a tool call as plain text, and returns the clean reply", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(textMessage(LEAK))
      .mockResolvedValueOnce(textMessage("Connor Mallon was last in on 12 March 2026 for a check-up."));
    const dispatch = vi.fn();
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "when was connor mallon last in" }], deps);
    expect(create).toHaveBeenCalledTimes(2);
    // The corrective nudge is appended so the second round can self-correct.
    const secondCallMessages = create.mock.calls[1][0].messages as { role: string; content: unknown }[];
    expect(JSON.stringify(secondCallMessages)).toContain("tool call as plain text");
    expect(r.replyText).toContain("12 March 2026");
    expect(r.replyText).not.toContain("<invoke");
  });

  it("returns an empty reply (caller fallback) when the leak persists to the last round", async () => {
    const create = vi.fn().mockResolvedValue(textMessage(LEAK));
    const dispatch = vi.fn();
    const deps = {
      anthropic: { messages: { create } } as never,
      dispatch,
      systemPrompt: "sys",
      tools: [],
      maxRounds: 2,
    };

    const r = await runAgentTurn([{ role: "user", content: "hi" }], deps);
    expect(create).toHaveBeenCalledTimes(2);
    expect(r.replyText).toBe("");
  });

  it("never triggers on a normal reply", async () => {
    const create = vi.fn().mockResolvedValueOnce(textMessage("We have Monday 9am or Tuesday 11am, which suits?"));
    const deps = { anthropic: { messages: { create } } as never, dispatch: vi.fn(), systemPrompt: "sys", tools: [] };
    const r = await runAgentTurn([{ role: "user", content: "any slots?" }], deps);
    expect(create).toHaveBeenCalledTimes(1);
    expect(r.replyText).toContain("which suits?");
  });
});
