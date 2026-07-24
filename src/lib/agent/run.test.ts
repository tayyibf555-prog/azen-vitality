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

// Finding #3: the co-pilot's commit steps (send_sms / send_email / launch_outreach_
// campaign with confirm:true) run through this same loop and get the SAME deterministic
// latest-turn floor as an appointment write — a confirm in the SAME turn as the original
// request is refused; a confirm answering a prior read-back proceeds.
describe("co-pilot commit gate (finding #3)", () => {
  it("REFUSES a send_sms confirm:true set in the same turn as the request (no prior read-back)", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "send_sms", { patient: "Cora", message: "Hi", confirm: true }))
      .mockResolvedValueOnce(textMessage("Here's the text for Cora. Shall I send it?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ sent: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    // Owner's first message asks AND says "yes, send it" in one breath: still no prior
    // read-back to answer, so the send must be turned back into a read-back-and-ask.
    const r = await runAgentTurn([{ role: "user", content: "Text Cora her results are in, yes send it now" }], deps);
    expect(dispatch).not.toHaveBeenCalled(); // the send never dispatched
    expect(r.replyText).toContain("send it");
  });

  it("ALLOWS a send_sms confirm:true that answers a prior send read-back", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "send_sms", { patient: "Cora", message: "Hi", confirm: true }))
      .mockResolvedValueOnce(textMessage("Sent."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ sent: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn(
      [
        { role: "user", content: "text Cora a reminder" },
        { role: "assistant", content: "Here's the reminder for Cora: 'Your check-up is due'. Want me to send it?" },
        { role: "user", content: "yes please" },
      ],
      deps,
    );
    expect(dispatch).toHaveBeenCalledWith("send_sms", expect.objectContaining({ confirm: true }));
    expect(r.replyText).toContain("Sent");
  });

  it("does NOT treat a prior turn that merely mentions a PAST send as an offer to confirm a fresh one", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "send_sms", { patient: "Sarah", message: "Results ready", confirm: true }))
      .mockResolvedValueOnce(textMessage("Here's Sarah's message. Shall I send it?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ sent: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    // Latest turn is affirmative-ish ("great"), but the prior assistant turn only REFERS
    // to a past send — it does not OFFER Sarah's send — so confirm:true must be refused.
    const r = await runAgentTurn(
      [
        { role: "user", content: "did you text John yesterday?" },
        { role: "assistant", content: "Yes, I sent John's reminder yesterday." },
        { role: "user", content: "great, now send Sarah her results" },
      ],
      deps,
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.replyText).toContain("send it");
  });

  it("still ALLOWS a bare preview (no confirm) in the first turn — that is how the read-back is produced", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "send_sms", { patient: "Cora", message: "Hi" }))
      .mockResolvedValueOnce(textMessage("Here's what I'd send Cora. Shall I go ahead?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ sent: false, preview: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    await runAgentTurn([{ role: "user", content: "text Cora a reminder" }], deps);
    expect(dispatch).toHaveBeenCalledWith("send_sms", expect.objectContaining({ patient: "Cora" }));
  });

  it("REFUSES a launch_outreach_campaign confirm:true set in the same turn as the request", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "launch_outreach_campaign", { campaignId: "camp-1", confirm: true }))
      .mockResolvedValueOnce(textMessage("Shall I launch the hygiene campaign?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ launched: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "launch the hygiene campaign, confirm" }], deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.replyText).toContain("launch");
  });

  it("ALLOWS a launch_outreach_campaign confirm:true that answers a prior read-back", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "launch_outreach_campaign", { campaignId: "camp-1", confirm: true }))
      .mockResolvedValueOnce(textMessage("The hygiene campaign is now live."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ launched: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn(
      [
        { role: "user", content: "launch the hygiene campaign" },
        { role: "assistant", content: "That will text up to 25 a day of the 214 matched patients. Shall I launch it?" },
        { role: "user", content: "yes go ahead" },
      ],
      deps,
    );
    expect(dispatch).toHaveBeenCalledWith("launch_outreach_campaign", expect.objectContaining({ confirm: true }));
    expect(r.replyText).toContain("live");
  });

  // The marketing commit tools (launch_landing_page / publish_meta_campaign) are in the
  // SAME CONFIRM_COMMIT_TOOLS set, so a confirm:true set in the same turn as the request
  // is refused, and a confirm answering a prior publish read-back proceeds.
  it("REFUSES a launch_landing_page confirm:true set in the same turn as the request", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "launch_landing_page", { pageId: "page-1", confirm: true }))
      .mockResolvedValueOnce(textMessage("Shall I publish the Invisalign page live?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ published: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "publish the invisalign landing page, yes do it" }], deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.replyText).toContain("publish");
  });

  it("ALLOWS a launch_landing_page confirm:true that answers a prior publish read-back", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "launch_landing_page", { pageId: "page-1", confirm: true }))
      .mockResolvedValueOnce(textMessage("The Invisalign page is now live."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ published: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn(
      [
        { role: "user", content: "publish the invisalign landing page" },
        { role: "assistant", content: "This will publish the Invisalign page live at /go/vitality/invisalign-abcd. Shall I publish it?" },
        { role: "user", content: "yes please" },
      ],
      deps,
    );
    expect(dispatch).toHaveBeenCalledWith("launch_landing_page", expect.objectContaining({ confirm: true }));
    expect(r.replyText).toContain("live");
  });

  it("REFUSES a publish_meta_campaign confirm:true set in the same turn as the request", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "publish_meta_campaign", { campaignId: "meta-1", confirm: true }))
      .mockResolvedValueOnce(textMessage("Shall I publish the implant campaign to Meta?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ published: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "publish the implant meta campaign now, go" }], deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.replyText).toContain("publish");
  });

  it("ALLOWS a publish_meta_campaign confirm:true that answers a prior publish read-back", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "publish_meta_campaign", { campaignId: "meta-1", confirm: true }))
      .mockResolvedValueOnce(textMessage("Your Meta account is not connected, so nothing has gone live."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ published: false, reason: "meta_not_connected" }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn(
      [
        { role: "user", content: "publish the implant meta campaign" },
        { role: "assistant", content: "This would take the implant campaign live on Meta. Shall I publish it?" },
        { role: "user", content: "yes go ahead" },
      ],
      deps,
    );
    // The gate lets confirm:true through (it answered a read-back); the per-tool
    // Meta-connection guard is what then keeps it from going live.
    expect(dispatch).toHaveBeenCalledWith("publish_meta_campaign", expect.objectContaining({ confirm: true }));
  });

  // create_patient is in the SAME CONFIRM_COMMIT_TOOLS set (a real write to the practice's
  // Dentally book), so a confirm:true set in the same turn as the request is refused, and a
  // confirm answering a prior read-back proceeds.
  it("REFUSES a create_patient confirm:true set in the same turn as the request", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(
        toolUseMessage("tu1", "create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01", phone: "07700900123", confirm: true }),
      )
      .mockResolvedValueOnce(textMessage("Ready to add Jane Doe, born 1 May 1990. Shall I go ahead and add them?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ created: true, patientId: "new-1" }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn([{ role: "user", content: "add a new patient Jane Doe born 1990-05-01, mobile 07700900123, yes create her" }], deps);
    expect(dispatch).not.toHaveBeenCalled(); // no patient reached Dentally
    expect(r.replyText).toMatch(/add/i);
  });

  it("ALLOWS a create_patient confirm:true that answers a prior read-back", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(
        toolUseMessage("tu1", "create_patient", { firstName: "Jane", lastName: "Doe", dateOfBirth: "1990-05-01", phone: "07700900123", confirm: true }),
      )
      .mockResolvedValueOnce(textMessage("Done, I have added Jane Doe."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ created: true, patientId: "new-1" }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [] };

    const r = await runAgentTurn(
      [
        { role: "user", content: "add a new patient Jane Doe born 1990-05-01, mobile 07700900123" },
        { role: "assistant", content: "Ready to add Jane Doe, born 1 May 1990, mobile +447700900123, at N15 Vitality Dental. Shall I go ahead and add them?" },
        { role: "user", content: "yes please" },
      ],
      deps,
    );
    expect(dispatch).toHaveBeenCalledWith("create_patient", expect.objectContaining({ confirm: true }));
    expect(r.replyText).toMatch(/added/i);
  });
});
