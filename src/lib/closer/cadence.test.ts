import { describe, it, expect } from "vitest";
import {
  CLOSER_CADENCE,
  classifyInboundReply,
  closerStepDef,
  decideCloserAction,
  type CloserOpportunityFacts,
} from "./cadence";
import { COORDINATOR_CADENCE } from "@/lib/coordinator/cadence";
import { DEFAULT_CLOSER_CONFIG, type CloserState } from "./types";

const DAY = 86_400_000;
const NOW = new Date("2026-08-21T10:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

function opp(over: Partial<CloserOpportunityFacts> = {}): CloserOpportunityFacts {
  return {
    id: "site-cc:p1:pl1",
    siteId: "site-cc",
    status: "accepted",
    acceptedAt: daysAgo(60),
    amountOutstanding: 1200,
    consent: { sms: true, email: true },
    ...over,
  };
}

function state(over: Partial<CloserState> = {}): CloserState {
  return {
    opportunityId: "site-cc:p1:pl1",
    siteId: "site-cc",
    status: "active",
    step: 0,
    stopReason: null,
    firstQualifiedAt: daysAgo(60),
    lastTouchAt: null,
    lastDraftedAt: null,
    retryNotBefore: null,
    consecutiveFailures: 0,
    updatedAt: daysAgo(60),
    ...over,
  };
}

function decide(over: {
  opportunity?: Partial<CloserOpportunityFacts>;
  state?: CloserState | null;
  inboundBodies?: string[];
  excluded?: boolean;
  suppressed?: boolean;
  now?: Date;
  config?: Partial<typeof DEFAULT_CLOSER_CONFIG>;
} = {}) {
  return decideCloserAction({
    opportunity: opp(over.opportunity),
    state: over.state === undefined ? null : over.state,
    inboundBodies: over.inboundBodies ?? [],
    excluded: over.excluded ?? false,
    suppressed: over.suppressed ?? false,
    now: over.now ?? NOW,
    config: { ...DEFAULT_CLOSER_CONFIG, ...(over.config ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// The cadence itself.
// ---------------------------------------------------------------------------

describe("CLOSER_CADENCE", () => {
  it("is three touches on an absolute day 0 / 7 / 21 schedule", () => {
    expect(CLOSER_CADENCE.map((s) => s.step)).toEqual([1, 2, 3]);
    // waitDays is the gap since the previous SENT touch, so the ABSOLUTE schedule
    // is the running total. A mutation that swapped 14 for 21 (reading waitDays as
    // absolute) would make the last touch land on day 28, not 21.
    let absolute = 0;
    const days = CLOSER_CADENCE.map((s) => (absolute += s.waitDays));
    expect(days).toEqual([0, 7, 21]);
  });

  it("widens the gap rather than repeating it", () => {
    // The whole justification for three touches over 21 days is decay: gaps grow.
    // An equal-gap mutation (7, 7) would pass a naive "three steps" assertion.
    const gaps = CLOSER_CADENCE.slice(1).map((s) => s.waitDays);
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
  });

  it("alternates channels so one missing consent costs one touch, not two", () => {
    expect(CLOSER_CADENCE.map((s) => s.channel)).toEqual(["sms", "email", "sms"]);
  });

  it("starts no sooner than the treatment coordinator's own cadence can finish", () => {
    // THIS IS THE ANTI-OVERLAP RULE, and it is derived rather than asserted as a
    // magic number: the coordinator chases the SAME opportunity on its own
    // schedule, and the closer's settling window must clear that whole span so the
    // two can never be running at once. Lowering minPlanAgeDays below the
    // coordinator's span is exactly the mutation this catches.
    const coordinatorSpan = COORDINATOR_CADENCE.reduce((sum, s) => sum + s.waitDays, 0);
    expect(DEFAULT_CLOSER_CONFIG.minPlanAgeDays).toBeGreaterThan(coordinatorSpan);
  });

  it("closerStepDef resolves each step and returns null past the end", () => {
    expect(closerStepDef(1)?.channel).toBe("sms");
    expect(closerStepDef(2)?.channel).toBe("email");
    expect(closerStepDef(3)?.channel).toBe("sms");
    expect(closerStepDef(4)).toBeNull();
    expect(closerStepDef(0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Qualification.
// ---------------------------------------------------------------------------

describe("decideCloserAction: qualification", () => {
  it("drafts step 1 for an unfinished plan past the settling window", () => {
    const d = decide();
    expect(d).toEqual({ action: "draft", step: CLOSER_CADENCE[0] });
  });

  it("does not touch a plan younger than the settling window", () => {
    // 20 days old, one day short of the 21-day window.
    const d = decide({ opportunity: { acceptedAt: daysAgo(20) } });
    expect(d).toEqual({ action: "skip", reason: "plan_too_new" });
  });

  it("takes a plan the day the settling window is reached, not a day later", () => {
    // Boundary: `age < minPlanAgeDays` skips, so exactly 21 days qualifies. A
    // mutation to `<=` would silently delay every first touch by a day.
    expect(decide({ opportunity: { acceptedAt: daysAgo(21) } }).action).toBe("draft");
  });

  it("skips a remainder below the value floor", () => {
    const d = decide({ opportunity: { amountOutstanding: 99 } });
    expect(d).toEqual({ action: "skip", reason: "below_value_floor" });
  });

  it("takes a remainder exactly ON the value floor", () => {
    // `amountOutstanding < minRemainingValue` skips, so 100 qualifies. A mutation
    // to `<=` would drop every opportunity sitting exactly on the floor.
    expect(decide({ opportunity: { amountOutstanding: 100 } }).action).toBe("draft");
  });

  it("skips when the step's own channel has no consent, and does not substitute another", () => {
    // Step 1 is SMS. Email consent is present, and must NOT be used instead: the
    // patient consented to email, not to being texted.
    const smsOnly = decide({ opportunity: { consent: { sms: false, email: true } } });
    expect(smsOnly).toEqual({ action: "skip", reason: "no_channel_consent" });

    // Step 2 is email, so the same patient with the opposite consent is skipped
    // there and nowhere else.
    const emailStep = decide({
      opportunity: { consent: { sms: true, email: false } },
      state: state({ step: 1, lastTouchAt: daysAgo(10) }),
    });
    expect(emailStep).toEqual({ action: "skip", reason: "no_channel_consent" });
  });

  it("waits the step gap between touches, and goes the moment it has elapsed", () => {
    const tooSoon = decide({ state: state({ step: 1, lastTouchAt: daysAgo(6) }) });
    expect(tooSoon).toEqual({ action: "skip", reason: "not_due" });

    const due = decide({ state: state({ step: 1, lastTouchAt: daysAgo(7) }) });
    expect(due).toEqual({ action: "draft", step: CLOSER_CADENCE[1] });
  });

  it("uses the THIRD step's longer gap, not the second's", () => {
    // Step 3 waits 14 days, not 7. A mutation that reused the previous step's gap
    // would fire the final message a week early.
    expect(decide({ state: state({ step: 2, lastTouchAt: daysAgo(8) }) })).toEqual({
      action: "skip",
      reason: "not_due",
    });
    expect(decide({ state: state({ step: 2, lastTouchAt: daysAgo(14) }) })).toEqual({
      action: "draft",
      step: CLOSER_CADENCE[2],
    });
  });

  it("never drafts on top of a touch already pending, drafted or queued", () => {
    expect(decide({ state: state({ status: "awaiting_approval" }) })).toEqual({
      action: "skip",
      reason: "touch_pending",
    });
    expect(decide({ state: state({ status: "in_flight" }) })).toEqual({
      action: "skip",
      reason: "touch_pending",
    });
  });

  it("cools off after a refusal or a discarded draft, then resumes", () => {
    const cooling = decide({ state: state({ retryNotBefore: new Date(NOW.getTime() + 60_000).toISOString() }) });
    expect(cooling).toEqual({ action: "skip", reason: "cooling_off" });

    const expired = decide({ state: state({ retryNotBefore: new Date(NOW.getTime() - 60_000).toISOString() }) });
    expect(expired.action).toBe("draft");
  });

  it("ignores an unparseable cooldown rather than blocking forever", () => {
    expect(decide({ state: state({ retryNotBefore: "not-a-date" }) }).action).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// Stop conditions.
// ---------------------------------------------------------------------------

describe("decideCloserAction: stop conditions", () => {
  it("stops on a completed plan", () => {
    expect(decide({ opportunity: { status: "completed" } })).toEqual({
      action: "stop",
      reason: "plan_completed",
    });
  });

  it("stops when there is nothing left to do on the plan", () => {
    expect(decide({ opportunity: { amountOutstanding: 0 } })).toEqual({
      action: "stop",
      reason: "plan_completed",
    });
    expect(decide({ opportunity: { amountOutstanding: -5 } })).toEqual({
      action: "stop",
      reason: "plan_completed",
    });
  });

  it("stops on a status outside the coordinator's open set", () => {
    const d = decide({
      opportunity: { status: "archived" as CloserOpportunityFacts["status"] },
    });
    expect(d).toEqual({ action: "stop", reason: "opportunity_closed" });
  });

  it("keeps working the three OPEN statuses", () => {
    for (const status of ["accepted", "in_progress", "stalled"] as const) {
      expect(decide({ opportunity: { status } }).action).toBe("draft");
    }
  });

  it("stops on ANY reply, whatever it says", () => {
    expect(decide({ inboundBodies: ["ok thanks"] })).toEqual({
      action: "stop",
      reason: "patient_replied",
    });
    // Fail-safe: a reply the classifier has no pattern for still stops.
    expect(decide({ inboundBodies: ["🙂"] })).toEqual({
      action: "stop",
      reason: "patient_replied",
    });
  });

  it("stops with the DISPUTE reason when any reply contests something", () => {
    expect(decide({ inboundBodies: ["fine", "I already paid for that"] })).toEqual({
      action: "stop",
      reason: "dispute",
    });
  });

  it("stops with the OPT-OUT reason on a stop request", () => {
    expect(decide({ inboundBodies: ["please remove me from your list"] })).toEqual({
      action: "stop",
      reason: "opted_out",
    });
  });

  it("stops on an existing suppression, before it ever looks at a step", () => {
    expect(decide({ suppressed: true })).toEqual({ action: "stop", reason: "opted_out" });
  });

  it("stops on a patient excluded by admin status", () => {
    expect(decide({ excluded: true })).toEqual({ action: "stop", reason: "excluded" });
  });

  it("stops a plan past the age ceiling", () => {
    expect(decide({ opportunity: { acceptedAt: daysAgo(366) } })).toEqual({
      action: "stop",
      reason: "too_old",
    });
    // The boundary itself is still live: `age > maxPlanAgeDays` stops.
    expect(decide({ opportunity: { acceptedAt: daysAgo(365) } }).action).toBe("draft");
  });

  it("stops a plan whose acceptance date cannot be read", () => {
    // Refuse rather than guess: we will not follow up on a plan whose age is unknown.
    expect(decide({ opportunity: { acceptedAt: "" } })).toEqual({
      action: "stop",
      reason: "too_old",
    });
  });

  it("stops once the cadence is exhausted", () => {
    expect(decide({ state: state({ step: 3, lastTouchAt: daysAgo(90) }) })).toEqual({
      action: "stop",
      reason: "exhausted",
    });
  });

  it("retires an opportunity we repeatedly cannot deliver to", () => {
    // The failure counter is the fix for a permanently failing channel replaying
    // the same step forever. Two failures is still live, three retires it.
    expect(decide({ state: state({ consecutiveFailures: 2 }) }).action).toBe("draft");
    expect(decide({ state: state({ consecutiveFailures: 3 }) })).toEqual({
      action: "stop",
      reason: "undeliverable",
    });
  });

  it("never revives an already terminal opportunity", () => {
    for (const status of ["stopped", "exhausted"] as const) {
      expect(decide({ state: state({ status }) })).toEqual({
        action: "skip",
        reason: "already_terminal",
      });
    }
  });

  it("stops a replied patient EVEN while a draft of theirs waits for approval", () => {
    // Ordering pin. If any skip ran before the stop checks, this would return
    // touch_pending and the closer would keep holding a stale draft for someone
    // who has already answered.
    const d = decide({
      state: state({ status: "awaiting_approval" }),
      inboundBodies: ["yes please book me in"],
    });
    expect(d).toEqual({ action: "stop", reason: "patient_replied" });
  });

  it("stops a completed plan EVEN while a draft of theirs waits for approval", () => {
    const d = decide({
      state: state({ status: "awaiting_approval" }),
      opportunity: { status: "completed" },
    });
    expect(d).toEqual({ action: "stop", reason: "plan_completed" });
  });
});

// ---------------------------------------------------------------------------
// Reply classification.
// ---------------------------------------------------------------------------

describe("classifyInboundReply", () => {
  it("recognises disputes", () => {
    for (const body of [
      "I already paid for this",
      "this is wrong",
      "wrong person",
      "I never agreed to that treatment",
      "I didn't agree to this",
      "this must be a mistake",
      "I want to dispute this",
      "I am going to complain",
      "my solicitor will be in touch",
      "I want a refund",
      "stop harassing me",
    ]) {
      expect(classifyInboundReply(body), body).toBe("dispute");
    }
  });

  it("recognises opt-outs", () => {
    for (const body of [
      "STOP",
      "please stop",
      "unsubscribe",
      "opt out",
      "remove me",
      "take me off your list",
      "do not contact me again",
      "leave me alone",
      "no more texts",
    ]) {
      expect(classifyInboundReply(body), body).toBe("optout");
    }
  });

  it("lets a dispute win when a reply is both", () => {
    // Both stop the closer, so precedence only decides what a human sees, and a
    // contested plan is the one that needs a person. The opt-out is not lost: the
    // suppression layer records it from the same message.
    expect(classifyInboundReply("this is wrong, stop texting me")).toBe("dispute");
  });

  it("treats anything else as a plain reply, which still stops the cadence", () => {
    expect(classifyInboundReply("yes please")).toBe("reply");
    expect(classifyInboundReply("")).toBe("reply");
    expect(classifyInboundReply("can I book for next Tuesday")).toBe("reply");
  });

  it("does not fire on ordinary words that merely contain a keyword", () => {
    // Word boundaries matter: a mutation dropping \b would classify these as stops
    // for the wrong reason.
    expect(classifyInboundReply("the appointment was unstoppable fun")).toBe("reply");
  });
});
