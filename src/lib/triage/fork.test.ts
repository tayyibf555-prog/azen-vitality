import { describe, it, expect } from "vitest";
import { FORK_LABEL, FORK_NOTE, forkForPaymentPlan } from "./fork";
import { PAYMENT_PLANS } from "@/lib/patient/profile";
import { TRIAGE_FORKS } from "./types";
import { FORBIDDEN_PATIENT_WORDS } from "./forbidden";

// ===========================================================================
// THE FORK. Two rules, and the second is the one that matters most.
//
//   1. It fails to the SHORT list for everything it cannot prove is private.
//   2. Nothing it produces — value, label or note — ever names a funding regime.
// ===========================================================================

/** The practice's live plan ids, read from the shared list rather than retyped. */
const PLAN_ID = Object.fromEntries(PAYMENT_PLANS.map((p) => [p.label.toLowerCase(), p.id])) as Record<
  string,
  number
>;

describe("forkForPaymentPlan", () => {
  it("gives the FULL list only to a proven private plan", () => {
    expect(PLAN_ID.private).toBeTypeOf("number");
    expect(forkForPaymentPlan(PLAN_ID.private)).toBe("full");
  });

  // THE LOAD-BEARING TEST. Every one of these must land on the short list, and
  // each is a different way of not being private.
  it.each([
    ["the NHS plan", () => PLAN_ID.nhs],
    ["the practice's UDC plan (37% of recent registrations, and it is NHS urgent care)", () => PLAN_ID.udc],
  ])("fails safe for %s", (_label, id) => {
    expect(forkForPaymentPlan(id())).toBe("brief");
  });

  it("fails safe for an UNKNOWN plan id rather than rounding it up to private", () => {
    // A plan outside this practice's live whitelist is a plan we cannot name, and
    // a plan we cannot name is not one we may assume is private. Getting this
    // wrong commits the practice to treatment it did not price.
    expect(forkForPaymentPlan(90210)).toBe("brief");
    expect(forkForPaymentPlan(3)).toBe("brief");
    expect(forkForPaymentPlan(0)).toBe("brief");
    expect(forkForPaymentPlan(-1)).toBe("brief");
  });

  it("fails safe when there is no plan on file at all", () => {
    expect(forkForPaymentPlan(null)).toBe("brief");
    expect(forkForPaymentPlan(undefined)).toBe("brief");
    expect(forkForPaymentPlan(Number.NaN)).toBe("brief");
  });

  it("is total: every input produces one of the two forks and never throws", () => {
    for (const value of [1, 2, 47752, 0, -5, 1e12, Number.NaN, null, undefined]) {
      expect(TRIAGE_FORKS).toContain(forkForPaymentPlan(value as number | null));
    }
  });
});

describe("the fork never leaks a funding word", () => {
  // THE RULE, PINNED WHERE IT IS DECIDED. The fork VALUES are what get persisted,
  // projected into the public payload's shape and rendered on staff screens. If
  // they were "nhs"/"private" a funding word would be one careless serialisation
  // away from a patient's browser.
  it("the fork values themselves are not funding words", () => {
    expect([...TRIAGE_FORKS].sort()).toEqual(["brief", "full"]);
    for (const fork of TRIAGE_FORKS) {
      for (const re of FORBIDDEN_PATIENT_WORDS) {
        expect(re.test(fork), `the fork value "${fork}" matches ${re}`).toBe(false);
      }
    }
  });

  it("the staff-facing labels and notes name no funding regime either", () => {
    // Staff screens ARE allowed to say NHS and private (the diary's funding rail
    // does). These do not, for a different reason: "brief" is not "NHS" — it is
    // also every UDC patient, every unknown plan and every patient with no plan on
    // file — so a label saying NHS would be a lie by rounding.
    for (const fork of TRIAGE_FORKS) {
      for (const text of [FORK_LABEL[fork], FORK_NOTE[fork]]) {
        expect(text.length).toBeGreaterThan(0);
        for (const re of FORBIDDEN_PATIENT_WORDS) {
          expect(re.test(text), `"${text}" matches ${re}`).toBe(false);
        }
      }
    }
  });

  it("the short list's note says what was NOT asked, so a clinician is not misled", () => {
    // A clinician reading a short summary must know the patient was not asked
    // about pain, rather than concluding that they were asked and had nothing to
    // report. Those are different clinical facts.
    expect(FORK_NOTE.brief).toMatch(/not asked about pain or symptoms/i);
  });
});
