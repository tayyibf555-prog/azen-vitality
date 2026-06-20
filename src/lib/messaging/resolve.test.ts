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
});
