// Recall-aware booking replies: what the agent is actually told, and what it is
// still told when nothing was resolved.
//
// ===========================================================================
// THE BYTE-IDENTITY PIN
// ===========================================================================
// The whole feature is built on one promise: NO CONTEXT RESOLVED MEANS TODAY'S
// BEHAVIOUR, EXACTLY. A failed correlation, a shared family handset, another
// site's record, a disputed reply, a switched-off toggle and an unreachable
// database all converge on the same code path, and that path must produce the
// system prompt that shipped before this feature existed.
//
// The two hashes below were taken from `buildSystemPrompt` on the commit BEFORE
// the reply-context block was added, over two fixed contexts (a known patient and
// an unrecognised number). They are byte-exact: a single character added, removed
// or reordered anywhere in the no-context prompt fails this test.
//
// IF THIS FAILS AND THE CHANGE IS INTENTIONAL — because somebody deliberately
// rewrote the booking agent's prompt — regenerate them by hashing the new output
// of the same two contexts, and say so in the commit. Do NOT regenerate them to
// make a reply-context change go green: this test failing because of a change to
// the reply-context block means that block has stopped being additive, which is
// the bug it exists to catch.
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt";
import type { AgentContext } from "./types";
import type { AgentReplyContext } from "./reply-context";

const KNOWN: AgentContext = {
  patientId: "pat-77",
  siteId: "site-cc",
  channel: "sms",
  patientName: "Aisha Khan",
  treatment: null,
  fundingType: null,
  lastVisitAt: "2024-03-04T09:00:00.000Z",
  recallDueAt: "2025-03-04T09:00:00.000Z",
  isKnownPatient: true,
  usps: ["Open seven days a week"],
};

const UNKNOWN: AgentContext = {
  patientId: "lead:+447700900111",
  siteId: "site-cc",
  channel: "whatsapp",
  patientName: "there",
  treatment: null,
  fundingType: null,
  isKnownPatient: false,
  practiceSites: [
    { id: "site-cc", name: "N15 Vitality Dental" },
    { id: "site-ng", name: "Nottingham" },
  ],
};

/**
 * buildSystemPrompt output with NO reply context resolved. Byte-exact.
 *
 * WHAT THIS PIN IS FOR, AND WHAT IT IS NOT FOR. It exists so that switching
 * `booking-reply-context` off is an EXACT revert: with no context resolved the
 * agent must be byte-for-byte the assistant it was before that feature existed.
 * It is not a freeze on the prompt itself — it is a device that makes any change
 * to the prompt deliberate, reviewed and recorded rather than incidental.
 *
 * UPDATED ONCE, on purpose. Ruling W1-B/3 (3 Sep 2026) added free-text.ts's
 * FREE_TEXT_IS_DATA line to the KNOWN-patient branch: the patient name and the
 * treatment on file are Dentally free text, and this is the one prompt in the
 * platform that drives tools (book, reschedule, cancel, register a patient). The
 * sanitiser strips the SHAPE of an injected instruction; that line strips its
 * AUTHORITY. The `unknown` hash is unchanged, because the unrecognised-number
 * branch interpolates no treatment and the line is not added there.
 *
 * A future change to these bytes needs the same treatment: a ruling, a reason,
 * and this comment extended. Do not silently re-baseline them.
 */
const PRE_FEATURE_SHA256 = {
  known: "e82347362accd044d4d24cd35d3953d905fc67b9d6c4dc5b0bf48b8b63bb74c8",
  unknown: "b0d75e857b82e80672cc4be64ee9337e581a9e14596854d0380b6488cf261ca4",
};

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const RECALL_CONTEXT: AgentReplyContext = {
  module: "recall",
  reference: "site-cc:pat-77:hygienist",
  siteId: "site-cc",
  invitedFor: "their hygiene appointment",
  bookingTreatment: "Hygiene visit",
  sentAt: "2026-08-20T09:00:00.000Z",
};

describe("no context resolved is byte-identical to the pre-feature prompt", () => {
  it("a known patient with no reply context", () => {
    expect(sha256(buildSystemPrompt(KNOWN))).toBe(PRE_FEATURE_SHA256.known);
  });

  it("an unrecognised number with no reply context", () => {
    expect(sha256(buildSystemPrompt(UNKNOWN))).toBe(PRE_FEATURE_SHA256.unknown);
  });

  it("an explicitly undefined reply context is the same as no field at all", () => {
    expect(buildSystemPrompt({ ...KNOWN, replyContext: undefined })).toBe(buildSystemPrompt(KNOWN));
  });

  it("the field carries no marker of its own into the no-context prompt", () => {
    expect(buildSystemPrompt(KNOWN)).not.toContain("WHAT WE LAST SENT THEM");
    expect(buildSystemPrompt(UNKNOWN)).not.toContain("WHAT WE LAST SENT THEM");
  });
});

