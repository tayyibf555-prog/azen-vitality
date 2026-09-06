// THE SEND-SIDE CEILING ON A RECALL MESSAGE.
//
// Before this suite existed, nothing anywhere in the tree measured the length or
// the alphabet of a composed patient SMS: the drafters stated their length as a
// prompt line ("Under 90 words"), the drain's universal backstop checked funding
// jargon, clinical advice and prices, and the Twilio provider posted whatever
// string it was handed. Recall is the highest-volume send surface there is, so
// the rule lands here first and the numbers below are the ones on the client's
// own invoice: Twilio bills per 160-character segment, Dentally billed per
// message, and the break-even the practice was shown is 1.69 segments.
//
// Every test names the rule it pins, because each one is meant to be the red
// test when that rule is broken.

import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  RECALL_MAX_UNITS,
  RecallDraftTooLongError,
  measureRecallBody,
  normaliseGsm7Typography,
} from "./sms-budget";
import { buildRecallPrompt, draftRecall } from "./draft";
import { RECALL_CADENCE } from "./cadence";
import type { RecallTarget } from "./types";
import type { TouchChannel } from "@/lib/reactivation/types";

vi.mock("@/lib/mock/clients", () => ({ getSite: () => ({ clientId: "vitality" }) }));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: async () => ["Award-winning care"] }));

function target(p: Partial<RecallTarget> = {}): RecallTarget {
  return {
    id: "site-cc:123:dentist",
    siteId: "site-cc",
    dentallyPatientId: "123",
    patientName: "Sarah Lindqvist",
    recallType: "dentist",
    dueAt: "2026-06-25T00:00:00Z",
    overdueDays: 3,
    lastVisitAt: "2026-01-10T00:00:00Z",
    priorAttempts: 0,
    status: "due",
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: "x",
    ...p,
  };
}

interface CreateArgs {
  system: string;
  messages: Array<{ role: string; content: string }>;
}

/**
 * A model that answers with the given bodies: the first for the opening turn,
 * the second for the repair turn. It picks by the SHAPE of the conversation it
 * is handed (one message = the first ask, three = the repair), so a test that
 * expected a repair and did not get one fails on the body rather than quietly
 * receiving the right answer for the wrong reason.
 */
