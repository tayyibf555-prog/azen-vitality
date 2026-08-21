import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// THE COMPLIANCE-CRITICAL PATH: a reply to a post-op check-in must never reach
// the conversational booking agent, and must always reach a person.
//
// The repository and the suppression reads are faked; everything else — the
// correlation rules, the reply window, the triage call, the escalation write, the
// kill-switch semantics and the two fixed sentences — is the real code.
// ===========================================================================

const NOW = new Date("2026-08-19T10:00:00.000Z");
const SENT_AT = new Date("2026-08-19T09:00:00.000Z").toISOString();

const h = vi.hoisted(() => ({
  findTargetByAddress: vi.fn(),
  getTarget: vi.fn(),
  insertInboundTouch: vi.fn(async () => {}),
  recordEscalation: vi.fn(async () => ({})),
  setTargetStatus: vi.fn(async () => {}),
  isSuppressed: vi.fn(async () => false),
  isStopKeyword: vi.fn((b: string) => ["stop", "unsubscribe"].includes(b.trim().toLowerCase())),
}));

vi.mock("./repository", () => ({
  findTargetByAddress: h.findTargetByAddress,
  getTarget: h.getTarget,
  insertInboundTouch: h.insertInboundTouch,
  recordEscalation: h.recordEscalation,
  setTargetStatus: h.setTargetStatus,
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: h.isSuppressed,
  isStopKeyword: h.isStopKeyword,
}));

import { handlePostopInbound } from "./inbound";

const FROM = "+447700900001";

function target(over: Record<string, unknown> = {}) {
  return {
    id: "site-cc:appt-1",
    siteId: "site-cc",
    dentallyPatientId: "p1",
    appointmentId: "appt-1",
    patientName: "Sarah Lindqvist",
    procedureFlag: "extraction",
    procedureSource: "Extraction UR6",
    procedureAt: "2026-08-18T09:00:00.000Z",
    dueAt: "2026-08-19T07:00:00.000Z",
    status: "sent",
    stopReason: null,
    consentSms: true,
    consentEmail: false,
    createdAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-19T09:00:00.000Z",
    ...over,
  };
}

function correlates(sentAt: string | null = SENT_AT, t: Record<string, unknown> = {}) {
  h.findTargetByAddress.mockResolvedValue({ targetId: "site-cc:appt-1", siteId: "site-cc", sentAt });
  h.getTarget.mockResolvedValue(target(t));
}

async function reply(body: string, opts: { sendingEnabled?: boolean } = {}) {
  return handlePostopInbound({
    from: FROM,
    body,
    channel: "sms",
    sendingEnabled: opts.sendingEnabled ?? true,
    now: NOW,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears CALLS, not implementations: a mockRejectedValue set by one
  // test survives into the next one, so each fake is re-armed explicitly.
  h.insertInboundTouch.mockResolvedValue(undefined);
  h.recordEscalation.mockResolvedValue({});
  h.setTargetStatus.mockResolvedValue(undefined);
  h.isSuppressed.mockResolvedValue(false);
  h.isStopKeyword.mockImplementation((b: string) => ["stop", "unsubscribe"].includes(b.trim().toLowerCase()));
});

// ---------------------------------------------------------------------------

describe("a symptom reply is escalated and the agent never sees it", () => {
  it.each([
    "my face is swollen",
    "it's still bleeding",
    "in a lot of pain",
    "my lip is numb",
    "is this normal?",
    "😭",
    "очень больно",
    "meh",
  ])("handles and escalates: %s", async (body) => {
    correlates();
    const res = await reply(body);
    expect(res.handled, "the booking agent must never get this").toBe(true);
    expect(res.outcome).toBe("escalated");
    expect(h.recordEscalation).toHaveBeenCalledTimes(1);
  });

  it("says exactly one thing back, and it is the fixed sentence", async () => {
    correlates();
    const res = await reply("my face is swollen");
    expect(res.reply).toBe(
      "Hi Sarah, thanks for letting us know. A member of the team will call you.",
    );
  });

  it("says the SAME thing whatever the category was", async () => {
    correlates();
    const a = await reply("my face is swollen");
    correlates();
    const b = await reply("is this normal?");
    correlates();
    const c = await reply("очень больно");
    expect(new Set([a.reply, b.reply, c.reply]).size).toBe(1);
  });

  it("stores the patient's own words and the triage reason on the escalation", async () => {
    correlates();
    await reply("my face is swollen");
    expect(h.recordEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: "site-cc:appt-1",
        dentallyPatientId: "p1",
        replyBody: "my face is swollen",
        triageReason: "symptom",
        matched: "swollen",
      }),
    );
  });

  it("logs the reply BEFORE it triages, so the record does not depend on the verdict", async () => {
    correlates();
    await reply("my face is swollen");
    const logOrder = h.insertInboundTouch.mock.invocationCallOrder[0];
    const escalateOrder = h.recordEscalation.mock.invocationCallOrder[0];
    expect(logOrder).toBeLessThan(escalateOrder);
  });
});

