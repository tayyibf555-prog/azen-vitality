// Outreach draft: the deterministic fallback is guardrail-safe (no funding/clinical
// jargon, no em-dash), and draftOutreach falls back to it whenever the model call
// fails OR its output trips the guardrail, so a step is never queued empty or unsafe.
//
// AND WHAT IT COSTS TO SEND. Until 6 Sep 2026 the only length rule anywhere on this
// path was the prompt line "Under 90 words" — an instruction, in the wrong unit, with
// nothing measuring the body afterwards — and the deterministic fallback itself
// measured 222/192/205 GSM-7 units on the fixture below, two billed segments each
// before a model was involved at all, so the safety net could not have met the
// ceiling the model is now held to. Twilio bills per 160-septet segment against the
// flat per-message price this platform was compared with, so the "one billed credit"
// block below is a money test, not a tidiness one.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));

import {
  outreachFallbackBody,
  firstName,
  draftOutreach,
  buildOutreachPrompt,
  chooseFallbackBody,
  measureOutreachBody,
  OutreachDraftTooLongError,
  OUTREACH_MAX_UNITS,
} from "./draft";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { gsm7LengthUnits, smsCost } from "@/lib/triage/sms-cost";
import { OUTREACH_CADENCE } from "./cadence";
import type { OutreachCampaign, OutreachTarget } from "./types";

function campaign(over: Partial<OutreachCampaign> = {}): OutreachCampaign {
  return {
    id: "c1",
    clientId: "vitality",
    siteId: "site-cc",
    name: "Saturday hygiene",
    status: "running",
    filters: {},
    practitionerId: "p1",
    practitionerName: "Dr Patel",
    messageAngle: "hygiene appointment",
    messageAngleB: null,
    dailyCap: 25,
    buildCursor: null,
    counts: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function target(over: Partial<OutreachTarget> = {}): OutreachTarget {
  return {
    id: "t1",
    campaignId: "c1",
    patientId: "1",
    name: "Jane Smith",
    phone: "07700900000",
    siteId: "site-cc",
    matchedReason: "Scale & Polish 14 Mar 2025",
    status: "pending",
    consent: { sms: true, email: false, marketing: false },
    variant: null,
    currentStep: 0,
    nextDueAt: null,
    startedAt: null,
    endedAt: null,
    repliedAt: null,
    bookedAt: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("firstName", () => {
  it("takes the first token, or a friendly default", () => {
    expect(firstName("Jane Smith")).toBe("Jane");
    expect(firstName("  ")).toBe("there");
  });
});

describe("outreachFallbackBody", () => {
  for (const step of OUTREACH_CADENCE) {
    it(`step ${step.step} (${step.purpose}) is warm, personal and guardrail-safe`, () => {
      const body = outreachFallbackBody(target(), campaign(), step);
      expect(body).toContain("Jane");
      expect(body.toLowerCase()).toContain("dr patel");
      // House rules: no em-dash, no NHS/private/funding wording, no clinical advice.
      expect(body).not.toMatch(/[—–]/);
      expect(checkAgentReply(body, { includePrice: false }).ok).toBe(true);
    });
  }

  it("still works with no clinician named", () => {
    const body = outreachFallbackBody(target(), campaign({ practitionerName: null }), OUTREACH_CADENCE[0]);
    expect(body).toContain("Jane");
    expect(checkAgentReply(body, { includePrice: false }).ok).toBe(true);
  });
});

describe("draftOutreach fallback behaviour", () => {
  const step = OUTREACH_CADENCE[0];

  it("uses the model reply when it is clean", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, lovely to reach out." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(false);
    expect(res.body).toBe("Hi Jane, lovely to reach out.");
  });

  it("falls back when the model output trips the guardrail (NHS wording)", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, book your NHS check-up." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body.toLowerCase()).not.toContain("nhs");
  });

  // Finding #4 (compliance): outreach is patient-facing marketing SMS, so an INVENTED
  // firm price must trip the guardrail (includePrice is enforced here, not disabled)
  // and the deterministic fallback (which carries no price) must be used instead.
  it("falls back when the model invents a firm marketing price (just £99)", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, whitening this month, just £99! Reply to book." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).not.toContain("£"); // the safe fallback quotes no price at all
    expect(res.body).not.toContain("99");
  });

  it("falls back when the model states a firm exact price (it costs £99)", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, a scale and polish costs £99. Reply to book." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).not.toContain("£");
  });

  it("does NOT over-block a legitimately hedged 'from £' selling point", async () => {
    // A hedged "from £X" line is the one allowed price shape; it must pass, not fall back.
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, whitening from £99. Reply and we will find a time that suits you." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(false);
    expect(res.body).toContain("from £99");
  });

  it("falls back when the model call throws", async () => {
    const client = { messages: { create: vi.fn(async () => { throw new Error("model down"); }) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).toContain("Jane");
  });

  it("falls back when the model returns an empty body", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).toBeTruthy();
  });
});