function fakeClient(...replies: string[]) {
  const create = vi.fn(async (args: CreateArgs) => ({
    content: [
      { type: "text", text: replies[Math.min(args.messages.length > 1 ? 1 : 0, replies.length - 1)] },
    ],
  }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

// ---------------------------------------------------------------------------
// The measure.
// ---------------------------------------------------------------------------

describe("the recall SMS ceiling is one GSM-7 credit", () => {
  it("caps an SMS at 160 septets and lets 160 through", () => {
    expect(RECALL_MAX_UNITS.sms).toBe(160);
    const exactly160 = "a".repeat(160);
    const measured = measureRecallBody(exactly160, "sms");
    expect(measured.ok).toBe(true);
    expect(measured.units).toBe(160);
    // The ceiling exists because of what it costs: 160 septets is ONE billed
    // message, which is the whole of the saving against a flat per-message bill.
    expect(measured.segments).toBe(1);
  });

  it("refuses a body one character over the ceiling", () => {
    const measured = measureRecallBody("a".repeat(161), "sms");
    expect(measured.ok).toBe(false);
    expect(measured.units).toBe(161);
    expect(measured.limit).toBe(160);
    // And it really is two messages on the bill, not a rounding argument.
    expect(measured.segments).toBe(2);
  });

  it("charges an escape-table character two septets, so 160 characters can still be over", () => {
    // 159 plain characters plus one "[" is 160 characters and 161 septets. A
    // ceiling written in body.length would have called this one credit.
    const body = `${"a".repeat(159)}[`;
    expect(body.length).toBe(160);
    const measured = measureRecallBody(body, "sms");
    expect(measured.units).toBe(161);
    expect(measured.ok).toBe(false);
  });

  it("keeps a separate ceiling for the channels that are not billed per segment", () => {
    expect(RECALL_MAX_UNITS.email).toBe(1400);
    expect(RECALL_MAX_UNITS.whatsapp).toBe(480);
    // The same body is over the SMS ceiling and inside the email one.
    const body = "a".repeat(300);
    expect(measureRecallBody(body, "sms").ok).toBe(false);
    expect(measureRecallBody(body, "email").ok).toBe(true);
    expect(measureRecallBody(body, "whatsapp").ok).toBe(true);
  });

  it("reports the character that forced UCS-2 rather than leaving the cost a mystery", () => {
    const measured = measureRecallBody("Hi Małgorzata, your checkup is due.", "sms");
    expect(measured.encoding).toBe("ucs2");
    expect(measured.forcedUcs2By).toBe("ł");
  });
});

// ---------------------------------------------------------------------------
// The typography pass.
// ---------------------------------------------------------------------------

describe("our own punctuation is rewritten into the GSM alphabet", () => {
  it("rewrites curly quotes, dashes, the ellipsis and the invisible spaces", () => {
    // Written as escapes on purpose: a raw zero-width space or no-break space in
    // this file would be exactly the invisible character src/lib/source-hygiene
    // .test.ts exists to keep out of the tree, and a reader has to be able to SEE
    // what is being tested. Curly quotes, an em dash, an ellipsis, a no-break
    // space and a zero-width space: the five a model actually emits.
    const modelish =
      "Hi Sarah, we\u2019ll see you soon \u2014 it\u2019s time\u2026 \u201Cbook now\u201D\u00A0please\u200B";
    const out = normaliseGsm7Typography(modelish);
    expect(out).toBe("Hi Sarah, we'll see you soon - it's time... \"book now\" please");
    // Which is the point: the same sentence is now one billed segment, not three.
    expect(measureRecallBody(modelish, "sms").encoding).toBe("ucs2");
    expect(measureRecallBody(out, "sms").encoding).toBe("gsm7");
  });

  it("never rewrites a letter in a patient's name", () => {
    // A patient is never left unmessaged, nor renamed, because of how their name
    // is spelled: the pass touches punctuation only, and the LENGTH rule counts
    // the letter once so a short message still sends.
    const body = "Hi Małgorzata, your checkup is due. Call us to book.";
    const out = normaliseGsm7Typography(body);
    expect(out).toBe(body);
    expect(measureRecallBody(out, "sms").ok).toBe(true);
  });

  it("is idempotent", () => {
    const once = normaliseGsm7Typography("we\u2019ll \u2014 soon\u2026");
    expect(normaliseGsm7Typography(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// The prompt states the budget in the unit the channel is billed in.
// ---------------------------------------------------------------------------

describe("the recall prompt asks for a character budget, not a word count", () => {
  it("gives every SMS step the 160-character budget and no word count", () => {
    for (const step of RECALL_CADENCE.filter((s) => s.channel === "sms")) {
      const { system } = buildRecallPrompt(target(), "sms", step);
      expect(system).toContain("at most 160 characters");
      expect(system).not.toContain("90 words");
    }
  });

  it("leaves the email step its word count, which is not billed per segment", () => {
    const emailStep = RECALL_CADENCE.find((s) => s.channel === "email")!;
    const { system } = buildRecallPrompt(target(), "email", emailStep);
    expect(system).toContain("Under 90 words");
  });

  it("forbids the punctuation that would force UCS-2", () => {
    const { system } = buildRecallPrompt(target(), "sms", RECALL_CADENCE[0]);
    expect(system.toLowerCase()).toContain("straight quotes");
    expect(system.toLowerCase()).toContain("no ellipsis character");
  });
});

// ---------------------------------------------------------------------------
// The drafter enforces it.
// ---------------------------------------------------------------------------

describe("draftRecall bounds the body it hands back", () => {
  it("returns a compliant draft in one model call", async () => {
    const { client, create } = fakeClient("Hi Sarah, your dental checkup is due. Call us to book a time that suits you.");
    const { body } = await draftRecall(target(), "sms", RECALL_CADENCE[0], client);
    expect(create).toHaveBeenCalledOnce();
    expect(body).toBe("Hi Sarah, your dental checkup is due. Call us to book a time that suits you.");
  });

  it("strips the model's curly apostrophe before the body can be queued", async () => {
    const { client } = fakeClient("Hi Sarah, we\u2019ll see you soon. Call us to book.");
    const { body } = await draftRecall(target(), "sms", RECALL_CADENCE[0], client);
    expect(body).toBe("Hi Sarah, we'll see you soon. Call us to book.");
    expect(measureRecallBody(body, "sms").encoding).toBe("gsm7");
  });

  it("repairs an over-long SMS draft in one more turn and returns the repaired body", async () => {
    const tooLong = `Hi Sarah, ${"your dental checkup with us is now due and we would love to see you. ".repeat(4)}`;
    const short = "Hi Sarah, your dental checkup is due. Call us to book.";
    const { client, create } = fakeClient(tooLong, short);
    const { body } = await draftRecall(target(), "sms", RECALL_CADENCE[0], client);
    expect(create).toHaveBeenCalledTimes(2);
    expect(body).toBe(short);
    // The repair turn shows the model its own draft and the real numbers.
    const second = create.mock.calls[1][0];
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[2].content).toContain("The limit is 160");
  });

  it("refuses rather than truncates when the repair is still over budget", async () => {
    const tooLong = `Hi Sarah, ${"your dental checkup with us is now due and we would love to see you. ".repeat(4)}`;
    const { client, create } = fakeClient(tooLong, tooLong);
    await expect(draftRecall(target(), "sms", RECALL_CADENCE[0], client)).rejects.toBeInstanceOf(
      RecallDraftTooLongError,
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("applies the channel's own ceiling, so the same body passes as an email", async () => {
    const body300 = `Hi Sarah, ${"your dental checkup with us is now due and we would love to see you. ".repeat(4)}`;
    const emailStep = RECALL_CADENCE.find((s) => s.channel === "email")!;
    const { client, create } = fakeClient(body300);
    const { body } = await draftRecall(target(), "email", emailStep, client);
    expect(create).toHaveBeenCalledOnce();
    expect(body.length).toBeGreaterThan(RECALL_MAX_UNITS.sms);
  });
});

// ---------------------------------------------------------------------------
// The whole cadence, at the length a real recall message is written at.
// ---------------------------------------------------------------------------

describe("every SMS the recall cadence can send is one billed segment", () => {
  const channels: TouchChannel[] = ["sms", "whatsapp"];
  for (const channel of channels) {
    it(`a ${channel} body at the ceiling costs one segment`, () => {
      const measured = measureRecallBody("a".repeat(RECALL_MAX_UNITS.sms), channel);
      expect(measured.segments).toBe(1);
      expect(measured.ok).toBe(true);
    });
  }
});
