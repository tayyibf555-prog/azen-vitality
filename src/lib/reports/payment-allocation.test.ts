import { describe, it, expect } from "vitest";
import {
  wiredAllocationConditions,
  unverifiedConditions,
  isPayable,
  ALLOCATION_CONDITION_LABELS,
  ALLOCATION_CONDITION_NOTES,
  type AllocationConditions,
} from "./payment-allocation";

describe("wiredAllocationConditions", () => {
  it("lifts invoiced and paid, keeps completed partial, and leaves closed unverified", () => {
    const c = wiredAllocationConditions();
    // `invoiced` is earned: the payment → explanation.invoice_id → invoice →
    // invoice_items[].practitioner_id chain is wired and resolved for 256/258
    // legs live on 2026-08-03. `paid` is earned: payments are the source of truth.
    expect(c.invoiced).toBe("verified");
    expect(c.paid).toBe("verified");
    // Completion is INFERRED from the invoice line, never read off the plan item.
    expect(c.completed).toBe("partial");
    // `closed` does not exist as a field on Dentally's API at all.
    expect(c.closed).toBe("unverified");
  });

  it("still marks nothing payable, because `closed` cannot be read", () => {
    expect(isPayable(wiredAllocationConditions())).toBe(false);
  });
});

/**
 * The notes are rendered verbatim on the Reports screen. They must state a
 * MEASURED fact and must say correctly whose limit it is: an earlier version
 * claimed Dentally could not supply the allocation link at all, which the
 * 2026-08-03 probes disproved, and a wrong "the supplier cannot do this" is worse
 * than a plain "we have not built this" because it closes the question. The
 * reverse error is now the live risk: `closed` genuinely IS absent from the API,
 * and softening that to "not yet calibrated" would hide the one thing that has to
 * be asked of a human before anyone is paid from this screen.
 */
describe("the condition notes state a measured fact, and whose limit it is", () => {
  it("says the allocation link is now READ, and names the measured chain rate", () => {
    const s = ALLOCATION_CONDITION_NOTES.invoiced;
    expect(s).toContain("explanations[]");
    expect(s).toContain("/v1/invoices/{id}");
    expect(s).toContain("99.2%");
    expect(s).toContain("256/258");
    expect(s).not.toContain("does not read it yet");
  });

  it("says plainly that Dentally exposes NO `closed` field, and that it blocks payment", () => {
    const s = ALLOCATION_CONDITION_NOTES.closed;
    expect(s).toContain("no `closed` field");
    expect(s).toContain("Completed but Not Closed");
    expect(s).toContain("probed 2026-08-03");
    expect(s).toContain("no line is ever payable");
    // The old, now-disproved framing said this was merely uncalibrated.
    expect(s).not.toContain("not yet calibrated");
  });

  it("says completion is INFERRED from the invoice line, not read", () => {
    const s = ALLOCATION_CONDITION_NOTES.completed;
    expect(s).toContain("inferred");
    expect(s).toContain("treatment_plan_item_id");
    expect(s).toContain("256/256");
  });

  it("says money received is the source of truth for `paid`", () => {
    const s = ALLOCATION_CONDITION_NOTES.paid;
    expect(s).toContain("source of truth");
    expect(s).toContain("refunds");
  });

  it("carries none of the disproved claims, in any note", () => {
    for (const s of Object.values(ALLOCATION_CONDITION_NOTES)) {
      expect(s).not.toContain("only exposes per patient");
      expect(s).not.toContain("No wired source");
      expect(s).not.toContain("No allocation link");
      expect(s).not.toContain("allocation link exists");
    }
  });

  it("never promises money owed, payable-in-full, or an NHS split", () => {
    for (const s of Object.values(ALLOCATION_CONDITION_NOTES)) {
      expect(s.toLowerCase()).not.toContain("amount owed");
      expect(s.toLowerCase()).not.toContain("nhs");
    }
  });
});

describe("unverifiedConditions", () => {
  it("lists exactly the conditions that are not fully verified", () => {
    const c = wiredAllocationConditions();
    expect(unverifiedConditions(c).sort()).toEqual(["closed", "completed"].sort());
  });
  it("is empty only when all four are verified", () => {
    const all: AllocationConditions = {
      completed: "verified",
      closed: "verified",
      invoiced: "verified",
      paid: "verified",
    };
    expect(unverifiedConditions(all)).toEqual([]);
  });
  it("has a human label for every condition", () => {
    for (const key of ["completed", "closed", "invoiced", "paid"] as const) {
      expect(ALLOCATION_CONDITION_LABELS[key]).toBeTruthy();
    }
  });
});

describe("isPayable — every single condition is load-bearing", () => {
  const allVerified: AllocationConditions = {
    completed: "verified",
    closed: "verified",
    invoiced: "verified",
    paid: "verified",
  };
  it("is true only when all four are verified", () => {
    expect(isPayable(allVerified)).toBe(true);
  });
  // If ANY one of the four is downgraded, the dentist is NOT confirmed payable.
  // This pins each gate individually so a future edit cannot quietly drop one
  // (e.g. paying on completed+closed+paid while the invoice is still unconfirmed).
  for (const key of ["completed", "closed", "invoiced", "paid"] as const) {
    it(`is false when only '${key}' is unverified`, () => {
      expect(isPayable({ ...allVerified, [key]: "unverified" })).toBe(false);
    });
    it(`is false when only '${key}' is partial`, () => {
      expect(isPayable({ ...allVerified, [key]: "partial" })).toBe(false);
    });
  }
});