describe("the reply never contains advice, reassurance or a symptom word", () => {
  it.each([
    "my face is swollen",
    "should I take ibuprofen",
    "is this normal?",
    "all good thanks",
  ])("for: %s", async (body) => {
    correlates();
    const res = await reply(body);
    const text = res.reply ?? "";
    for (const forbidden of [
      /\bnormal\b/i,
      /\bswell/i,
      /\bpain/i,
      /\btake\b/i,
      /\brinse\b/i,
      /\bibuprofen\b/i,
      /\bparacetamol\b/i,
      /\bdon'?t worry\b/i,
      /\bsettle\b/i,
      /\bexpected\b/i,
    ]) {
      expect(text, `${body} -> ${text}`).not.toMatch(forbidden);
    }
  });
});

describe("an all-clear closes the loop", () => {
  it("marks the target closed and says the all-clear sentence", async () => {
    correlates();
    const res = await reply("all good thanks");
    expect(res.handled).toBe(true);
    expect(res.outcome).toBe("all_clear");
    expect(h.recordEscalation).not.toHaveBeenCalled();
    expect(h.setTargetStatus).toHaveBeenCalledWith("site-cc:appt-1", "closed");
    expect(res.reply).toBe(
      "Hi Sarah, thanks for letting us know. If anything changes, reply here and one of the " +
        "team will get back to you.",
    );
  });
});

describe("what the module hands BACK to the ordinary agent", () => {
  it("a STOP: an opt-out is not a post-op reply", async () => {
    correlates();
    const res = await reply("STOP");
    expect(res.handled).toBe(false);
    expect(h.findTargetByAddress).not.toHaveBeenCalled();
    expect(h.recordEscalation).not.toHaveBeenCalled();
  });

  it("a number with no post-op check-in at all", async () => {
    h.findTargetByAddress.mockResolvedValue(null);
    expect((await reply("my face is swollen")).handled).toBe(false);
  });

  it("a check-in that was queued but never actually delivered", async () => {
    // findTargetByAddress filters on sent_at, and a null here means the module has
    // no evidence the patient ever received anything to reply to.
    correlates(null);
    expect((await reply("my face is swollen")).handled).toBe(false);
  });

  it("a check-in older than the reply window", async () => {
    // THE GUARD THAT STOPS THIS MODULE EATING THE PRACTICE'S INBOX. Without it,
    // every message this patient ever sends again address-matches the old row and
    // is swallowed into a conversation that ended months ago.
    correlates(new Date("2026-08-01T09:00:00.000Z").toISOString());
    expect((await reply("can I book a check-up")).handled).toBe(false);
    expect(h.recordEscalation).not.toHaveBeenCalled();
  });

  it("a target that was stopped without a live conversation", async () => {
    correlates(SENT_AT, { status: "stopped" });
    expect((await reply("my face is swollen")).handled).toBe(false);
  });

  it("a correlation READ FAILURE falls through rather than silencing the agent", async () => {
    // Deliberate direction. Before the correlation lands there is no evidence this
    // is a post-op reply, and claiming every inbound during a database blip would
    // take the practice's 24/7 agent off the air for everybody.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.findTargetByAddress.mockRejectedValue(new Error("supabase down"));
    expect((await reply("my face is swollen")).handled).toBe(false);
    spy.mockRestore();
  });
});