describe("A/B variant drafting", () => {
  const step = OUTREACH_CADENCE[0];
  const ab = campaign({ messageAngle: "a hygiene visit", messageAngleB: "an implant review" });

  it("variant 'b' writes the prompt from the second angle", async () => {
    const create = vi.fn(async (_p: unknown) => ({ content: [{ type: "text", text: "Hi Jane, lovely to reach out." }] }));
    const client = { messages: { create } };
    const res = await draftOutreach(target(), ab, "sms", step, client as never, "b");
    expect(res.usedFallback).toBe(false);
    // The system + user prompt must carry the B angle, not the primary one.
    const sent = JSON.stringify(create.mock.calls[0][0]);
    expect(sent).toContain("an implant review");
    expect(sent).not.toContain("a hygiene visit");
  });

  it("variant 'a' still writes the prompt from the primary angle", async () => {
    const create = vi.fn(async (_p: unknown) => ({ content: [{ type: "text", text: "Hi Jane, lovely to reach out." }] }));
    const client = { messages: { create } };
    await draftOutreach(target(), ab, "sms", step, client as never, "a");
    const sent = JSON.stringify(create.mock.calls[0][0]);
    expect(sent).toContain("a hygiene visit");
    expect(sent).not.toContain("an implant review");
  });

  it("the deterministic fallback for variant 'b' uses the second angle and stays guardrail-safe", () => {
    const body = outreachFallbackBody(target(), ab, step, "b");
    expect(body).toContain("an implant review");
    expect(body).not.toContain("a hygiene visit");
    expect(body).not.toMatch(/[—–]/);
    expect(checkAgentReply(body, { includePrice: false }).ok).toBe(true);
  });

  it("a variant 'b' draft is held to the SAME guardrail (NHS wording trips it, falls back to the B angle)", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, book your NHS implant review." }] })) } };
    const res = await draftOutreach(target(), ab, "sms", step, client as never, "b");
    expect(res.usedFallback).toBe(true);
    expect(res.body.toLowerCase()).not.toContain("nhs");
    // Fallback still carries the B angle, so the variant is preserved even on a block.
    expect(res.body).toContain("an implant review");
  });
});

