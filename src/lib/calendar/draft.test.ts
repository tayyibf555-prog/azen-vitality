import { describe, expect, it } from "vitest";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { DRAFT_MAX_CHARS, draftMoveText, patientTimeLabel } from "./draft";

const ARGS = {
  firstName: "Nadia",
  siteName: "Vitality Dental Care N15",
  sitePhone: "020 8888 1234",
  newStartIso: "2026-07-31T13:30:00Z", // 14:30 London (BST)
};

const RENDERED =
  "Hello Nadia, your appointment at Vitality Dental Care N15 has been moved to " +
  "Friday 31 July at 2.30pm. If that does not suit, please call us on 020 8888 1234. " +
  "Vitality Dental Care.";

describe("draftMoveText", () => {
  it("renders the pinned body exactly, including the 2.30pm form", () => {
    const res = draftMoveText(ARGS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toBe(RENDERED);
  });

  it("pins the rendered length and stays inside the cap", () => {
    const res = draftMoveText(ARGS);
    expect(res.ok && res.body.length).toBe(RENDERED.length);
    expect(RENDERED.length).toBe(179);
    expect(RENDERED.length).toBeLessThanOrEqual(DRAFT_MAX_CHARS);
  });

  it("never says NHS or private, in any casing", () => {
    const res = draftMoveText(ARGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(/nhs/i.test(res.body)).toBe(false);
      expect(/private/i.test(res.body)).toBe(false);
    }
  });

  it("has no exclamation mark and names no AI or vendor", () => {
    const res = draftMoveText(ARGS);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).not.toContain("!");
      for (const word of ["Azen", "AI", "Claude", "assistant", "bot"]) {
        expect(res.body.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it("has no em-dash", () => {
    const res = draftMoveText(ARGS);
    expect(res.ok && res.body.includes("—")).toBe(false);
  });

  it("does NOT name the clinician", () => {
    const res = draftMoveText(ARGS);
    expect(res.ok && res.body.includes("Femi")).toBe(false);
  });

  it("passes the shared output guardrail the drain applies", () => {
    const res = draftMoveText(ARGS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(checkAgentReply(res.body, { includePrice: false })).toEqual({ ok: true });
  });

  it("returns no_phone rather than a body with a placeholder in it", () => {
    expect(draftMoveText({ ...ARGS, sitePhone: null })).toEqual({ ok: false, reason: "no_phone" });
    expect(draftMoveText({ ...ARGS, sitePhone: "   " })).toEqual({ ok: false, reason: "no_phone" });
  });

  it("refuses an unreadable start time", () => {
    expect(draftMoveText({ ...ARGS, newStartIso: "nonsense" })).toEqual({ ok: false, reason: "bad_time" });
  });

  it("renders the London wall clock, not UTC", () => {
    // Same instant, GMT rather than BST: 13:30Z is 13:30 London in January.
    const res = draftMoveText({ ...ARGS, newStartIso: "2026-01-15T13:30:00Z" });
    expect(res.ok && res.body).toContain("Thursday 15 January at 1.30pm");
  });

  it("falls back to a neutral greeting rather than an empty gap", () => {
    const res = draftMoveText({ ...ARGS, firstName: "  " });
    expect(res.ok && res.body.startsWith("Hello there, ")).toBe(true);
  });
});

describe("patientTimeLabel", () => {
  it("drops .00 and the leading zero, and gets noon and midnight right", () => {
    expect(patientTimeLabel(14, 30)).toBe("2.30pm");
    expect(patientTimeLabel(14, 0)).toBe("2pm");
    expect(patientTimeLabel(9, 5)).toBe("9.05am");
    expect(patientTimeLabel(12, 0)).toBe("12pm");
    expect(patientTimeLabel(0, 5)).toBe("12.05am");
    expect(patientTimeLabel(11, 59)).toBe("11.59am");
  });
});
