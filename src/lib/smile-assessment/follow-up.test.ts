// THE FOLLOW-UP RULES, called for real.
//
// This is the pure half of B2: what an un-configured campaign does (which has to
// be exactly what it did before the feature existed), what a configured one does,
// and what wording a practice may put in front of a patient. The WIRING — that the
// submit route asks these questions, that the send path uses the answer, that the
// PATCH route refuses what the validator refuses — is held next door in
// follow-up-wiring.test.ts, because none of those files can be called in
// environment:"node".
//
// THE CLAIM THIS FILE EXISTS FOR is the first describe block: OFF IS TODAY. Every
// other thing here is a detail; that one is the reason the feature can ship
// switched on in code and switched off in behaviour.

import { describe, it, expect } from "vitest";
import {
  FOLLOW_UP_OFF,
  FOLLOW_UP_TOKENS,
  FOLLOW_UP_TRIGGERS,
  MAX_FOLLOW_UP_TEMPLATE,
  describeFollowUpTemplateFailure,
  describeFollowUpTemplateFailures,
  firstNameOf,
  firstTouchOverride,
  followUpConfig,
  followUpTriggerLabel,
  isFollowUpTrigger,
  normaliseFollowUpTemplate,
  renderFollowUpTemplate,
  shouldFollowUp,
  validateFollowUpTemplate,
  type FollowUpConfig,
} from "./follow-up";
import type { AssessmentBand } from "./types";

const BANDS: AssessmentBand[] = ["high", "medium", "low"];

/* ---------------------------------------------------------------------------
 * 1. OFF IS TODAY. The safety property, pinned six ways.
 * ------------------------------------------------------------------------- */

describe("an un-configured campaign behaves exactly as it did before 0082", () => {
  // The expression this feature replaced at the submit route's bridge, kept here
  // as a literal so the equivalence is checked against the OLD CODE rather than
  // against a restatement of the new code.
  const todaysGate = (band: AssessmentBand) => band === "high";

  it("gates the bridge on band === 'high', for every band", () => {
    for (const band of BANDS) {
      expect(shouldFollowUp(FOLLOW_UP_OFF, band)).toBe(todaysGate(band));
    }
  });

  // MUTATION: make followUpConfig read the trigger before checking `enabled` and
  // this fails. A campaign whose owner set 'all', typed a message, and then
  // switched the whole thing off would start contacting every medium and low
  // scorer — the exact behaviour the switch is there to prevent.
  it("ignores a stored trigger and template while the switch is off", () => {
    const config = followUpConfig({
      followUpEnabled: false,
      followUpTrigger: "all",
      followUpTemplate: "Hi {name}, we would love to help.",
    });
    expect(config).toEqual(FOLLOW_UP_OFF);
    for (const band of BANDS) {
      expect(shouldFollowUp(config, band)).toBe(todaysGate(band));
    }
    expect(firstTouchOverride(config)).toBeNull();
  });

  // The five roads to OFF: a false column, a null column, an absent column (an
  // un-applied 0082, where select("*") returns no key at all), no fields object,
  // and a campaign-less submission. All five must be the same behaviour, because
  // all five are "nobody configured anything".
  it("collapses every un-configured shape to the same config", () => {
    const shapes = [
      { followUpEnabled: false },
      { followUpEnabled: null },
      {},
      null,
      undefined,
    ] as const;
    for (const shape of shapes) {
      expect(followUpConfig(shape)).toEqual(FOLLOW_UP_OFF);
      expect(firstTouchOverride(followUpConfig(shape))).toBeNull();
    }
  });

  // MUTATION: hand out the FOLLOW_UP_OFF object unfrozen and one caller mutating
  // the config it was given silently re-configures every un-enabled campaign in
  // the process, because they all share the object.
  it("cannot be mutated by a caller", () => {
    const config = followUpConfig({}) as FollowUpConfig;
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { enabled: boolean }).enabled = true;
    }).toThrow();
    expect(followUpConfig({}).enabled).toBe(false);
  });

  it("means the model writes the first message", () => {
    expect(FOLLOW_UP_OFF.template).toBeNull();
    expect(firstTouchOverride(FOLLOW_UP_OFF)).toBeNull();
  });

  // BELT AND BRACES, AND THE BRACES ARE THE POINT. followUpConfig already blanks
  // the template when the switch is off, so on today's paths firstTouchOverride's
  // own `enabled` check can never fire. It is still there, and it is still tested,
  // because a config can be built WITHOUT going through followUpConfig — a
  // fixture, a future settings screen, a merge of two configs — and the failure
  // mode is a switched-off campaign sending an owner's wording to a patient.
  //
  // MUTATION: make firstTouchOverride a bare `return config.template` and this is
  // the only test in the suite that notices.
  it("refuses to hand out an override on a config that says it is off", () => {
    const handBuilt: FollowUpConfig = { enabled: false, trigger: "all", template: "Hi {name}." };
    expect(firstTouchOverride(handBuilt)).toBeNull();
    expect(firstTouchOverride({ ...handBuilt, enabled: true })).toBe("Hi {name}.");
  });
});

