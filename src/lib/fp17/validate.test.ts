import { describe, it, expect } from "vitest";
import { validateFp17Declaration, type Fp17ValidateInput } from "./validate";

// The validator is the second legal guard (after the catalogue). These tests
// MUTATION-CHECK it: for each required rule there is a case that flips exactly that
// field and asserts the rejection, so a mutant that drops the check turns a test red.

/** A complete, valid EXEMPTION submission. Each test overrides one field. */
function validExemption(over: Partial<Fp17ValidateInput> = {}): Fp17ValidateInput {
  return {
    exemptionCategory: "under-18",
    evidenceAck: true,
    declarationTruth: true,
    consentTreatment: true,
    consentDataShare: false,
    signatureMethod: "typed",
    signatureValue: "Jane Smith",
    patientName: "Jane Smith",
    dateOfBirth: "2010-05-02",
    ...over,
  };
}

/** A complete, valid PAYING submission (no exemption, so no evidence needed). */
function validPaying(over: Partial<Fp17ValidateInput> = {}): Fp17ValidateInput {
  return {
    exemptionCategory: "paying",
    declarationTruth: true,
    consentTreatment: true,
    signatureMethod: "typed",
    signatureValue: "John Doe",
    ...over,
  };
}

describe("validateFp17Declaration — happy paths", () => {
  it("accepts a complete exemption claim and normalises it", () => {
    const r = validateFp17Declaration(validExemption());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exemptionCategory).toBe("under-18");
    expect(r.value.isExemption).toBe(true);
    expect(r.value.evidenceAck).toBe(true);
    expect(r.value.declarationTruth).toBe(true);
    expect(r.value.consent).toEqual({ treatment: true, dataShare: false });
    expect(r.value.signature).toEqual({ method: "typed", value: "Jane Smith" });
    expect(r.value.patientName).toBe("Jane Smith");
  });

  it("accepts a 'paying' opt-out WITHOUT an evidence acknowledgement", () => {
    const r = validateFp17Declaration(validPaying({ evidenceAck: false }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exemptionCategory).toBe("paying");
    expect(r.value.isExemption).toBe(false);
    // Nothing to prove, so the ack is stored false regardless of what was sent.
    expect(r.value.evidenceAck).toBe(false);
  });

  it("accepts a drawn signature within the image size cap", () => {
    const dataUrl = "data:image/png;base64," + "A".repeat(1000);
    const r = validateFp17Declaration(validExemption({ signatureMethod: "drawn", signatureValue: dataUrl }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.signature.method).toBe("drawn");
  });

  it("accepts the string tick markers a form may send", () => {
    const r = validateFp17Declaration(
      validExemption({ evidenceAck: "yes", declarationTruth: "true", consentTreatment: "on", consentDataShare: "1" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.consent.dataShare).toBe(true);
  });
});

describe("validateFp17Declaration — choice rule (1)", () => {
  it("rejects a missing choice", () => {
    expect(validateFp17Declaration(validExemption({ exemptionCategory: undefined }))).toMatchObject({ ok: false });
  });
  it("rejects an unknown choice", () => {
    expect(validateFp17Declaration(validExemption({ exemptionCategory: "hc3" })).ok).toBe(false);
    expect(validateFp17Declaration(validExemption({ exemptionCategory: "" })).ok).toBe(false);
  });
});

describe("validateFp17Declaration — consent rule (2)", () => {
  it("rejects when treatment consent is not given", () => {
    expect(validateFp17Declaration(validExemption({ consentTreatment: false })).ok).toBe(false);
    expect(validateFp17Declaration(validExemption({ consentTreatment: undefined })).ok).toBe(false);
  });
});

describe("validateFp17Declaration — evidence rule (3)", () => {
  it("rejects an exemption claim with no evidence acknowledgement", () => {
    const r = validateFp17Declaration(validExemption({ evidenceAck: false }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain("evidence");
  });
  it("does NOT require evidence for the paying opt-out", () => {
    expect(validateFp17Declaration(validPaying({ evidenceAck: false })).ok).toBe(true);
  });
});

describe("validateFp17Declaration — declaration-truth rule (4)", () => {
  it("rejects when the truth tick is absent — for exemption AND paying", () => {
    expect(validateFp17Declaration(validExemption({ declarationTruth: false })).ok).toBe(false);
    expect(validateFp17Declaration(validPaying({ declarationTruth: false })).ok).toBe(false);
  });
});

describe("validateFp17Declaration — signature rule (5)", () => {
  it("rejects an unknown signature method", () => {
    expect(validateFp17Declaration(validExemption({ signatureMethod: "wet-ink" })).ok).toBe(false);
    expect(validateFp17Declaration(validExemption({ signatureMethod: undefined })).ok).toBe(false);
  });
  it("rejects an empty signature value", () => {
    expect(validateFp17Declaration(validExemption({ signatureValue: "   " })).ok).toBe(false);
    expect(validateFp17Declaration(validExemption({ signatureValue: undefined })).ok).toBe(false);
  });
  it("rejects an over-long typed signature", () => {
    expect(validateFp17Declaration(validExemption({ signatureValue: "x".repeat(121) })).ok).toBe(false);
  });
  it("rejects an over-large drawn signature (DoS bound)", () => {
    const huge = "data:image/png;base64," + "A".repeat(250_001);
    expect(validateFp17Declaration(validExemption({ signatureMethod: "drawn", signatureValue: huge })).ok).toBe(false);
  });
});

describe("validateFp17Declaration — optional identity fields", () => {
  it("accepts missing name / dob and returns null for them", () => {
    const r = validateFp17Declaration(validPaying());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.patientName).toBeNull();
    expect(r.value.dateOfBirth).toBeNull();
  });
  it("rejects an over-long name", () => {
    expect(validateFp17Declaration(validExemption({ patientName: "n".repeat(121) })).ok).toBe(false);
  });
});
