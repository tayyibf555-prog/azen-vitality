import { describe, it, expect } from "vitest";
import {
  COLLECTION_DISCARD_EFFECT,
  COLLECTION_DISCARD_LABEL,
  COLLECTION_DISCARD_REASONS,
  TOO_SOON_COOL_OFF_HOURS,
  collectionDiscardOutcome,
  isCollectionDiscardReason,
} from "./discard";

const OPTS = { cooldownHours: 24 };

describe("what a human's discard reason MEANS", () => {
  it("'the wording is not right' is a retry, on the module's own cool-off", () => {
    expect(collectionDiscardOutcome("wrong_tone", OPTS)).toEqual({ kind: "retry", coolOffHours: 24 });
  });

  it("'not the right moment' pushes the next draft out three weeks, clear of the cadence's own gap", () => {
    // A day later is the same timing. On a money conversation "later" has to mean
    // genuinely later, past a pay cycle.
    expect(collectionDiscardOutcome("too_soon", OPTS)).toEqual({
      kind: "retry",
      coolOffHours: TOO_SOON_COOL_OFF_HOURS,
    });
    expect(TOO_SOON_COOL_OFF_HOURS).toBe(21 * 24);
  });

  it("'we have already spoken to them' records the same fact an inbound reply records", () => {
    expect(collectionDiscardOutcome("already_contacted", OPTS)).toEqual({
      kind: "stop",
      stopReason: "patient_replied",
      escalate: null,
    });
  });

  it("'the balance is wrong' STOPS and calls a person: it means the reads produced a figure nobody stands behind", () => {
    expect(collectionDiscardOutcome("balance_wrong", OPTS)).toEqual({
      kind: "stop",
      stopReason: "needs_a_person",
      escalate: "unreadable_invoice",
    });
  });

  it("'the patient is querying this' is a dispute arriving by the front desk", () => {
    expect(collectionDiscardOutcome("patient_disputing", OPTS)).toEqual({
      kind: "stop",
      stopReason: "dispute",
      escalate: "dispute",
    });
  });

  it("'do not chase' records staff_stopped, not a claim about the patient", () => {
    // `excluded` would claim their admin status excludes them and `opted_out` would
    // claim they asked us to stop. Both would be false in the record.
    expect(collectionDiscardOutcome("do_not_chase", OPTS)).toEqual({
      kind: "stop",
      stopReason: "staff_stopped",
      escalate: null,
    });
  });

  it("every reason has staff-facing wording and a stated effect", () => {
    for (const r of COLLECTION_DISCARD_REASONS) {
      expect(COLLECTION_DISCARD_LABEL[r]?.length ?? 0).toBeGreaterThan(0);
      expect(COLLECTION_DISCARD_EFFECT[r]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("narrows an unknown value from a request body", () => {
    expect(isCollectionDiscardReason("wrong_tone")).toBe(true);
    expect(isCollectionDiscardReason("because I said so")).toBe(false);
    expect(isCollectionDiscardReason(null)).toBe(false);
  });

  it("exactly two reasons summon a person, and they are the two about the money being wrong", () => {
    const escalating = COLLECTION_DISCARD_REASONS.filter((r) => {
      const o = collectionDiscardOutcome(r, OPTS);
      return o.kind === "stop" && o.escalate !== null;
    });
    expect([...escalating].sort()).toEqual(["balance_wrong", "patient_disputing"]);
  });
});
