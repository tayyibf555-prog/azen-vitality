import { describe, it, expect } from "vitest";
import {
  CLOSER_DISCARD_EFFECT,
  CLOSER_DISCARD_LABEL,
  CLOSER_DISCARD_REASONS,
  TOO_SOON_COOL_OFF_HOURS,
  discardOutcome,
  isCloserDiscardReason,
  type CloserDiscardReason,
} from "./discard";
import { decideCloserAction, type CloserOpportunityFacts } from "./cadence";
import { DEFAULT_CLOSER_CONFIG, type CloserState } from "./types";

// ===========================================================================
// A DISCARD REASON IS AN INSTRUCTION, NOT A NOTE.
//
// The reason a human gives when they reject a draft decides what happens to the
// opportunity: either the closer may try again later, or it stops for good. That
// makes this mapping the sharp edge of the approval surface — get it wrong in one
// direction and the practice keeps chasing a patient it has already dealt with,
// get it wrong in the other and one click about a clumsy sentence silently retires
// somebody's follow-up for ever.
//
// So this file does not merely assert the switch statement. It takes the outcome
// each reason produces, feeds it into a closer_state, and asks the REAL decider
// what it does next — because "stops for good" is a claim about `decideCloserAction`,
// not about a string.
// ===========================================================================

const CONFIG = { cooldownHours: DEFAULT_CLOSER_CONFIG.cooldownHours };

