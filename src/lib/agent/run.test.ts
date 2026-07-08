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

    const r = await runAgentTurn([{ role: "user", content: "yes please, book it" }], deps);
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
