import { describe, it, expect } from "vitest";
import {
  CLOSER_REFUSAL_MESSAGE,
  MAX_EDITED_BODY_CHARS,
  parseApproveRequest,
  parseDiscardRequest,
  refusalMessage,
} from "./approval";
import { CLOSER_DISCARD_REASONS } from "./discard";

// ===========================================================================
// WHAT A CALLER MAY NAME.
//
// The approval route takes a touch id and, for a discard, a reason. It does NOT
// take a recipient, a site, an opportunity or a channel: those are read from the
// stored touch, server-side. The strongest way to hold that line is for the parser
// to have no field for any of them, which is what this file asserts — not that the
// route remembers not to read them, but that there is nothing to read.
// ===========================================================================

describe("an approve request carries a touch id and, at most, an edit", () => {
  it("accepts a bare approval and reports NO edit", () => {
    const r = parseApproveRequest({ touchId: "t-1" });
    expect(r).toEqual({ ok: true, value: { touchId: "t-1", body: null } });
  });

  it("treats an explicit null body as 'send it as drafted'", () => {
    // The panel omits the field when the text is unchanged; a client that sends
    // null instead means the same thing and must not be a 400.
    expect(parseApproveRequest({ touchId: "t-1", body: null })).toEqual({
      ok: true,
      value: { touchId: "t-1", body: null },
    });
  });

  it("accepts an edit, trimmed", () => {
    const r = parseApproveRequest({ touchId: "t-1", body: "  Hi Sarah, softened.  " });
    expect(r).toEqual({ ok: true, value: { touchId: "t-1", body: "Hi Sarah, softened." } });
  });

  it("refuses a missing, blank or non-string touch id", () => {
    for (const bad of [{}, { touchId: "" }, { touchId: "   " }, { touchId: 7 }, { touchId: null }]) {
      const r = parseApproveRequest(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a body that is present but blank, rather than sending an empty message", () => {
    // A blank edit is a mistake, not an instruction. Caught here so the person is
    // told in their own words, instead of being handed the scan's "empty".
    for (const blank of ["", "   ", "\n\n", "\t"]) {
      const r = parseApproveRequest({ touchId: "t-1", body: blank });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty/i);
    }
  });

  it("refuses a non-string body outright, never coerces one", () => {
    for (const bad of [7, true, {}, ["hello"]]) {
      expect(parseApproveRequest({ touchId: "t-1", body: bad }).ok).toBe(false);
    }
  });

  it("caps the payload before any regex pass runs on it", () => {
    const atCap = "a".repeat(MAX_EDITED_BODY_CHARS);
    expect(parseApproveRequest({ touchId: "t-1", body: atCap }).ok).toBe(true);
    const overCap = "a".repeat(MAX_EDITED_BODY_CHARS + 1);
    expect(parseApproveRequest({ touchId: "t-1", body: overCap }).ok).toBe(false);
    // The cap is a payload ceiling, NOT the real limit: the per-channel caps in
    // checkCloserDraft (480 SMS / 1400 email) are far below it and do the real work.
    expect(MAX_EDITED_BODY_CHARS).toBeGreaterThan(1400);
  });

  it("survives a body that is not an object at all", () => {
    for (const junk of [null, undefined, "string", 7, [], true]) {
      expect(parseApproveRequest(junk).ok).toBe(false);
    }
  });

  it("SILENTLY DROPS every field that would redirect the message", () => {
    // THE IDOR LINE. A caller may not choose who this goes to, on what channel, for
    // which opportunity, at which site. The parsed value's keys are the whole
    // contract, and there are exactly two of them.
    const r = parseApproveRequest({
      touchId: "t-1",
      body: "Hi Sarah.",
      toRef: "patient:someone-else",
      toAddress: "+447700900123",
      siteId: "site-of-another-practice",
      opportunityId: "not-mine",
      channel: "email",
      approvedBy: "the owner",
      status: "sent",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual(["body", "touchId"]);
      expect(JSON.stringify(r.value)).not.toContain("someone-else");
      expect(JSON.stringify(r.value)).not.toContain("447700900123");
    }
  });
});

describe("a discard request must carry a reason from the closed set", () => {
  it.each(CLOSER_DISCARD_REASONS)("accepts %s", (reason) => {
    expect(parseDiscardRequest({ touchId: "t-1", reason })).toEqual({
      ok: true,
      value: { touchId: "t-1", reason },
    });
  });

  it("refuses a missing reason, so a discard is never unreasoned", () => {
    const r = parseDiscardRequest({ touchId: "t-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reason/i);
  });

  it("refuses a reason that is not one of the five", () => {
    // Including the closer's own STOP reasons, which are outputs of the mapping and
    // must never be settable directly: a caller could otherwise write
    // 'opted_out' into the record for a patient who never asked.
    for (const bad of ["opted_out", "excluded", "staff_stopped", "dispute", "", "WRONG_TONE", 1, null, {}]) {
      expect(parseDiscardRequest({ touchId: "t-1", reason: bad }).ok, String(bad)).toBe(false);
    }
  });

  it("refuses a missing touch id even when the reason is valid", () => {
    expect(parseDiscardRequest({ reason: "wrong_tone" }).ok).toBe(false);
  });

  it("carries nothing but the touch id and the reason", () => {
    const r = parseDiscardRequest({
      touchId: "t-1",
      reason: "wrong_tone",
      stopReason: "opted_out",
      siteId: "elsewhere",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(["reason", "touchId"]);
  });
});

describe("a refusal is explained in the words of the person who has to fix it", () => {
  it("every category has a sentence, and no sentence is a machine key", () => {
    for (const [category, message] of Object.entries(CLOSER_REFUSAL_MESSAGE)) {
      expect(message.length, category).toBeGreaterThan(10);
      // No snake_case identifier reaches the screen — neither this category's own
      // key nor any other's. ("empty" is exempt from the key check because it is
      // also an ordinary English word; the underscore rule below still covers it.)
      for (const key of Object.keys(CLOSER_REFUSAL_MESSAGE)) {
        if (!key.includes("_")) continue;
        expect(message, `${category} leaks the key ${key}`).not.toContain(key);
      }
      expect(message, `${category} leaks an underscore`).not.toMatch(/_/);
      // A sentence, addressed to a person: it starts capitalised and ends stopped.
      expect(message, `${category} is not a sentence`).toMatch(/^[A-Z][\s\S]*\.$/);
    }
  });

  it("the debt sentence keeps the one fact that is easy to get wrong", () => {
    // The figure the closer holds is the cost of treatment still to be done, not a
    // bill. If this sentence stops saying so, the screen teaches staff to write the
    // exact thing the scan then refuses.
    expect(CLOSER_REFUSAL_MESSAGE.debt).toMatch(/not a bill|still to be done/i);
  });

  it("falls back safely on a category it has never heard of", () => {
    const fallback = refusalMessage("something_new");
    expect(fallback).toBeTruthy();
    expect(fallback).not.toContain("something_new");
    // ...and still resolves the ones it does know.
    expect(refusalMessage("em_dash")).toBe(CLOSER_REFUSAL_MESSAGE.em_dash);
  });
});
