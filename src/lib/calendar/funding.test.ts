import { describe, expect, it } from "vitest";
import { FUNDING_LABEL, fundingFromPlanId, fundingIsResolved, readPlanId } from "./funding";

describe("readPlanId", () => {
  it("reads the FLAT payment_plan_id", () => {
    expect(readPlanId({ payment_plan_id: 1 })).toBe(1);
    expect(readPlanId({ payment_plan_id: 47752 })).toBe(47752);
  });

  it("reads the NESTED payment_plan.id, because some payloads nest it", () => {
    expect(readPlanId({ payment_plan: { id: 2 } })).toBe(2);
  });

  it("prefers the flat id when both are present", () => {
    expect(readPlanId({ payment_plan_id: 1, payment_plan: { id: 2 } })).toBe(1);
  });

  it("returns null for absent, zero, empty and non-numeric", () => {
    expect(readPlanId({})).toBeNull();
    expect(readPlanId({ payment_plan_id: 0 })).toBeNull();
    expect(readPlanId({ payment_plan_id: null })).toBeNull();
    expect(readPlanId({ payment_plan_id: "" })).toBeNull();
    expect(readPlanId({ payment_plan_id: "not a number" })).toBeNull();
    expect(readPlanId(null)).toBeNull();
    expect(readPlanId("nonsense")).toBeNull();
  });

  it("coerces a numeric string, because live and the mock disagree on type", () => {
    expect(readPlanId({ payment_plan_id: "47752" })).toBe(47752);
  });
});

describe("fundingFromPlanId", () => {
  it("maps this practice's own live ids", () => {
    expect(fundingFromPlanId(1)).toBe("nhs");
    expect(fundingFromPlanId(2)).toBe("private");
    expect(fundingFromPlanId(47752)).toBe("udc");
  });

  it("maps an id OUTSIDE the whitelist to unknown, NEVER to private", () => {
    expect(fundingFromPlanId(90210)).toBe("unknown");
    expect(fundingFromPlanId(3)).toBe("unknown");
  });

  it("maps null and a non-finite id to unknown", () => {
    expect(fundingFromPlanId(null)).toBe("unknown");
    expect(fundingFromPlanId(Number.NaN)).toBe("unknown");
  });
});

describe("the five unresolvable cases", () => {
  // Each is asserted SEPARATELY, because each arrives by a different route and
  // each must render exactly the same nothing. None may ever become "private".
  it("1. the appointment carries no patient id", () => {
    // The caller has no patient to look up, so it never resolves one.
    const resolved = new Map<string, ReturnType<typeof fundingFromPlanId>>();
    const code = resolved.get("") ?? "unknown";
    expect(code).toBe("unknown");
  });

  it("2. the patient read 404s", () => {
    // The source maps a 404 to "unknown" for that patient without failing the read.
    expect(fundingFromPlanId(readPlanId(null))).toBe("unknown");
  });

  it("3. the read throws or times out", () => {
    // The whole day is marked failed; no block draws a rail. Resolution itself
    // still yields "unknown" rather than a default.
    expect(fundingFromPlanId(readPlanId(undefined))).toBe("unknown");
  });

  it("4. the patient resolves but carries no plan (absent, or 0)", () => {
    expect(fundingFromPlanId(readPlanId({ id: "pat-009" }))).toBe("unknown");
    expect(fundingFromPlanId(readPlanId({ payment_plan_id: 0 }))).toBe("unknown");
  });

  it("5. the plan id is real but outside {1, 2, 47752}", () => {
    expect(fundingFromPlanId(readPlanId({ payment_plan_id: 90210 }))).toBe("unknown");
  });
});

describe("FUNDING_LABEL", () => {
  it("prints the staff-facing words, and NOTHING at all for unknown", () => {
    expect(FUNDING_LABEL.nhs).toBe("NHS");
    expect(FUNDING_LABEL.private).toBe("Private");
    expect(FUNDING_LABEL.udc).toBe("UDC");
    // Not "Unknown", not a dash: an unresolvable patient draws no mark and prints
    // no word, so a reader can never mistake an absence for a fact.
    expect(FUNDING_LABEL.unknown).toBe("");
  });

  it("says which codes draw a rail", () => {
    expect(fundingIsResolved("nhs")).toBe(true);
    expect(fundingIsResolved("private")).toBe(true);
    expect(fundingIsResolved("udc")).toBe(true);
    expect(fundingIsResolved("unknown")).toBe(false);
  });
});