describe("a failure AFTER correlation fails CLOSED", () => {
  it("a broken escalation write still keeps the agent out, and says nothing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    correlates();
    h.recordEscalation.mockRejectedValue(new Error("insert failed"));
    const res = await reply("my face is swollen");
    // By now we KNOW what this message is. Silence is the correct failure.
    expect(res.handled).toBe(true);
    expect(res.reply).toBeNull();
    spy.mockRestore();
  });

  it("a broken inbound log also fails closed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    correlates();
    h.insertInboundTouch.mockRejectedValue(new Error("insert failed"));
    const res = await reply("all good thanks");
    expect(res.handled).toBe(true);
    expect(res.reply).toBeNull();
    spy.mockRestore();
  });
});

describe("the kill switch stops the SENDING, never the noticing", () => {
  it("with the system OFF the escalation is still recorded", async () => {
    correlates();
    const res = await reply("my face is swollen", { sendingEnabled: false });
    expect(h.recordEscalation).toHaveBeenCalledTimes(1);
    expect(res.outcome).toBe("escalated");
  });

  it("with the system OFF nothing is said back", async () => {
    correlates();
    expect((await reply("my face is swollen", { sendingEnabled: false })).reply).toBeNull();
  });

  it("with the system OFF the agent STILL does not get the message", async () => {
    // The important half. Silence is a valid outcome; a booking agent answering a
    // post-surgical symptom is not.
    correlates();
    expect((await reply("my face is swollen", { sendingEnabled: false })).handled).toBe(true);
  });
});

describe("opt-out silences the acknowledgement, never the escalation", () => {
  it("a suppressed patient gets no reply but is still escalated", async () => {
    correlates();
    h.isSuppressed.mockResolvedValue(true);
    const res = await reply("my face is swollen");
    expect(h.recordEscalation).toHaveBeenCalledTimes(1);
    expect(res.reply).toBeNull();
    expect(res.handled).toBe(true);
  });

  it("a suppression read that THROWS is treated as suppressed, not as consent", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    correlates();
    h.isSuppressed.mockRejectedValue(new Error("down"));
    const res = await reply("my face is swollen");
    expect(res.reply).toBeNull();
    expect(h.recordEscalation).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("a patient who is already escalated can escalate again", () => {
  it("a second, worse message is a second escalation", async () => {
    correlates(SENT_AT, { status: "escalated" });
    const res = await reply("now my face is swollen too");
    expect(res.handled).toBe(true);
    expect(res.outcome).toBe("escalated");
    expect(h.recordEscalation).toHaveBeenCalledTimes(1);
  });

  it("and so can one who already said they were fine", async () => {
    correlates(SENT_AT, { status: "closed" });
    const res = await reply("actually it's bleeding now");
    expect(res.outcome).toBe("escalated");
  });
});

// ---------------------------------------------------------------------------
// The wiring, read out of the webhook itself.
// ---------------------------------------------------------------------------

describe("the webhook runs this BEFORE the booking agent", () => {
  const WEBHOOK = readFileSync(
    join(process.cwd(), "src/app/api/webhooks/twilio/inbound/route.ts"),
    "utf8",
  );

  it("calls handlePostopInbound", () => {
    expect(WEBHOOK).toContain("handlePostopInbound({");
  });

  it("returns before the agent turn whenever the module handled the message", () => {
    const call = WEBHOOK.indexOf("handlePostopInbound({");
    const agent = WEBHOOK.indexOf("runAgentTurn(");
    expect(call).toBeGreaterThan(0);
    expect(agent).toBeGreaterThan(0);
    expect(call, "the post-op branch must come before the agent turn").toBeLessThan(agent);
    const branch = WEBHOOK.slice(call, agent);
    expect(branch).toContain("if (postop.handled)");
    expect(branch).toContain("return twiml();");
  });

  it("passes the kill switch through, and only for the acknowledgement", () => {
    expect(WEBHOOK).toContain('sendingEnabled: await isSystemEnabledForSend("vitality", "postop-checkin")');
  });

  it("sends the reply through the shared sendMessage, adding no send machinery", () => {
    const call = WEBHOOK.indexOf("handlePostopInbound({");
    const branch = WEBHOOK.slice(call, call + 1500);
    expect(branch).toContain("await sendMessage({ channel, to: from, body: postop.reply })");
  });
});
