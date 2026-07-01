// FIX 1: deterministic OUTPUT guardrail filter.
import { describe, it, expect } from "vitest";
import { checkAgentReply, SAFE_HANDOVER } from "./guardrail";

describe("output guardrail: funding / NHS / private jargon", () => {
  it("blocks an NHS mention", () => {
    const r = checkAgentReply("On the NHS this is free.");
    expect(r.ok).toBe(false);
    expect(r.category).toBe("funding");
  });
  it("blocks 'private treatment' funding wording", () => {
    expect(checkAgentReply("As a private patient you pay more.").ok).toBe(false);
    expect(checkAgentReply("You can go private for that.").ok).toBe(false);
    expect(checkAgentReply("We can do this privately.").ok).toBe(false);
  });
  it("allows a neutral message that happens to contain 'private' non-funding", () => {
    // "private message" is not funding wording; must not false-positive.
    expect(checkAgentReply("I will send you a private message with the details.").ok).toBe(true);
  });
});

describe("output guardrail: clinical advice", () => {
  it("blocks a diagnosis / 'you need' clinical opinion", () => {
    expect(checkAgentReply("Clinically you definitely need a filling.").ok).toBe(false);
    expect(checkAgentReply("You need a root canal for that.").ok).toBe(false);
  });
  it("blocks a suitability / safety opinion", () => {
    expect(checkAgentReply("That treatment is completely safe for you.").ok).toBe(false);
    expect(checkAgentReply("Invisalign is suitable for you.").ok).toBe(false);
  });
  it("blocks a medication suggestion", () => {
    expect(checkAgentReply("Just take some ibuprofen until then.").ok).toBe(false);
  });
  it("allows neutral booking logistics", () => {
    expect(checkAgentReply("I can offer you Tuesday at 10am, does that work?").ok).toBe(true);
    expect(checkAgentReply("We are open until 5pm and parking is out front.").ok).toBe(true);
  });
});

describe("output guardrail: unverified / invented price", () => {
  it("blocks a firm exact price", () => {
    expect(checkAgentReply("The price is £2400 for the whole treatment.").ok).toBe(false);
    expect(checkAgentReply("It will be £150 exactly.").ok).toBe(false);
  });
  it("allows a hedged 'from' price (the safe path)", () => {
    expect(
      checkAgentReply("Invisalign starts from £1800, and a coordinator confirms the exact price.").ok,
    ).toBe(true);
    expect(checkAgentReply("Whitening is from £250. Shall I book you a consultation?").ok).toBe(true);
  });
});

describe("output guardrail: pass-through", () => {
  it("empty / whitespace reply is ok (webhook has its own fallback)", () => {
    expect(checkAgentReply("").ok).toBe(true);
    expect(checkAgentReply("   ").ok).toBe(true);
  });
  it("SAFE_HANDOVER text is British English and has no em-dash", () => {
    expect(SAFE_HANDOVER).not.toContain("—");
    expect(SAFE_HANDOVER).not.toContain("–");
    expect(SAFE_HANDOVER.toLowerCase()).toContain("member of the team");
  });
  // Regression: the clinical "you need ..." rule must NOT block routine
  // logistics, or genuine conversations get suppressed and flood the human
  // queue. The rule is scoped to clinical objects (filling, root canal, etc).
  it("does not over-block routine logistics that contain 'you need'", () => {
    expect(checkAgentReply("You need to bring your ID to the appointment.").ok).toBe(true);
    expect(checkAgentReply("You need a reference number to check in.").ok).toBe(true);
    expect(checkAgentReply("Do you need anything else before Tuesday?").ok).toBe(true);
    expect(checkAgentReply("You should get here ten minutes early.").ok).toBe(true);
  });
  it("still blocks a clinical 'you need <clinical thing>' opinion", () => {
    expect(checkAgentReply("You definitely need a filling.").ok).toBe(false);
    expect(checkAgentReply("You need root canal on that tooth.").ok).toBe(false);
  });
});

// The shared-drain backstop scans EVERY module send with includePrice=false: the
// two hard universal rules (no funding jargon, no clinical advice) apply to all
// patient copy, but a real relayed treatment figure must still be allowed.
describe("output guardrail: drain backstop mode (includePrice: false)", () => {
  it("still blocks funding jargon and clinical advice", () => {
    expect(checkAgentReply("On the NHS this is free.", { includePrice: false }).ok).toBe(false);
    expect(checkAgentReply("As a private patient you pay more.", { includePrice: false }).ok).toBe(false);
    expect(checkAgentReply("You definitely need a filling.", { includePrice: false }).ok).toBe(false);
  });
  it("allows a real relayed treatment price (modules quote genuine figures)", () => {
    expect(checkAgentReply("Your treatment plan total is £2,400.", { includePrice: false }).ok).toBe(true);
    expect(checkAgentReply("The balance on your plan is £180 exactly.", { includePrice: false }).ok).toBe(true);
  });
  it("default mode (agent) still blocks a firm price", () => {
    expect(checkAgentReply("Your treatment plan total is £2,400.").ok).toBe(false);
  });
  it("does not trip on representative module templated copy", () => {
    const templated = [
      "Hi Sarah, you are due for your dental check-up. Reply YES to book, or call us on 0161 123 4567.",
      "Reminder: your appointment is on Tuesday at 10:00. Reply YES to confirm or NO to rearrange.",
      "We have a slot free this Thursday at 2pm. Reply YES if you would like it.",
      "Thanks for visiting us today. We would love a quick review: https://example.com/review",
      "It has been a while since your last visit. We would love to see you back, reply YES to book.",
      "Following up on your treatment plan. A coordinator can talk you through the options, reply YES.",
    ];
    for (const body of templated) {
      expect(checkAgentReply(body, { includePrice: false }).ok).toBe(true);
    }
  });
});