describe("every reason resolves, and the set is closed", () => {
  it("offers five reasons and every one has a label and a stated effect", () => {
    expect(CLOSER_DISCARD_REASONS).toHaveLength(5);
    for (const r of CLOSER_DISCARD_REASONS) {
      expect(CLOSER_DISCARD_LABEL[r], `${r} needs staff-facing wording`).toBeTruthy();
      expect(CLOSER_DISCARD_EFFECT[r], `${r} must say what it does`).toBeTruthy();
      // Staff-facing wording, not the key echoed back at them.
      expect(CLOSER_DISCARD_LABEL[r]).not.toContain("_");
    }
  });

  it("the labels are all distinct, so two choices cannot read as the same choice", () => {
    const labels = CLOSER_DISCARD_REASONS.map((r) => CLOSER_DISCARD_LABEL[r]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("narrows only the five, and nothing that merely looks like them", () => {
    for (const r of CLOSER_DISCARD_REASONS) expect(isCloserDiscardReason(r)).toBe(true);
    for (const bad of [
      "",
      "WRONG_TONE",
      " wrong_tone",
      "wrong_tone ",
      "patient_replied", // a STOP reason, not a discard reason
      "staff_stopped",
      "excluded",
      null,
      undefined,
      0,
      1,
      {},
      ["wrong_tone"],
      true,
    ]) {
      expect(isCloserDiscardReason(bad), `${JSON.stringify(bad)} must not be accepted`).toBe(false);
    }
  });
});

describe("the two 'try again' reasons cool the opportunity off, and do not stop it", () => {
  it("'the wording is not right' uses the module's own configured cool-off", () => {
    const out = discardOutcome("wrong_tone", { cooldownHours: 24 });
    expect(out).toEqual({ kind: "retry", coolOffHours: 24 });
    // It follows the config rather than hard-coding a number, so an operator who
    // widens the cool-off widens this too.
    expect(discardOutcome("wrong_tone", { cooldownHours: 6 })).toEqual({
      kind: "retry",
      coolOffHours: 6,
    });
  });

  it("'not the right moment' waits materially longer than the ordinary cool-off", () => {
    const out = discardOutcome("too_soon", CONFIG);
    expect(out).toEqual({ kind: "retry", coolOffHours: TOO_SOON_COOL_OFF_HOURS });
    // THE POINT OF THE SEPARATE NUMBER: a human said the timing is wrong, and a day
    // later is the same timing. It must also clear the cadence's own 7-day gap, or
    // "later" is inside the window the next step would have used anyway.
    expect(TOO_SOON_COOL_OFF_HOURS).toBeGreaterThan(CONFIG.cooldownHours);
    expect(TOO_SOON_COOL_OFF_HOURS).toBeGreaterThan(7 * 24);
  });
});

describe("the three 'stop' reasons stop, and each records something true", () => {
  it("'we have already spoken to them' records the same reason an inbound reply does", () => {
    // The same FACT arriving by a different route. A near-synonym would split one
    // thing into two in the record for no gain.
    expect(discardOutcome("already_contacted", CONFIG)).toEqual({
      kind: "stop",
      stopReason: "patient_replied",
    });
  });

  it("'this plan is not going ahead' records the plan closing, not the patient refusing", () => {
    expect(discardOutcome("plan_not_live", CONFIG)).toEqual({
      kind: "stop",
      stopReason: "opportunity_closed",
    });
  });

  it("'do not follow this patient up' records that a PERSON decided", () => {
    const out = discardOutcome("do_not_contact", CONFIG);
    expect(out).toEqual({ kind: "stop", stopReason: "staff_stopped" });
    // THE ASSERTION THAT MATTERS: it does not borrow a reason that would be false.
    // 'excluded' claims the patient's admin status excludes them; 'opted_out'
    // claims the patient asked us to stop. Neither happened.
    expect(out).not.toEqual({ kind: "stop", stopReason: "excluded" });
    expect(out).not.toEqual({ kind: "stop", stopReason: "opted_out" });
  });

  it("exactly three of the five are terminal", () => {
    const stops = CLOSER_DISCARD_REASONS.filter((r) => discardOutcome(r, CONFIG).kind === "stop");
    expect(stops.sort()).toEqual(["already_contacted", "do_not_contact", "plan_not_live"]);
  });
});

// ---------------------------------------------------------------------------
// The claim, checked against the REAL decider rather than against a string.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-21T10:00:00.000Z");

const OPPORTUNITY: CloserOpportunityFacts = {
  id: "site-cc:p1:pl1",
  siteId: "site-cc",
  status: "accepted",
  // Old enough to have qualified, young enough not to be retired.
  acceptedAt: "2026-06-01T00:00:00.000Z",
  amountOutstanding: 3400,
  consent: { sms: true, email: true },
};

function stateAfterDiscard(reason: CloserDiscardReason): CloserState {
  const outcome = discardOutcome(reason, CONFIG);
  const base: CloserState = {
    opportunityId: OPPORTUNITY.id,
    siteId: OPPORTUNITY.siteId,
    status: "active",
    step: 0,
    stopReason: null,
    firstQualifiedAt: "2026-07-01T00:00:00.000Z",
    lastTouchAt: null,
    lastDraftedAt: NOW.toISOString(),
    retryNotBefore: null,
    consecutiveFailures: 0,
    updatedAt: NOW.toISOString(),
  };
  // Exactly what discardDraft writes for each outcome.
  if (outcome.kind === "stop") {
    return {
      ...base,
      status: outcome.stopReason === "exhausted" ? "exhausted" : "stopped",
      stopReason: outcome.stopReason,
    };
  }
  return {
    ...base,
    retryNotBefore: new Date(NOW.getTime() + outcome.coolOffHours * 3_600_000).toISOString(),
  };
}

function decide(state: CloserState, at: Date) {
  return decideCloserAction({
    opportunity: OPPORTUNITY,
    state,
    inboundBodies: [],
    excluded: false,
    suppressed: false,
    now: at,
    config: DEFAULT_CLOSER_CONFIG,
  });
}

describe("the decider agrees: 'try again' comes back, 'stop' never does", () => {
  it.each(["already_contacted", "plan_not_live", "do_not_contact"] as const)(
    "%s leaves an opportunity the decider will never draft for again",
    (reason) => {
      const state = stateAfterDiscard(reason);
      // Immediately...
      expect(decide(state, NOW)).toEqual({ action: "skip", reason: "already_terminal" });
      // ...and a year later. Terminal is terminal.
      expect(decide(state, new Date(NOW.getTime() + 365 * 86_400_000))).toEqual({
        action: "skip",
        reason: "already_terminal",
      });
    },
  );

  it.each(["wrong_tone", "too_soon"] as const)(
    "%s holds the opportunity back, then releases it",
    (reason) => {
      const state = stateAfterDiscard(reason);
      const hours = (discardOutcome(reason, CONFIG) as { coolOffHours: number }).coolOffHours;

      // Inside the cool-off: held, and held for the RIGHT reason (not terminal, not
      // "not due" — those would mean something else entirely was stopping it).
      expect(decide(state, NOW)).toEqual({ action: "skip", reason: "cooling_off" });
      const justBefore = new Date(NOW.getTime() + hours * 3_600_000 - 1000);
      expect(decide(state, justBefore)).toEqual({ action: "skip", reason: "cooling_off" });

      // The moment it expires, the closer is free to draft again.
      const after = new Date(NOW.getTime() + hours * 3_600_000 + 1000);
      const d = decide(state, after);
      expect(d.action).toBe("draft");
      // And it comes back at the SAME step: a discarded draft was never sent, so it
      // must not consume a cadence position.
      expect(d).toEqual({ action: "draft", step: { step: 1, channel: "sms", waitDays: 0, purpose: "open" } });
    },
  );

  it("a 'too soon' discard outlasts a 'wrong tone' one, by the decider's own clock", () => {
    // The difference between the two numbers has to be observable in behaviour, or
    // the second reason is decoration.
    const tone = stateAfterDiscard("wrong_tone");
    const soon = stateAfterDiscard("too_soon");
    const at = new Date(NOW.getTime() + 2 * 86_400_000); // two days later
    expect(decide(tone, at).action).toBe("draft");
    expect(decide(soon, at)).toEqual({ action: "skip", reason: "cooling_off" });
  });
});
