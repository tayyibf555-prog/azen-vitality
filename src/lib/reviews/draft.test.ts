import { describe, it, expect } from "vitest";
import { draftReviewRequest } from "./draft";

const LINK = "https://g.page/r/vitality-dental/review";

describe("draftReviewRequest", () => {
  it("leads with the patient's first name and names the practice", () => {
    const body = draftReviewRequest("Sam Lee", "Vitality Dental", LINK);
    expect(body.startsWith("Hi Sam,")).toBe(true);
    expect(body).toContain("Vitality Dental");
  });

  it("includes the Google review link verbatim", () => {
    const body = draftReviewRequest("Sam Lee", "Vitality Dental", LINK);
    expect(body).toContain(LINK);
  });

  it("falls back to a friendly greeting when the name is blank", () => {
    const body = draftReviewRequest("   ", "Vitality Dental", LINK);
    expect(body.startsWith("Hi there,")).toBe(true);
  });

  it("invites honest feedback and offers an easy opt-out", () => {
    const body = draftReviewRequest("Sam Lee", "Vitality Dental", LINK).toLowerCase();
    expect(body).toContain("honest feedback");
    expect(body).toContain("stop");
  });

  it("never offers an incentive for the review", () => {
    const body = draftReviewRequest("Sam Lee", "Vitality Dental", LINK).toLowerCase();
    for (const banned of ["discount", "voucher", "free", "off your", "reward", "prize", "entry", "£"]) {
      expect(body).not.toContain(banned);
    }
  });

  it("uses no em-dash and no NHS/private framing", () => {
    const body = draftReviewRequest("Sam Lee", "Vitality Dental", LINK).toLowerCase();
    expect(body).not.toContain("—"); // em-dash
    expect(body).not.toContain("nhs");
    expect(body).not.toContain("private");
  });
});
