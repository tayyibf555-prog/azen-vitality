import { describe, it, expect } from "vitest";
import { decideAutoPromotion, MIN_VIEWS } from "./winner";

describe("decideAutoPromotion", () => {
  it("does not promote until BOTH variants have a fair sample", () => {
    const d = decideAutoPromotion({
      a: { views: MIN_VIEWS - 1, ctaClicks: 20, leads: 5 }, // just under the floor
      b: { views: 1000, ctaClicks: 5, leads: 1 }, // fair sample, but A drags the pair down
    });
    expect(d.promote).toBe(false);
    expect(d.winner).toBeNull();
    expect(d.reason).toMatch(/views/);
  });

  it("does not promote at 100 views, below the raised 800 floor", () => {
    // Strong, lopsided rates the OLD 100-view floor would have promoted on: 20% vs
    // 5% lead rate over 25 combined leads. The 800 floor now blocks it as noise.
    const d = decideAutoPromotion({
      a: { views: 100, ctaClicks: 40, leads: 20 },
      b: { views: 100, ctaClicks: 10, leads: 5 },
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

  it("falls back to CTA rate when leads are sparse (still above the 800-view floor)", () => {
    const d = decideAutoPromotion({
      a: { views: 1000, ctaClicks: 200, leads: 2 }, // 20% cta rate
      b: { views: 1000, ctaClicks: 100, leads: 1 }, // 10% cta rate -> 100% lift
    });
    expect(d.promote).toBe(true);
    expect(d.metric).toBe("cta-rate");
    expect(d.winner).toBe("a");
  });

  it("stays on CTA rate until there are 20 combined leads", () => {
    // 18 combined leads is below the 20-lead floor, so the call uses CTA rate; the
    // OLD 10-lead floor would have judged this on lead rate instead.
    const d = decideAutoPromotion({
      a: { views: 1000, ctaClicks: 300, leads: 12 }, // 30% cta rate
      b: { views: 1000, ctaClicks: 150, leads: 6 }, //  15% cta rate -> 100% lift
    });
    expect(d.promote).toBe(true);
    expect(d.metric).toBe("cta-rate");
    expect(d.winner).toBe("a");
  });

  it("does not promote when neither variant converts", () => {
    // Above the 800-view floor so this exercises the zero-rate branch, not the sample gate.
    const d = decideAutoPromotion({
      a: { views: 900, ctaClicks: 0, leads: 0 },
      b: { views: 900, ctaClicks: 0, leads: 0 },
    });
    expect(d.promote).toBe(false);
    expect(d.winner).toBeNull();
  });

  it("treats a zero-rate loser as a clear win for the other (no divide by zero)", () => {
    const d = decideAutoPromotion({
      a: { views: 900, ctaClicks: 40, leads: 0 },
      b: { views: 900, ctaClicks: 0, leads: 0 },
    });
    expect(d.promote).toBe(true);
    expect(d.winner).toBe("a");
  });
});
