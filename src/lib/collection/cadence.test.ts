import { describe, it, expect } from "vitest";
import {
  COLLECTION_CADENCE,
  classifyCollectionReply,
  collectionStepDef,
  decideCollectionAction,
  escalationForReply,
  escalationPriority,
  stopReasonForReply,
  type CollectionTargetFacts,
} from "./cadence";
import { DEFAULT_COLLECTION_CONFIG, type CollectionState } from "./types";

const DAY = 86_400_000;
const NOW = new Date("2026-08-21T09:00:00Z");

function target(over: Partial<CollectionTargetFacts> = {}): CollectionTargetFacts {
  return {
    patientId: "pat-1",
    siteId: "site-cc",
    active: true,
    consent: { sms: true, email: true },
    ...over,
  };
}

function state(over: Partial<CollectionState> = {}): CollectionState {
  return {
    patientId: "pat-1",
    siteId: "site-cc",
    status: "active",
    step: 0,
    stopReason: null,
    escalatedAt: null,
    escalationReason: null,
    firstQualifiedAt: "2026-07-01T00:00:00Z",
    lastTouchAt: null,
    lastDraftedAt: null,
    retryNotBefore: null,
    consecutiveFailures: 0,
    consecutiveBlocks: 0,
    updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function decide(over: Partial<Parameters<typeof decideCollectionAction>[0]> = {}) {
  return decideCollectionAction({
    target: target(),
    state: null,
    inboundBodies: [],
    excluded: false,
    suppressed: false,
    now: NOW,
    config: DEFAULT_COLLECTION_CONFIG,
    ...over,
  });
}

// ===========================================================================
describe("the cadence itself", () => {
  it("is three messages and then nothing, ever", () => {
    expect(COLLECTION_CADENCE).toHaveLength(3);
    expect(collectionStepDef(4)).toBeNull();
  });

  it("runs 0 / 10 / 21 days, wider than the treatment closer's 0 / 7 / 14", () => {
    // The difference between a practice and a debt collector is, in practice,
    // almost entirely frequency and tone. Three messages over a month is a practice
    // keeping somebody informed; the same three over ten days is being chased.
    expect(COLLECTION_CADENCE.map((s) => s.waitDays)).toEqual([0, 10, 21]);
  });

  it("opens on EMAIL, because an unpaid invoice is paperwork and a handset may be shared", () => {
    expect(COLLECTION_CADENCE.map((s) => s.channel)).toEqual(["email", "sms", "email"]);
  });
});

// ===========================================================================
describe("classifyCollectionReply: the hard stop", () => {
  it.each([
    "This is wrong",
    "I already paid this last month",
    "I've paid it",
    "I want to dispute this",
    "That's not mine",
    "there must be an error",
    "this is incorrect",
    "I never had that done",
    "I don't owe you anything",
    "I want a refund",
    "I'm speaking to my solicitor",
    "this is a scam",
  ])("reads %j as a dispute", (body) => {
    expect(classifyCollectionReply(body)).toBe("dispute");
  });

  it.each([
    "I can't afford it right now",
    "I'm really struggling at the moment",
    "could I do a payment plan",
    "can I pay in instalments",
    "I lost my job",
    "can you give me more time",
  ])("reads %j as hardship", (body) => {
    expect(classifyCollectionReply(body)).toBe("hardship");
  });

  it.each(["STOP", "unsubscribe", "please remove me", "leave me alone"])(
    "reads %j as an opt-out",
    (body) => {
      expect(classifyCollectionReply(body)).toBe("optout");
    },
  );

  it.each([
    "what is this about",
    "which invoice is this",
    "I don't understand",
    "can you explain",
    "who is this",
    "I never got an invoice",
  ])("reads %j as confusion", (body) => {
    expect(classifyCollectionReply(body)).toBe("confusion");
  });

  it.each(["ok", "thanks", "will do", "I'll pay it Friday", "sorting it out today"])(
    "reads %j as an acknowledgement",
    (body) => {
      expect(classifyCollectionReply(body)).toBe("acknowledgement");
    },
  );

  it("FAILS SAFE: anything it cannot place is `unclear`, which is an URGENT escalation", () => {
    expect(classifyCollectionReply("the thing from before, you know")).toBe("unclear");
    expect(escalationForReply("unclear")).toBe("unclear_reply");
    expect(escalationPriority("unclear")).toBe("urgent");
  });

  it("an empty reply is `unclear`, never an acknowledgement", () => {
    // A blank inbound is something we failed to read, not a patient saying yes.
    expect(classifyCollectionReply("")).toBe("unclear");
    expect(classifyCollectionReply("   ")).toBe("unclear");
  });

  it("dispute beats opt-out: 'I already paid, stop texting me' is a contested charge", () => {
    // The suppression layer records the opt-out independently from the same
    // message, so nothing is lost by reading this as the dispute it is.
    expect(classifyCollectionReply("I already paid this, stop texting me")).toBe("dispute");
  });

  it("hardship beats opt-out, so 'I cannot afford this, please stop' reaches a person", () => {
    expect(classifyCollectionReply("I can't afford this, please stop")).toBe("hardship");
  });

  it("EVERY kind produces an escalation: a reply about money always gets a person", () => {
    for (const kind of ["dispute", "hardship", "optout", "confusion", "acknowledgement", "unclear"] as const) {
      expect(escalationForReply(kind), `${kind} raised no work item`).toBeTruthy();
    }
  });

  it("prioritises the four that mean somebody is in trouble or in the dark", () => {
    expect(escalationPriority("dispute")).toBe("urgent");
    expect(escalationPriority("hardship")).toBe("urgent");
    expect(escalationPriority("confusion")).toBe("urgent");
    expect(escalationPriority("unclear")).toBe("urgent");
    expect(escalationPriority("acknowledgement")).toBe("normal");
    expect(escalationPriority("optout")).toBe("normal");
  });

  it("records a reason it can stand behind, never a near-synonym", () => {
    expect(stopReasonForReply("dispute")).toBe("dispute");
    expect(stopReasonForReply("hardship")).toBe("hardship");
    expect(stopReasonForReply("confusion")).toBe("confusion");
    expect(stopReasonForReply("optout")).toBe("opted_out");
    // Neither of these says anything about WHAT the patient said, because we do
    // not know: "the patient replied" is the whole of the claim.
    expect(stopReasonForReply("acknowledgement")).toBe("patient_replied");
    expect(stopReasonForReply("unclear")).toBe("patient_replied");
  });
});

// ===========================================================================
describe("decideCollectionAction", () => {
  it("drafts step 1 for a fresh, consented, active patient", () => {
    const d = decide();
    expect(d).toEqual({ action: "draft", step: COLLECTION_CADENCE[0] });
  });

  it("never revives a terminal conversation", () => {
    expect(decide({ state: state({ status: "stopped" }) })).toEqual({
      action: "skip",
      reason: "already_terminal",
    });
    expect(decide({ state: state({ status: "exhausted" }) })).toEqual({
      action: "skip",
      reason: "already_terminal",
    });
  });

  it("stops on an archived record and on an admin exclusion, with no work item", () => {
    expect(decide({ target: target({ active: false }) })).toEqual({
      action: "stop",
      reason: "excluded",
      escalate: null,
    });
    expect(decide({ excluded: true })).toEqual({ action: "stop", reason: "excluded", escalate: null });
  });

  it("stops on an existing opt-out", () => {
    expect(decide({ suppressed: true })).toEqual({
      action: "stop",
      reason: "opted_out",
      escalate: "opted_out",
    });
  });

  it("ANY reply stops the conversation AND raises a work item", () => {
    expect(decide({ inboundBodies: ["ok thanks"] })).toEqual({
      action: "stop",
      reason: "patient_replied",
      escalate: "acknowledgement",
    });
    expect(decide({ inboundBodies: ["this is wrong"] })).toEqual({
      action: "stop",
      reason: "dispute",
      escalate: "dispute",
    });
  });

  it("a reply STOPS even while a draft is sitting awaiting approval", () => {
    // The stop conditions are all evaluated before the skips, deliberately: a skip
    // running first would leave a live draft for somebody who has already answered,
    // and a human could then approve it.
    const d = decide({
      state: state({ status: "awaiting_approval" }),
      inboundBodies: ["I already paid this"],
    });
    expect(d).toEqual({ action: "stop", reason: "dispute", escalate: "dispute" });
  });

  it("takes the MOST serious classification when several replies arrived", () => {
    const d = decide({ inboundBodies: ["ok", "actually this is wrong"] });
    expect(d).toEqual({ action: "stop", reason: "dispute", escalate: "dispute" });
  });

  it("retires a genuinely undeliverable patient", () => {
    expect(decide({ state: state({ consecutiveFailures: 3 }) })).toEqual({
      action: "stop",
      reason: "undeliverable",
      escalate: null,
    });
  });

  it("does NOT retire a patient on blocks until a much higher ceiling", () => {
    // Most blocks are the cross-module once-per-day cap, which is the platform
    // working correctly. Retiring somebody as "undeliverable" because their daily
    // slot kept going to a recall invite would be a false statement in the record.
    expect(decide({ state: state({ consecutiveBlocks: 3 }) })).toMatchObject({ action: "draft" });
    expect(decide({ state: state({ consecutiveBlocks: 6 }) })).toEqual({
      action: "stop",
      reason: "undeliverable",
      escalate: null,
    });
  });

  it("never stacks a second touch on a pending one", () => {
    expect(decide({ state: state({ status: "awaiting_approval" }) })).toEqual({
      action: "skip",
      reason: "touch_pending",
    });
    expect(decide({ state: state({ status: "in_flight" }) })).toEqual({
      action: "skip",
      reason: "touch_pending",
    });
  });

  it("exhausts after the third SENT message", () => {
    expect(decide({ state: state({ step: 3 }) })).toEqual({
      action: "stop",
      reason: "exhausted",
      escalate: null,
    });
  });

  it("honours a cool-off, and drafts again once it has passed", () => {
    const soon = new Date(NOW.getTime() + DAY).toISOString();
    expect(decide({ state: state({ retryNotBefore: soon }) })).toEqual({
      action: "skip",
      reason: "cooling_off",
    });
    const past = new Date(NOW.getTime() - DAY).toISOString();
    expect(decide({ state: state({ retryNotBefore: past }) })).toMatchObject({ action: "draft" });
  });

  it("SKIPS a step the patient has not consented to rather than moving it to the other channel", () => {
    // Step 1 is email. A patient who agreed only to SMS receives fewer messages,
    // not the same number redirected onto the channel they did agree to.
    const d = decide({ target: target({ consent: { sms: true, email: false } }) });
    expect(d).toEqual({ action: "skip", reason: "no_channel_consent" });
  });

  it("waits the step's gap from the previous SENT message", () => {
    const nineDaysAgo = new Date(NOW.getTime() - 9 * DAY).toISOString();
    expect(decide({ state: state({ step: 1, lastTouchAt: nineDaysAgo }) })).toEqual({
      action: "skip",
      reason: "not_due",
    });
    const elevenDaysAgo = new Date(NOW.getTime() - 11 * DAY).toISOString();
    expect(decide({ state: state({ step: 1, lastTouchAt: elevenDaysAgo }) })).toEqual({
      action: "draft",
      step: COLLECTION_CADENCE[1],
    });
  });

  it("step 2 is SMS, so an email-only patient stops receiving anything after step 1", () => {
    const elevenDaysAgo = new Date(NOW.getTime() - 11 * DAY).toISOString();
    const d = decide({
      target: target({ consent: { sms: false, email: true } }),
      state: state({ step: 1, lastTouchAt: elevenDaysAgo }),
    });
    expect(d).toEqual({ action: "skip", reason: "no_channel_consent" });
  });
});
