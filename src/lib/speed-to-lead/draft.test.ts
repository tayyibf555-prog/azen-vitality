import { describe, it, expect } from "vitest";
import { buildFirstContactPrompt } from "./draft";
import { toDashboardLead, firstResponseSeconds } from "./types";
import type { SpeedToLeadLead } from "./types";

function lead(p: Partial<SpeedToLeadLead>): SpeedToLeadLead {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    siteId: "site-cc",
    dentallyPatientId: null,
    name: "Sarah Lindqvist",
    email: "sarah@example.com",
    phone: "+447700900111",
    channel: "sms",
    treatmentInterest: "Invisalign",
    source: "web",
    score: null,
    stage: "new",
    consent: { sms: true },
    createdAt: "2026-06-26T09:00:00Z",
    firstResponseAt: null,
    conversationId: null,
    updatedAt: "2026-06-26T09:00:00Z",
    ...p,
  };
}

describe("buildFirstContactPrompt", () => {
  it("forbids em-dashes and funding jargon, requires GBP, and leads with the first name", () => {
    const { system } = buildFirstContactPrompt(lead({}), "sms");
    expect(system).not.toContain("—"); // em-dash
    expect(system.toLowerCase()).toContain("no em-dash");
    expect(system).toContain("£");
    expect(system.toLowerCase()).toContain("nhs or private"); // no funding jargon to patients
    expect(system.toLowerCase()).toContain("first name");
    expect(system.toLowerCase()).toContain("under 60 words");
  });

  it("mentions the treatment interest when present", () => {
    const { system, user } = buildFirstContactPrompt(lead({ treatmentInterest: "Implants" }), "whatsapp");
    expect(system).toContain("Implants");
    expect(user).toContain("Implants");
    expect(user).toContain("whatsapp");
  });

  it("stays general when no treatment interest was captured", () => {
    const { system } = buildFirstContactPrompt(lead({ treatmentInterest: null }), "email");
    expect(system.toLowerCase()).toContain("keep it general");
  });

  it("uses the first name only in the user payload", () => {
    const { user } = buildFirstContactPrompt(lead({ name: "Sarah Lindqvist" }), "sms");
    expect(user).toContain("Sarah");
    expect(user).not.toContain("Lindqvist");
  });
});

describe("firstResponseSeconds", () => {
  it("is null until first contact", () => {
    expect(firstResponseSeconds(lead({ firstResponseAt: null }))).toBeNull();
  });

  it("computes whole seconds from enquiry to first contact", () => {
    const l = lead({
      createdAt: "2026-06-26T09:00:00Z",
      firstResponseAt: "2026-06-26T09:00:25Z",
    });
    expect(firstResponseSeconds(l)).toBe(25);
  });

  it("never goes negative", () => {
    const l = lead({
      createdAt: "2026-06-26T09:00:30Z",
      firstResponseAt: "2026-06-26T09:00:00Z",
    });
    expect(firstResponseSeconds(l)).toBe(0);
  });
});

describe("toDashboardLead", () => {
  it("maps the row to the shared Lead shape with computed first-response seconds", () => {
    const l = lead({
      score: 82,
      treatmentInterest: "Invisalign",
      createdAt: "2026-06-26T09:00:00Z",
      firstResponseAt: "2026-06-26T09:00:18Z",
      stage: "contacted",
    });
    const dash = toDashboardLead(l);
    expect(dash.id).toBe(l.id);
    expect(dash.siteId).toBe("site-cc");
    expect(dash.assessmentScore).toBe(82);
    expect(dash.treatmentInterest).toBe("Invisalign");
    expect(dash.firstResponseSeconds).toBe(18);
    expect(dash.stage).toBe("contacted");
    expect(dash.channel).toBe("sms");
  });

  it("defaults a missing treatment interest to an empty string", () => {
    const dash = toDashboardLead(lead({ treatmentInterest: null }));
    expect(dash.treatmentInterest).toBe("");
  });
});
