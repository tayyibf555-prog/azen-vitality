import { describe, it, expect } from "vitest";
import { ROI_SUMMARY, CHANNELS, topChannelByRoi, topChannelByRevenue } from "./mock";
import { ACCOUNT_SUMMARY } from "@/lib/meta-ads/mock";

function sum(pick: (n: number) => number, values: number[]): number {
  return values.reduce((total, v) => total + pick(v), 0);
}

describe("ROI summary totals roll up from the channels", () => {
  it("channel spend sums to the summary spend", () => {
    const total = CHANNELS.reduce((s, c) => s + c.spendGbp, 0);
    expect(total).toBe(ROI_SUMMARY.spendGbp);
  });

  it("channel leads sum to the summary leads", () => {
    const total = CHANNELS.reduce((s, c) => s + c.leads, 0);
    expect(total).toBe(ROI_SUMMARY.leads);
  });

  it("channel new patients sum to the summary new patients", () => {
    const total = CHANNELS.reduce((s, c) => s + c.newPatients, 0);
    expect(total).toBe(ROI_SUMMARY.newPatients);
  });

  it("channel revenue sums to the summary revenue", () => {
    const total = CHANNELS.reduce((s, c) => s + c.revenueGbp, 0);
    expect(total).toBe(ROI_SUMMARY.revenueGbp);
  });
});

describe("per-channel derived fields are consistent and never divide by zero", () => {
  for (const c of CHANNELS) {
    it(`${c.name}: cpa, cpl and roi match spend / counts`, () => {
      if (c.spendGbp === 0) {
        // Zero-spend channels carry zero costs and a null ROI (rendered "-").
        expect(c.cplGbp).toBe(0);
        expect(c.cpaGbp).toBe(0);
        expect(c.roiX).toBeNull();
      } else {
        expect(c.cplGbp).toBeCloseTo(c.spendGbp / c.leads, 2);
        expect(c.cpaGbp).toBeCloseTo(c.spendGbp / c.newPatients, 2);
        expect(c.roiX).not.toBeNull();
        expect(c.roiX as number).toBeCloseTo(c.revenueGbp / c.spendGbp, 2);
      }
    });
  }

  it("no channel produces a non-finite derived value", () => {
    for (const c of CHANNELS) {
      expect(Number.isFinite(c.cplGbp)).toBe(true);
      expect(Number.isFinite(c.cpaGbp)).toBe(true);
      if (c.roiX !== null) expect(Number.isFinite(c.roiX)).toBe(true);
    }
  });
});

describe("summary-level derived fields", () => {
  it("cost per acquisition = spend / new patients", () => {
    expect(ROI_SUMMARY.costPerAcquisitionGbp).toBeCloseTo(
      ROI_SUMMARY.spendGbp / ROI_SUMMARY.newPatients,
      2,
    );
  });

  it("return = revenue / spend", () => {
    expect(ROI_SUMMARY.returnX).toBeCloseTo(ROI_SUMMARY.revenueGbp / ROI_SUMMARY.spendGbp, 2);
  });
});

describe("Meta Ads channel reuses the platform ad-spend figure", () => {
  it("matches ACCOUNT_SUMMARY spend and leads exactly", () => {
    const meta = CHANNELS.find((c) => c.id === "meta-ads");
    expect(meta).toBeDefined();
    expect(meta?.spendGbp).toBe(ACCOUNT_SUMMARY.spendGbp);
    expect(meta?.leads).toBe(ACCOUNT_SUMMARY.leads);
  });
});

describe("acquisition funnel is consistent with the totals", () => {
  it("starts at total leads and ends at total new patients", () => {
    const first = ROI_SUMMARY.funnel[0];
    const last = ROI_SUMMARY.funnel[ROI_SUMMARY.funnel.length - 1];
    expect(first.count).toBe(ROI_SUMMARY.leads);
    expect(last.count).toBe(ROI_SUMMARY.newPatients);
  });

  it("never grows from one stage to the next", () => {
    for (let i = 1; i < ROI_SUMMARY.funnel.length; i++) {
      expect(ROI_SUMMARY.funnel[i].count).toBeLessThanOrEqual(ROI_SUMMARY.funnel[i - 1].count);
    }
  });

  it("conversionFromPrev matches the count ratio for each later stage", () => {
    for (let i = 1; i < ROI_SUMMARY.funnel.length; i++) {
      const ratio = ROI_SUMMARY.funnel[i].count / ROI_SUMMARY.funnel[i - 1].count;
      expect(ROI_SUMMARY.funnel[i].conversionFromPrev).toBeCloseTo(ratio, 2);
    }
    // The first stage has nothing before it.
    expect(ROI_SUMMARY.funnel[0].conversionFromPrev).toBe(1);
  });
});

describe("trend ends on the current period and grows", () => {
  it("last point matches the summary figures", () => {
    const last = ROI_SUMMARY.trend[ROI_SUMMARY.trend.length - 1];
    expect(last.spendGbp).toBe(ROI_SUMMARY.spendGbp);
    expect(last.revenueGbp).toBe(ROI_SUMMARY.revenueGbp);
    expect(last.newPatients).toBe(ROI_SUMMARY.newPatients);
  });

  it("new patients trend upward month on month", () => {
    for (let i = 1; i < ROI_SUMMARY.trend.length; i++) {
      expect(ROI_SUMMARY.trend[i].newPatients).toBeGreaterThanOrEqual(
        ROI_SUMMARY.trend[i - 1].newPatients,
      );
    }
  });
});

describe("selectors", () => {
  it("topChannelByRoi ignores zero-spend (null ROI) channels", () => {
    const top = topChannelByRoi();
    expect(top).not.toBeNull();
    expect(top?.roiX).not.toBeNull();
    // Meta Ads (8200 / 1907 = 4.3x) beats the only other spending channel,
    // smile assessment (1750 / 120 = 14.58x)... so smile assessment wins.
    expect(top?.id).toBe("smile-assessment");
  });

  it("topChannelByRevenue picks the biggest revenue contributor", () => {
    const top = topChannelByRevenue();
    expect(top?.id).toBe("meta-ads");
  });
});