/* ---------------------------------------------------------------------------
 * 2. The trigger, once it is on.
 * ------------------------------------------------------------------------- */

describe("the trigger widens who is bridged, and nothing else", () => {
  it("'high' is the same gate the OFF config makes", () => {
    const config = followUpConfig({ followUpEnabled: true, followUpTrigger: "high" });
    for (const band of BANDS) {
      expect(shouldFollowUp(config, band)).toBe(shouldFollowUp(FOLLOW_UP_OFF, band));
    }
  });

  it("'all' takes every band", () => {
    const config = followUpConfig({ followUpEnabled: true, followUpTrigger: "all" });
    for (const band of BANDS) expect(shouldFollowUp(config, band)).toBe(true);
  });

  // MUTATION: trust the stored string and a hand-edited row saying 'everyone'
  // becomes an unrecognised trigger. Falling back to 'high' is the NARROWER
  // answer, which is the direction an unrecognised value has to fail in when the
  // consequence is a text message.
  it("falls back to the narrower trigger for a value it does not recognise", () => {
    for (const junk of ["everyone", "ALL", "", "medium", null, undefined, 7]) {
      const config = followUpConfig({
        followUpEnabled: true,
        followUpTrigger: junk as string | null,
      });
      expect(config.trigger).toBe("high");
      expect(shouldFollowUp(config, "medium")).toBe(false);
    }
  });

  it("has a closed list of exactly two triggers, each with a label", () => {
    expect([...FOLLOW_UP_TRIGGERS]).toEqual(["high", "all"]);
    for (const trigger of FOLLOW_UP_TRIGGERS) {
      expect(isFollowUpTrigger(trigger)).toBe(true);
      expect(followUpTriggerLabel(trigger).length).toBeGreaterThan(0);
    }
    for (const junk of ["everyone", "High", "", 1, null, {}]) {
      expect(isFollowUpTrigger(junk)).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. The template: normalisation.
 * ------------------------------------------------------------------------- */

describe("normaliseFollowUpTemplate", () => {
  it("returns null for anything that is not usable text", () => {
    for (const junk of ["", "   ", "\n\n", null, undefined, 42, {}, []]) {
      expect(normaliseFollowUpTemplate(junk)).toBeNull();
    }
  });

  // MUTATION: collapse \n along with the other whitespace and a two-line first
  // message silently becomes one line — the owner's paragraph break, which is a
  // normal SMS shape, rewritten without being asked.
  it("keeps deliberate line breaks and collapses only the accidental ones", () => {
    expect(normaliseFollowUpTemplate("Hi there.\n\nReply and we will help.")).toBe(
      "Hi there.\n\nReply and we will help.",
    );
    expect(normaliseFollowUpTemplate("Hi there.\n\n\n\nReply.")).toBe("Hi there.\n\nReply.");
    expect(normaliseFollowUpTemplate("Hi   there.\t\tReply.")).toBe("Hi there. Reply.");
    expect(normaliseFollowUpTemplate("Line one.\r\nLine two.")).toBe("Line one.\nLine two.");
  });

  // MUTATION: leave the C0 range in and a stray BEL or ESC rides into an SMS
  // body, where it is invisible to whoever typed it and to whoever reviews it.
  // Written \\u here for the same reason follow-up.ts writes the class that way.
  it("strips control characters but not the two that mean something", () => {
    expect(normaliseFollowUpTemplate("Hi\u0007there.")).toBe("Hi there.");
    expect(normaliseFollowUpTemplate("Hi\u001bthere\u007f.")).toBe("Hi there .");
  });

  it("caps the stored value at the maximum", () => {
    const long = "a".repeat(MAX_FOLLOW_UP_TEMPLATE + 50);
    expect(normaliseFollowUpTemplate(long)?.length).toBe(MAX_FOLLOW_UP_TEMPLATE);
  });
});

/* ---------------------------------------------------------------------------
 * 4. The template: the write gate.
 * ------------------------------------------------------------------------- */

function failureKinds(value: unknown): string[] {
  const result = validateFollowUpTemplate(value);
  return result.ok ? [] : result.failures.map((f) => f.kind);
}

describe("validateFollowUpTemplate", () => {
  it("accepts a plain, compliant first message and returns its stored form", () => {
    const result = validateFollowUpTemplate(
      "  Hi {name}, it is {practice}. Thanks for finishing the questions. Shall we find you a time that suits?  ",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template).toBe(
        "Hi {name}, it is {practice}. Thanks for finishing the questions. Shall we find you a time that suits?",
      );
    }
  });

  it("refuses an empty message, on its own, without piling on", () => {
    expect(failureKinds("   ")).toEqual(["empty"]);
    expect(failureKinds(null)).toEqual(["empty"]);
  });

  // MUTATION: judge the length AFTER the cap is applied and an over-long message
  // is silently truncated mid-word and sent, instead of being refused.
  it("refuses a message longer than a first text should be", () => {
    expect(failureKinds("a".repeat(MAX_FOLLOW_UP_TEMPLATE + 1))).toContain("length");
    expect(failureKinds("a".repeat(MAX_FOLLOW_UP_TEMPLATE))).toEqual([]);
  });

  it("refuses a token it cannot fill in, and names it", () => {
    const result = validateFollowUpTemplate("Hi {first_name}, about your {treatment}.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.map((f) => f.kind)).toEqual(["token", "token"]);
      expect(describeFollowUpTemplateFailures(result.failures)).toContain("{first_name}");
      expect(describeFollowUpTemplateFailures(result.failures)).toContain("{treatment}");
    }
  });

  it("accepts the two tokens it does have, in any case", () => {
    expect(failureKinds("Hi {NAME}, it is {Practice}.")).toEqual([]);
    expect([...FOLLOW_UP_TOKENS]).toEqual(["name", "practice"]);
  });

  // THE COMPLIANCE CLAIM. The same scan the funnel copy goes through, so a word a
  // funnel may not publish is a word this may not send.
  it("refuses funding jargon, in any usage", () => {
    for (const text of [
      "Hi {name}, we can see you on the NHS next week.",
      "Hi {name}, this would be a private appointment.",
      "Hi {name}, we can treat you privately.",
    ]) {
      const result = validateFollowUpTemplate(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failures.some((f) => f.kind === "copy" || f.kind === "guardrail")).toBe(true);
      }
    }
  });

  it("refuses the wording the house compliance list refuses", () => {
    // A guarantee and a pain-free claim: scanBannedText's territory, reached
    // through scanFlowCopyText, which is the point of reusing it.
    expect(failureKinds("Hi {name}, we guarantee you will love your new smile.")).toContain("copy");
    expect(failureKinds("Hi {name}, it is completely pain free.")).toContain("copy");
  });

  // THE ONE THAT MATTERS OPERATIONALLY. contactLead treats a guardrail hit as
  // terminal and retires the lead to 'lost'. A template that trips it would burn
  // every enquiry the campaign produced, silently. So the write gate is a superset
  // of the send gate.
  //
  // MUTATION: drop the checkAgentReply call from validateFollowUpTemplate and this
  // fails — and the feature ships with a way for an owner to destroy their own
  // pipeline by typing a sentence.
  it("refuses wording that the SEND path's own guardrail would block", () => {
    const clinical = "Hi {name}, you need a filling. Shall we book you in?";
    expect(failureKinds(clinical)).toContain("guardrail");
  });

  // includePrice:false matches contact.ts exactly. A hedged "from £X" is allowed
  // there, so it has to be allowed here, or an owner is refused wording the sender
  // would have been happy with.
  it("allows a hedged price, exactly as the send path does", () => {
    expect(failureKinds("Hi {name}, treatments start from £99. Shall we find you a time?")).toEqual(
      [],
    );
  });

  it("reports EVERY problem at once, not the first", () => {
    const result = validateFollowUpTemplate("Hi {oops}, we guarantee it on the NHS.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const kinds = new Set(result.failures.map((f) => f.kind));
      expect(kinds.has("token")).toBe(true);
      expect(kinds.size).toBeGreaterThan(1);
      // One line per failure, each a sentence an owner can act on.
      const described = describeFollowUpTemplateFailures(result.failures);
      expect(described.split("\n")).toHaveLength(result.failures.length);
      for (const failure of result.failures) {
        expect(describeFollowUpTemplateFailure(failure).length).toBeGreaterThan(0);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * 5. Rendering, at send time.
 * ------------------------------------------------------------------------- */

describe("renderFollowUpTemplate", () => {
  it("fills the two tokens from the lead and the practice", () => {
    expect(
      renderFollowUpTemplate("Hi {name}, it is {practice}. Shall we find you a time?", {
        name: "Sam Okafor",
        practice: "Vitality Dental",
      }),
    ).toBe("Hi Sam, it is Vitality Dental. Shall we find you a time?");
  });

  it("uses the first name only, like the drafted message does", () => {
    expect(firstNameOf("Sam Okafor")).toBe("Sam");
    expect(firstNameOf("  Priya   Nair ")).toBe("Priya");
    expect(firstNameOf("Cher")).toBe("Cher");
    expect(firstNameOf("")).toBe("");
    expect(firstNameOf(null)).toBe("");
  });

  it("falls back to wording that still reads as a sentence", () => {
    expect(renderFollowUpTemplate("Hi {name}, it is {practice}.", {})).toBe(
      "Hi there, it is the practice.",
    );
  });

  // MUTATION: re-scan the substituted output for tokens and a patient whose name
  // is "{practice}" expands into the practice's name, which is a small injection
  // through a text field a stranger controls.
  it("never re-expands a value that looks like a token", () => {
    expect(renderFollowUpTemplate("Hi {name}.", { name: "{practice}", practice: "Vitality" })).toBe(
      "Hi {practice}.",
    );
  });

  // MUTATION: blank an unknown token instead of leaving it and a clause silently
  // disappears from a patient's message. Literal braces are an obvious bug;
  // a missing sentence is not. (The validator refuses these at the door, so this
  // only fires for a row that predates a retired token.)
  it("leaves a token it does not know exactly as typed", () => {
    expect(renderFollowUpTemplate("Hi {name}, about {treatment}.", { name: "Sam" })).toBe(
      "Hi Sam, about {treatment}.",
    );
  });

  it("does not leave a double space behind an empty value", () => {
    expect(renderFollowUpTemplate("Hi {name} , welcome.", { name: "Sam" })).toBe(
      "Hi Sam , welcome.",
    );
    expect(renderFollowUpTemplate("  Hi {name}.  ", { name: "Sam" })).toBe("Hi Sam.");
  });

  // The end-to-end shape of the promise: what an owner types, once rendered, is
  // still something the send path's guardrail will pass. If this ever fails, the
  // write gate has stopped being a superset of the send gate.
  it("renders a validated template into wording the send guardrail accepts", () => {
    const typed = "Hi {name}, it is {practice}. Thanks for your answers, shall we find you a time?";
    const result = validateFollowUpTemplate(typed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rendered = renderFollowUpTemplate(result.template, {
        name: "Sam Okafor",
        practice: "Vitality Dental",
      });
      expect(validateFollowUpTemplate(rendered).ok).toBe(true);
    }
  });
});
