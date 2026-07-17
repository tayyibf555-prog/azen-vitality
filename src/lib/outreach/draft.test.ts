// Outreach draft: the deterministic fallback is guardrail-safe (no funding/clinical
// jargon, no em-dash), and draftOutreach falls back to it whenever the model call
// fails OR its output trips the guardrail, so a step is never queued empty or unsafe.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));

import { outreachFallbackBody, firstName, draftOutreach } from "./draft";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { OUTREACH_CADENCE } from "./cadence";
import type { OutreachCampaign, OutreachTarget } from "./types";

function campaign(over: Partial<OutreachCampaign> = {}): OutreachCampaign {
  return {
    id: "c1",
    clientId: "vitality",
    siteId: "site-cc",
    name: "Saturday hygiene",
    status: "running",
    filters: {},
    practitionerId: "p1",
    practitionerName: "Dr Patel",
    messageAngle: "hygiene appointment",
    dailyCap: 25,
    buildCursor: null,
    counts: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function target(over: Partial<OutreachTarget> = {}): OutreachTarget {
  return {
    id: "t1",
    campaignId: "c1",
    patientId: "1",
    name: "Jane Smith",
    phone: "07700900000",
    siteId: "site-cc",
    matchedReason: "Scale & Polish 14 Mar 2025",
    status: "pending",
    consent: { sms: true, email: false, marketing: false },
    currentStep: 0,
    nextDueAt: null,
    startedAt: null,
    endedAt: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("firstName", () => {
  it("takes the first token, or a friendly default", () => {
    expect(firstName("Jane Smith")).toBe("Jane");
    expect(firstName("  ")).toBe("there");
  });
});

describe("outreachFallbackBody", () => {
  for (const step of OUTREACH_CADENCE) {
    it(`step ${step.step} (${step.purpose}) is warm, personal and guardrail-safe`, () => {
      const body = outreachFallbackBody(target(), campaign(), step);
      expect(body).toContain("Jane");
      expect(body.toLowerCase()).toContain("dr patel");
      // House rules: no em-dash, no NHS/private/funding wording, no clinical advice.
      expect(body).not.toMatch(/[—–]/);
      expect(checkAgentReply(body, { includePrice: false }).ok).toBe(true);
    });
  }

  it("still works with no clinician named", () => {
    const body = outreachFallbackBody(target(), campaign({ practitionerName: null }), OUTREACH_CADENCE[0]);
    expect(body).toContain("Jane");
    expect(checkAgentReply(body, { includePrice: false }).ok).toBe(true);
  });
});

describe("draftOutreach fallback behaviour", () => {
  const step = OUTREACH_CADENCE[0];

  it("uses the model reply when it is clean", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, lovely to reach out." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(false);
    expect(res.body).toBe("Hi Jane, lovely to reach out.");
  });

  it("falls back when the model output trips the guardrail (NHS wording)", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, book your NHS check-up." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body.toLowerCase()).not.toContain("nhs");
  });

  // Finding #4 (compliance): outreach is patient-facing marketing SMS, so an INVENTED
  // firm price must trip the guardrail (includePrice is enforced here, not disabled)
  // and the deterministic fallback (which carries no price) must be used instead.
  it("falls back when the model invents a firm marketing price (just £99)", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, whitening this month, just £99! Reply to book." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).not.toContain("£"); // the safe fallback quotes no price at all
    expect(res.body).not.toContain("99");
  });

  it("falls back when the model states a firm exact price (it costs £99)", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, a scale and polish costs £99. Reply to book." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).not.toContain("£");
  });

  it("does NOT over-block a legitimately hedged 'from £' selling point", async () => {
    // A hedged "from £X" line is the one allowed price shape; it must pass, not fall back.
    const client = { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: "Hi Jane, whitening from £99. Reply and we will find a time that suits you." }] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(false);
    expect(res.body).toContain("from £99");
  });

  it("falls back when the model call throws", async () => {
    const client = { messages: { create: vi.fn(async () => { throw new Error("model down"); }) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).toContain("Jane");
  });

  it("falls back when the model returns an empty body", async () => {
    const client = { messages: { create: vi.fn(async () => ({ content: [] })) } };
    const res = await draftOutreach(target(), campaign(), "sms", step, client as never);
    expect(res.usedFallback).toBe(true);
    expect(res.body).toBeTruthy();
  });
});
