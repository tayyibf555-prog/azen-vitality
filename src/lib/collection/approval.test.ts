import { describe, it, expect } from "vitest";
import {
  COLLECTION_REFUSAL_MESSAGE,
  MAX_EDITED_BODY_CHARS,
  collectionRefusalMessage,
  parseApproveRequest,
  parseDiscardRequest,
} from "./approval";
import { COLLECTION_DISCARD_REASONS } from "./discard";

describe("parseApproveRequest: what a caller may name, and what it may not", () => {
  it("an absent body means 'send it as drafted'", () => {
    expect(parseApproveRequest({ touchId: "t1" })).toEqual({
      ok: true,
      value: { touchId: "t1", body: null },
    });
  });

  it("a supplied body is the human's edit, trimmed", () => {
    expect(parseApproveRequest({ touchId: "t1", body: "  Hi Amira, ...  " })).toEqual({
      ok: true,
      value: { touchId: "t1", body: "Hi Amira, ..." },
    });
  });

  it("a blank edit is a MISTAKE, not an instruction to send nothing", () => {
    const r = parseApproveRequest({ touchId: "t1", body: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("An edited message cannot be empty.");
  });

  it("requires a touch id", () => {
    expect(parseApproveRequest({}).ok).toBe(false);
    expect(parseApproveRequest({ touchId: "" }).ok).toBe(false);
    expect(parseApproveRequest(null).ok).toBe(false);
    expect(parseApproveRequest("nope").ok).toBe(false);
  });

  it("caps the payload before the regex passes ever see it", () => {
    const r = parseApproveRequest({ touchId: "t1", body: "x".repeat(MAX_EDITED_BODY_CHARS + 1) });
    expect(r.ok).toBe(false);
  });

  it("HAS NO FIELD for a recipient, a site, a patient, a channel or an AMOUNT", () => {
    // This is the guarantee. A caller cannot point an approved message at a
    // different number, move it onto a channel the patient never consented to, or
    // change what the message says somebody owes: those all come from the stored
    // touch, server-side. A parser with no field for them is stronger than a route
    // remembering not to read one.
    const r = parseApproveRequest({
      touchId: "t1",
      to: "+447700900999",
      siteId: "site-other",
      patientId: "pat-999",
      channel: "sms",
      amountPence: 999_999,
    });
    expect(r).toEqual({ ok: true, value: { touchId: "t1", body: null } });
  });
});

describe("parseDiscardRequest", () => {
  it.each([...COLLECTION_DISCARD_REASONS])("accepts the offered reason %s", (reason) => {
    expect(parseDiscardRequest({ touchId: "t1", reason })).toEqual({
      ok: true,
      value: { touchId: "t1", reason },
    });
  });

  it("REQUIRES a reason, and only one of the closed set", () => {
    // The reason is an input to the decider, not a note, so an unreasoned discard
    // has to be refused rather than guessed at.
    expect(parseDiscardRequest({ touchId: "t1" }).ok).toBe(false);
    expect(parseDiscardRequest({ touchId: "t1", reason: "meh" }).ok).toBe(false);
  });
});

describe("what a refusal says to the person who typed it", () => {
  it("every category has one sentence of plain English naming what to change", () => {
    for (const [category, sentence] of Object.entries(COLLECTION_REFUSAL_MESSAGE)) {
      expect(sentence.length, `${category} has no staff-facing copy`).toBeGreaterThan(20);
      // No developer vocabulary in a receptionist's screen.
      expect(sentence).not.toMatch(/refus(al|ed)|category|regex|scan/i);
    }
  });

  it("names the serious ones plainly", () => {
    expect(collectionRefusalMessage("threat")).toMatch(/debt collection/i);
    expect(collectionRefusalMessage("care_withheld")).toMatch(/not conditional/i);
    expect(collectionRefusalMessage("credential_request")).toMatch(/card or bank details/i);
    expect(collectionRefusalMessage("no_query_invitation")).toMatch(/already paid/i);
  });

  it("falls back safely for anything unrecognised", () => {
    expect(collectionRefusalMessage("something_new")).toBe("That wording cannot be sent to a patient.");
  });
});
