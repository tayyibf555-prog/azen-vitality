import { describe, it, expect } from "vitest";
import { parsePatientRef, recipientFromPatient, resolveRecipient } from "./resolve";

describe("parsePatientRef", () => {
  it("extracts the patient id", () => {
    expect(parsePatientRef("patient:pat-010")).toBe("pat-010");
  });
  it("returns null for an unknown ref shape", () => {
    expect(parsePatientRef("site:123")).toBeNull();
  });
});

describe("recipientFromPatient", () => {
  const p = { mobile_phone: "+447700900010", email_address: "a@b.test" };
  it("uses mobile for sms and whatsapp", () => {
    expect(recipientFromPatient(p, "sms")).toBe("+447700900010");
    expect(recipientFromPatient(p, "whatsapp")).toBe("+447700900010");
  });
  it("uses email for email", () => {
    expect(recipientFromPatient(p, "email")).toBe("a@b.test");
  });
  it("returns null when the field is missing", () => {
    expect(recipientFromPatient({}, "sms")).toBeNull();
  });
  // Regression (blocker #3): Dentally returns numbers in UK NATIONAL format, not
  // E.164. Without normalisation Twilio rejects them AND a suppression entry
  // (stored E.164 from the inbound STOP path) never matches, so a patient who
  // texted STOP could still be messaged.
  it("normalises a UK national-format mobile to E.164 for sms/whatsapp", () => {
    expect(recipientFromPatient({ mobile_phone: "07700 900123" }, "sms")).toBe("+447700900123");
    expect(recipientFromPatient({ mobile_phone: "(07700) 900123" }, "whatsapp")).toBe("+447700900123");
    expect(recipientFromPatient({ mobile_phone: "+44 7700 900123" }, "sms")).toBe("+447700900123");
  });
  it("lowercases/trims the email address", () => {
    expect(recipientFromPatient({ email_address: "  Patient@Example.COM " }, "email")).toBe("patient@example.com");
  });
  it("returns null for an implausible number or email (undeliverable, not garbage to the provider)", () => {
    expect(recipientFromPatient({ mobile_phone: "123" }, "sms")).toBeNull();
    expect(recipientFromPatient({ email_address: "not-an-email" }, "email")).toBeNull();
  });
});

describe("resolveRecipient", () => {
  it("fetches the patient and returns the phone for sms", async () => {
    const client = { getPatient: async (id: string) => ({ patient: { id, mobile_phone: "+447700900010", email_address: "a@b.test" } }) };
    const r = await resolveRecipient("patient:pat-010", "sms", client as never);
    expect(r).toBe("+447700900010");
  });
  it("returns null for a bad ref without calling the client", async () => {
    let called = false;
    const client = { getPatient: async () => { called = true; return { patient: {} }; } };
    const r = await resolveRecipient("nope", "sms", client as never);
    expect(r).toBeNull();
    expect(called).toBe(false);
  });
  it("normalises a national-format number returned by Dentally to E.164", async () => {
    const client = { getPatient: async (id: string) => ({ patient: { id, mobile_phone: "07700 900123" } }) };
    const r = await resolveRecipient("patient:pat-010", "sms", client as never);
    expect(r).toBe("+447700900123");
  });
});
