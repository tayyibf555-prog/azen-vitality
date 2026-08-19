import { describe, it, expect } from "vitest";
import { LEAD_CONVERSATION_PREFIX, realPatientId } from "./conversation-key";

// agent_conversation.dentally_patient_id holds a real patient id OR a synthetic
// `lead:<phone>` key. Anything that hands that column to a clinical record has to
// tell the two apart, or a phone number ends up sitting where a patient id belongs.

describe("realPatientId", () => {
  it("passes a real Dentally patient id straight through", () => {
    expect(realPatientId("123456")).toBe("123456");
  });

  it("refuses the synthetic key the inbound webhook writes for an unknown number", () => {
    expect(realPatientId("lead:+447700900123")).toBeNull();
  });

  it("refuses the synthetic key speed-to-lead writes for an email-only lead", () => {
    // contact.ts falls back to the email, then the lead uuid, under the same prefix.
    expect(realPatientId("lead:amira@example.com")).toBeNull();
    expect(realPatientId("lead:8f1c0d2e-0000-4000-8000-000000000000")).toBeNull();
  });

  it("refuses the bare prefix, which would otherwise pass as a one-character id", () => {
    expect(realPatientId(LEAD_CONVERSATION_PREFIX)).toBeNull();
  });

  it("is null for absent, empty and whitespace-only values", () => {
    expect(realPatientId(null)).toBeNull();
    expect(realPatientId(undefined)).toBeNull();
    expect(realPatientId("")).toBeNull();
    expect(realPatientId("   ")).toBeNull();
  });

  it("trims, so a padded column value is still recognised as the id it is", () => {
    expect(realPatientId("  123456  ")).toBe("123456");
    expect(realPatientId("  lead:+447700900123 ")).toBeNull();
  });

  it("only strips the prefix at the START, so an id that merely contains it survives", () => {
    // Not a real Dentally id shape, but the rule must be anchored: a substring match
    // would silently unlink patients whose id happened to contain the word.
    expect(realPatientId("99lead:1")).toBe("99lead:1");
  });

  it("uses the exact prefix the writers use", () => {
    // If this ever drifts from `lead:${from}` in the inbound webhook and in
    // speed-to-lead's contact path, every unidentified enquiry starts being claimed
    // as a patient. Pinned here so the constant cannot be edited in isolation.
    expect(LEAD_CONVERSATION_PREFIX).toBe("lead:");
  });
});