// ===========================================================================
// ONE BILLED CREDIT.
//
// Every assertion here is about the number the client was shown: Dentally bills
// per MESSAGE (7p flat on the real August 2026 invoice), Twilio bills per
// SEGMENT, and the break-even is 1.69 segments. A drafter with no ceiling puts
// this platform on the wrong side of it silently. The measure is
// gsm7LengthUnits/smsCost from src/lib/triage/sms-cost.ts, which is what the
// carrier counts, not String.length.
// ===========================================================================
describe("outreach SMS budget", () => {
  /** A model client that answers each turn from the queue, so a repair turn is observable. */
  function scripted(...replies: string[]) {
    // `sent` keeps the request of each turn: the repair turn must be inspectable
    // (it has to carry the first draft and the real numbers, not a fresh prompt).
    const sent: unknown[] = [];
    const create = vi.fn(async (req: unknown) => {
      sent.push(req);
      return { content: [{ type: "text", text: replies.shift() ?? "" }] };
    });
    return { client: { messages: { create } } as never, create, sent };
  }

  // 90 words of ordinary English: what the old prompt line permitted and nothing
  // measured. Four billed segments in GSM-7.
  const NINETY_WORDS =
    "Hi Jane, it has been quite a long while since we last saw you here at the practice and " +
    "we would really love to welcome you back in for a hygiene appointment with Dr Patel, who " +
    "has plenty of availability over the next few weeks including some later afternoon and " +
    "early evening times which many of our patients tell us are far easier to fit around work " +
    "and family, so please do just reply to this message whenever suits and we will happily " +
    "find you a time that works.";

  it("the deterministic fallback fits one billed SMS credit at every cadence step", () => {
    for (const step of OUTREACH_CADENCE) {
      for (const variant of ["a", "b"] as const) {
        const body = outreachFallbackBody(
          target(),
          campaign({ messageAngleB: "an implant review" }),
          step,
          variant,
        );
        const budget = measureOutreachBody(body, "sms");
        expect(budget.limit).toBe(160);
        expect(budget.units).toBeLessThanOrEqual(160);
        expect(budget.segments).toBe(1);
        expect(budget.encoding).toBe("gsm7");
      }
    }
  });

  it("the fallback drops the clinician clause rather than exceed the ceiling", () => {
    // A 60-character diary name (the sanitiser's cap) is the likeliest single reason
    // a body overruns; rung 2 drops that clause and keeps the whole invitation.
    const long = campaign({
      practitionerName: "Dr Alexandrina Constantina Featherstonehaugh-Wintersgill",
    });
    const body = outreachFallbackBody(target(), long, OUTREACH_CADENCE[0]);
    expect(gsm7LengthUnits(body)).toBeLessThanOrEqual(160);
    expect(body).toContain("Jane");
    expect(body).toContain("hygiene appointment");
    expect(body).not.toContain("Featherstonehaugh");
  });

  it("the fallback drops a long campaign angle to the neutral invitation rather than exceed the ceiling", () => {
    const wordy = campaign({
      practitionerName: null,
      messageAngle: "a free Invisalign consultation with our treatment coordinator",
    });
    const body = outreachFallbackBody(
      target({ name: "Bartholomew Fitzwilliam" }),
      wordy,
      OUTREACH_CADENCE[0],
    );
    expect(gsm7LengthUnits(body)).toBeLessThanOrEqual(160);
    expect(body).toContain("Bartholomew");
    expect(body).toContain("an appointment");
    expect(body).not.toContain("Invisalign");
  });

  it("the fallback refuses rather than truncate when no rung fits, and names the cost", () => {
    // The backstop, reached through the exported ladder because a 40-capped first
    // name and a real site name can no longer get there through the public path.
    let thrown: unknown;
    try {
      chooseFallbackBody(["Hi Jane, ".padEnd(200, "x")], "sms");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutreachDraftTooLongError);
    const err = thrown as OutreachDraftTooLongError;
    expect(err.limit).toBe(160);
    expect(err.units).toBeGreaterThan(160);
    expect(err.message).toContain("refused rather than truncated");
  });

  it("caps the first name before it reaches a patient, and greets 'there' when there is no name", () => {
    const body = outreachFallbackBody(target({ name: "" }), campaign(), OUTREACH_CADENCE[0]);
    expect(body).toContain("Hi there,");
    expect(gsm7LengthUnits(body)).toBeLessThanOrEqual(160);
    const capped = outreachFallbackBody(
      target({ name: "B".repeat(90) }),
      campaign(),
      OUTREACH_CADENCE[0],
    );
    expect(capped).not.toContain("B".repeat(41));
    expect(gsm7LengthUnits(capped)).toBeLessThanOrEqual(160);
  });

  it("the SMS prompt states the character ceiling, not a word count", () => {
    const { system } = buildOutreachPrompt(target(), campaign(), "sms", OUTREACH_CADENCE[0], "a");
    // The literal, not `${OUTREACH_MAX_UNITS.sms}`: an assertion written off the
    // constant it is checking passes whatever the constant is changed to (W3/17).
    expect(OUTREACH_MAX_UNITS.sms).toBe(160);
    expect(system).toContain("at most 160 characters");
    expect(system).not.toContain("90 words");
    // The alphabet half of the same money rule: one curly apostrophe is UCS-2.
    expect(system).toContain("straight quotes");
    expect(system).toContain("no ellipsis character");
  });

  it("an over-long model draft is repaired in one turn and the repaired body is sent", async () => {
    const { client, create, sent } = scripted(
      NINETY_WORDS,
      "Hi Jane, we would love to see you for a hygiene visit. Reply and we will find you a time.",
    );
    const res = await draftOutreach(target(), campaign(), "sms", OUTREACH_CADENCE[0], client);
    expect(create).toHaveBeenCalledTimes(2);
    expect(res.usedFallback).toBe(false);
    expect(gsm7LengthUnits(res.body)).toBeLessThanOrEqual(160);
    // The repair turn carries the first draft and the real numbers, not a fresh prompt.
    const repairPrompt = JSON.stringify(sent[1]);
    expect(repairPrompt).toContain("The limit is 160");
    expect(repairPrompt).toContain("Rewrite the same message");
  });

  it("an over-long model draft that is still over after the repair turn uses the deterministic fallback", async () => {
    const { client, create } = scripted(NINETY_WORDS, NINETY_WORDS);
    const res = await draftOutreach(target(), campaign(), "sms", OUTREACH_CADENCE[0], client);
    expect(create).toHaveBeenCalledTimes(2);
    expect(res.usedFallback).toBe(true);
    expect(gsm7LengthUnits(res.body)).toBeLessThanOrEqual(160);
    expect(smsCost(res.body).segments).toBe(1);
  });

  it("a repaired draft is held to the SAME guardrail (NHS wording in the repair falls back)", async () => {
    const { client } = scripted(NINETY_WORDS, "Hi Jane, book your NHS hygiene visit. Reply to book.");
    const res = await draftOutreach(target(), campaign(), "sms", OUTREACH_CADENCE[0], client);
    expect(res.usedFallback).toBe(true);
    expect(res.body.toLowerCase()).not.toContain("nhs");
  });

  it("blocked copy is never given a repair turn (safety before cost)", async () => {
    // Over the ceiling AND unsafe: one model call, straight to the fallback.
    const { client, create } = scripted(`${NINETY_WORDS} Your NHS check up is due.`, "unused");
    const res = await draftOutreach(target(), campaign(), "sms", OUTREACH_CADENCE[0], client);
    expect(create).toHaveBeenCalledTimes(1);
    expect(res.usedFallback).toBe(true);
  });

  it("normalises our own typography so one curly apostrophe does not become three billed segments", async () => {
    // Long enough to cross the UCS-2 single-segment ceiling (70 units) but well
    // inside the GSM-7 one (160): the ONLY thing between one billed credit and two
    // here is the alphabet, which is the whole point.
    const curly =
      "Hi Jane, we’d love to welcome you back to the practice — " +
      "reply and we’ll find you a time that suits…";
    const { client } = scripted(curly);
    const res = await draftOutreach(target(), campaign(), "sms", OUTREACH_CADENCE[0], client);
    expect(res.usedFallback).toBe(false);
    expect(res.body).not.toMatch(/[‘’“”–—…]/);
    expect(res.body).toContain("we'd");
    expect(smsCost(res.body).encoding).toBe("gsm7");
    expect(smsCost(res.body).segments).toBe(1);
    // The unnormalised original really would have cost more: this is the saving.
    expect(smsCost(curly).encoding).toBe("ucs2");
    expect(smsCost(curly).segments).toBeGreaterThan(1);
  });

  it("never rewrites a letter: a name outside GSM 03.38 costs money and never costs the patient their message", () => {
    const body = outreachFallbackBody(
      target({ name: "Małgorzata Nowak" }),
      campaign(),
      OUTREACH_CADENCE[0],
    );
    expect(body).toContain("Małgorzata");
    // The LENGTH rule counts it as one unit, so she is still messaged; the COST
    // report is honest that it is UCS-2 and costs more.
    expect(gsm7LengthUnits(body)).toBeLessThanOrEqual(160);
    expect(smsCost(body).encoding).toBe("ucs2");
    expect(smsCost(body).forcedUcs2By).toBe("ł");
  });
});