describe("with a reply context the block is strictly ADDITIVE", () => {
  const without = buildSystemPrompt(KNOWN);
  const with_ = buildSystemPrompt({ ...KNOWN, replyContext: RECALL_CONTEXT });

  it("nothing that was there before is rewritten, only inserted between", () => {
    // The block is inserted ahead of the STAY ON TOPIC rules, so everything before
    // that marker and everything from it onwards must survive untouched.
    const marker = "\nSTAY ON TOPIC.";
    const cut = without.indexOf(marker);
    expect(cut).toBeGreaterThan(0);
    expect(with_.startsWith(without.slice(0, cut))).toBe(true);
    expect(with_.endsWith(without.slice(cut))).toBe(true);
    expect(with_.length).toBeGreaterThan(without.length);
  });
});

describe("what the block tells the agent", () => {
  const prompt = buildSystemPrompt({ ...KNOWN, replyContext: RECALL_CONTEXT });

  it("names what we sent and the appointment to search for", () => {
    expect(prompt).toContain("WHAT WE LAST SENT THEM:");
    expect(prompt).toContain("their hygiene appointment");
    expect(prompt).toContain('call find_slots with the treatment "Hygiene visit"');
  });

  it("tells it NOT to start the conversation over", () => {
    expect(prompt).toContain("Do not ask them what they need");
  });

  it("does NOT weaken the read-back requirement", () => {
    // The deterministic gate in run.ts is the real floor, but the prompt must not
    // pull the other way: a primed agent still reads the slot back and waits.
    expect(prompt).toContain(
      "Read back the exact date, time, practice and appointment and get a clear yes before you book anything",
    );
    // The original rule is still in the prompt too, untouched.
    expect(prompt).toContain(
      "Before you call book or reschedule, read back the exact date, time, site and treatment and get a clear yes.",
    );
  });

  it("keeps every escalation route open", () => {
    expect(prompt).toContain("escalate or stop rather than booking");
  });

  it("uses no funding or treatment-category wording, and no em-dash", () => {
    // Platform rule: internal labels like nhs or private never reach a patient.
    const contexts: AgentReplyContext[] = [
      RECALL_CONTEXT,
      { ...RECALL_CONTEXT, module: "reactivation", invitedFor: "their routine check-up", bookingTreatment: "Checkup" },
      {
        ...RECALL_CONTEXT,
        module: "closer",
        invitedFor: "the invisalign treatment they were planning",
        bookingTreatment: "Invisalign",
      },
    ];
    for (const rc of contexts) {
      const block = buildSystemPrompt({ ...KNOWN, replyContext: rc }).split("WHAT WE LAST SENT THEM:")[1];
      const head = block.split("\n\n")[0].toLowerCase();
      expect(head).not.toContain("nhs");
      expect(head).not.toContain("private");
      expect(head).not.toContain("—");
    }
    // And the standing no-funding-jargon rule is still in the prompt.
    expect(prompt).toContain("NHS or private");
  });

  it("never leaks the internal record id to the model", () => {
    expect(prompt).not.toContain(RECALL_CONTEXT.reference);
    expect(prompt).not.toContain(RECALL_CONTEXT.sentAt);
  });
});

describe("the block stands down for the two contexts it must not contradict", () => {
  it("an outreach invite wins outright; the two never appear together", () => {
    const prompt = buildSystemPrompt({
      ...KNOWN,
      replyContext: RECALL_CONTEXT,
      outreachInvite: {
        treatmentAngle: "a smile assessment",
        practitionerName: "Dr Patel",
        practitionerId: "42",
      },
    });
    expect(prompt).toContain("WHY THEY ARE MESSAGING:");
    expect(prompt).not.toContain("WHAT WE LAST SENT THEM:");
    expect(prompt).not.toContain("Hygiene visit");
  });

  it("an unrecognised number is never told we messaged them about their check-up", () => {
    const prompt = buildSystemPrompt({ ...UNKNOWN, replyContext: RECALL_CONTEXT });
    expect(prompt).toContain("does NOT match anyone on our records");
    expect(prompt).not.toContain("WHAT WE LAST SENT THEM:");
    expect(sha256(prompt)).toBe(PRE_FEATURE_SHA256.unknown);
  });
});
