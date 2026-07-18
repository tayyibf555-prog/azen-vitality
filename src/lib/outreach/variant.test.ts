// Deterministic A/B variant assignment: the same patient always resolves to the same
// variant, a set of patients splits roughly evenly, and a single-angle campaign puts
// everyone on 'a'. Pure function, so no mocks.
import { describe, it, expect } from "vitest";
import { assignVariant } from "./variant";

describe("assignVariant", () => {
  it("returns 'a' for everyone when the campaign has no second angle", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(assignVariant("camp-1", `patient-${i}`, false)).toBe("a");
    }
  });

  it("is deterministic: the same campaign+patient always yields the same variant", () => {
    for (let i = 0; i < 200; i += 1) {
      const first = assignVariant("camp-1", `patient-${i}`, true);
      // Re-resolving (cadence step 2, 3, or a re-run of the sweep) must never move it.
      expect(assignVariant("camp-1", `patient-${i}`, true)).toBe(first);
      expect(assignVariant("camp-1", `patient-${i}`, true)).toBe(first);
    }
  });

  it("splits a cohort roughly evenly between 'a' and 'b'", () => {
    const N = 2000;
    let a = 0;
    let b = 0;
    for (let i = 0; i < N; i += 1) {
      if (assignVariant("camp-42", `pt-${i}`, true) === "a") a += 1;
      else b += 1;
    }
    expect(a + b).toBe(N);
    // A uniform hash lands each arm comfortably inside 40-60% on 2,000 patients.
    expect(a / N).toBeGreaterThan(0.4);
    expect(a / N).toBeLessThan(0.6);
    expect(b / N).toBeGreaterThan(0.4);
    expect(b / N).toBeLessThan(0.6);
  });

  it("varies the split by campaign, so the same patient can differ across campaigns", () => {
    // The hash keys on campaign id too, so a patient is not pinned to one arm globally.
    const perCampaign = ["c1", "c2", "c3", "c4"].map((c) => assignVariant(c, "patient-shared", true));
    expect(new Set(perCampaign).size).toBeGreaterThan(1);
  });

  it("only ever returns 'a' or 'b'", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(["a", "b"]).toContain(assignVariant("c", `p-${i}`, true));
    }
  });
});
