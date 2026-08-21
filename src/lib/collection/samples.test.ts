import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkCollectionDraft } from "./draft";
import { COLLECTION_CADENCE } from "./cadence";

// ===========================================================================
// WHAT THIS MODULE ACTUALLY SAYS TO A PATIENT.
//
// Three messages over a month, and then nothing, ever. These are the bodies the
// prompt asks for at each cadence step, held here as the worked example a person
// can read without running anything, and asserted against the real compliance
// scan so the example cannot quietly drift away from what the module will pass.
//
// Read them as the answer to one question: would a practice manager be happy for
// their own patient to receive this? Nothing here threatens, nothing hurries,
// nothing blames, nothing names a treatment, and every one of them offers the
// patient a way to say "I already paid" and be believed.
// ===========================================================================

const FIRST_NAME = "Amira";
const PRACTICE = "N15 Vitality Dental";
const LINK = "https://pay.example.com/vitality";

/** Step 1, email, day 0. The notice. */
export const SAMPLE_STEP_1 = `Hi ${FIRST_NAME},

I hope you are keeping well. I am just letting you know that there is an unpaid invoice on your account with us, reference INV-100200.

You can settle it whenever suits you here: ${LINK}

If you have already paid, or it looks wrong, just reply to this and we will check it for you.

Best wishes,
${PRACTICE}`;

/** Step 2, SMS, day 10. The offer of help, with no arrangement proposed. */
export const SAMPLE_STEP_2 =
  `Hi ${FIRST_NAME}, following up on the invoice on your account at ${PRACTICE}. ` +
  `If it would be easier to talk it through, or to sort something that suits you better, just say and we will help. ` +
  `If you have already paid, or it looks wrong, tell us and we will check. Settle it here: ${LINK}`;

/** Step 3, email, day 31. The close. */
export const SAMPLE_STEP_3 = `Hi ${FIRST_NAME},

This is the last message I will send about the invoice on your account. It simply stays there, and there is nothing you have to do today.

Whenever it suits you, you can settle it here: ${LINK}

And if you have already paid, or something about it looks wrong, do let us know and we will look into it.

Best wishes,
${PRACTICE}`;

/** Step 1 again, as it reads once COLLECTION_QUOTE_AMOUNT has been switched on
 *  (after one real invoice has been reconciled against Dentally's own screen). */
export const SAMPLE_WITH_FIGURE = `Hi ${FIRST_NAME},

I hope you are keeping well. There is an unpaid invoice of £180 on your account with us, reference INV-100200.

You can settle it whenever suits you here: ${LINK}

If you have already paid, or the amount looks wrong, just reply to this and we will check it for you.

Best wishes,
${PRACTICE}`;

const originalQuote = process.env.COLLECTION_QUOTE_AMOUNT;
beforeEach(() => {
  delete process.env.COLLECTION_QUOTE_AMOUNT;
});
afterEach(() => {
  if (originalQuote === undefined) delete process.env.COLLECTION_QUOTE_AMOUNT;
  else process.env.COLLECTION_QUOTE_AMOUNT = originalQuote;
});

describe("the messages this module sends", () => {
  it("step 1 (email, day 0) passes the scan", () => {
    expect(checkCollectionDraft(SAMPLE_STEP_1, { amountPounds: null, firstName: FIRST_NAME }, "email")).toEqual({
      ok: true,
    });
  });

  it("step 2 (SMS, day 10) passes the scan and fits an SMS", () => {
    expect(checkCollectionDraft(SAMPLE_STEP_2, { amountPounds: null, firstName: FIRST_NAME }, "sms")).toEqual({
      ok: true,
    });
    expect(SAMPLE_STEP_2.length).toBeLessThanOrEqual(480);
  });

  it("step 3 (email, day 31) passes the scan", () => {
    expect(checkCollectionDraft(SAMPLE_STEP_3, { amountPounds: null, firstName: FIRST_NAME }, "email")).toEqual({
      ok: true,
    });
  });

  it("the figure variant passes only against the figure it was written for", () => {
    expect(checkCollectionDraft(SAMPLE_WITH_FIGURE, { amountPounds: 180, firstName: FIRST_NAME }, "email")).toEqual({
      ok: true,
    });
    // ...and is refused outright while the figure is withheld, which is the state
    // the module ships in.
    const withheld = checkCollectionDraft(
      SAMPLE_WITH_FIGURE,
      { amountPounds: null, firstName: FIRST_NAME },
      "email",
    );
    expect(withheld).toEqual({ ok: false, category: "invented_figure", matched: "£180" });
  });

  it("every sample offers the patient a way to say the practice has it wrong", () => {
    for (const body of [SAMPLE_STEP_1, SAMPLE_STEP_2, SAMPLE_STEP_3, SAMPLE_WITH_FIGURE]) {
      expect(body).toMatch(/already paid/i);
    }
  });

  it("no sample names a treatment, a threat, a deadline or a consequence", () => {
    for (const body of [SAMPLE_STEP_1, SAMPLE_STEP_2, SAMPLE_STEP_3, SAMPLE_WITH_FIGURE]) {
      expect(body).not.toMatch(
        /debt|legal|court|credit rating|final notice|immediately|urgent|within \d+ days|failed to|overdue|arrears/i,
      );
    }
  });

  it("there are exactly three of them, and the cadence agrees", () => {
    expect(COLLECTION_CADENCE.map((s) => s.channel)).toEqual(["email", "sms", "email"]);
    expect(COLLECTION_CADENCE.map((s) => s.waitDays)).toEqual([0, 10, 21]);
  });
});
