import { describe, it, expect } from "vitest";
import { resultCopy } from "./result-copy";

// H1: a MEDIUM-band (and any not-actually-contacted) patient must never be told
// someone will reach out, because nobody does, only a HIGH band, fast-tracked
// submission is ever contacted. These tests pin that contract at the copy layer
// so a future change cannot silently reintroduce the broken promise.

const FORBIDDEN_PROMISE = [
  /reach out/i,
  /be in touch/i,
  /get back to you/i,
  /call you/i,
  /contact you/i,
  /team member will/i,
];

function assertNoContactPromise(text: string): void {
  for (const re of FORBIDDEN_PROMISE) {
    expect(re.test(text), `"${text}" wrongly promises contact (matched ${re})`).toBe(false);
  }
}

describe("resultCopy", () => {
  it("medium band never promises contact, and points to a concrete next step", () => {
    const withBooking = resultCopy("medium", false, true);
    assertNoContactPromise(withBooking);
    expect(withBooking.toLowerCase()).toContain("book");

    const withoutBooking = resultCopy("medium", false, false);
    assertNoContactPromise(withoutBooking);
    expect(withoutBooking.toLowerCase()).toContain("practice");
  });

  it("low band never promises contact, and points to a concrete next step", () => {
    const withBooking = resultCopy("low", false, true);
    assertNoContactPromise(withBooking);
    expect(withBooking.toLowerCase()).toContain("book");

    const withoutBooking = resultCopy("low", false, false);
    assertNoContactPromise(withoutBooking);
    expect(withoutBooking.toLowerCase()).toContain("practice");
  });

  it("high band only promises contact when a lead was actually created", () => {
    const contacted = resultCopy("high", true, true);
    expect(/be in touch/i.test(contacted)).toBe(true);

    // A HIGH score that was NOT fast-tracked (e.g. an untrusted submit) must read
    // exactly like a MEDIUM result, not promise a callback that will not happen.
    const notContacted = resultCopy("high", false, true);
    assertNoContactPromise(notContacted);
    expect(notContacted).toBe(resultCopy("medium", false, true));
  });

  it("never contains forbidden funding jargon or an em/en dash", () => {
    const bands: Array<"high" | "medium" | "low"> = ["high", "medium", "low"];
    for (const band of bands) {
      for (const leadCreated of [true, false]) {
        for (const hasBookingUrl of [true, false]) {
          const text = resultCopy(band, leadCreated, hasBookingUrl);
          expect(text).not.toMatch(/\bNHS\b/i);
          expect(text).not.toMatch(/\bprivate\b/i);
          expect(text).not.toMatch(/\bprivately\b/i);
          expect(text).not.toMatch(/[\u2014\u2013]/); // en dash / em dash
        }
      }
    }
  });
});
