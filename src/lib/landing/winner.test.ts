import { describe, it, expect } from "vitest";
import { decideAutoPromotion, MIN_VIEWS } from "./winner";

describe("decideAutoPromotion", () => {
  it("does not promote until BOTH variants have a fair sample", () => {
    const d = decideAutoPromotion({
      a: { views: MIN_VIEWS - 1, ctaClicks: 20, leads: 5 },
      b: { views: 200, ctaClicks: 5, leads: 1 },
    });
    expect(d.promote).toBe(false);
    expect(d.winner).toBeNull();
    expect(d.reason).toMatch(/views/);
  });

  it("promotes on lead rate when leads are plentiful and the lift is >= 25%", () => {
    const d = decideAutoPromotion({
      a: { views: 1000, ctaClicks: 200, leads: 100 }, // 10% lead rate
      b: { views: 1000, ctaClicks: 150, leads: 70 }, //  7% lead rate -> ~43% relative lift
    });
    expect(d.promote).toBe(true);
    expect(d.winner).toBe("a");
    expect(d.metric).toBe("lead-rate");
  });

  it("does NOT promote when the two rates are within 25% relative", () => {
    const d = decideAutoPromotion({
      a: { views: 1000, ctaClicks: 200, leads: 100 }, // 10%
      b: { views: 1000, ctaClicks: 190, leads: 90 }, //  9% -> ~11% lift, too close
    });
    expect(d.promote).toBe(false);
  });

  it("falls back to CTA rate when leads are sparse", () => {
    const d = decideAutoPromotion({
      a: { views: 500, ctaClicks: 100, leads: 2 }, // 20% cta rate
      b: { views: 500, ctaClicks: 50, leads: 1 }, // 10% cta rate -> 100% lift
    });
    expect(d.promote).toBe(true);
    expect(d.metric).toBe("cta-rate");
    expect(d.winner).toBe("a");
  });

  it("does not promote when neither variant converts", () => {
    const d = decideAutoPromotion({
      a: { views: 300, ctaClicks: 0, leads: 0 },
      b: { views: 300, ctaClicks: 0, leads: 0 },
    });
    expect(d.promote).toBe(false);
    expect(d.winner).toBeNull();
  });

  it("treats a zero-rate loser as a clear win for the other (no divide by zero)", () => {
    const d = decideAutoPromotion({
      a: { views: 200, ctaClicks: 40, leads: 0 },
      b: { views: 200, ctaClicks: 0, leads: 0 },
    });
    expect(d.promote).toBe(true);
    expect(d.winner).toBe("a");
  });
});
