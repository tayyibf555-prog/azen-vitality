import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt";

const ctx = { patientId: "pat-010", siteId: "site-cc", patientName: "Harold Pemberton", treatment: "Invisalign", fundingType: "private" as const };

describe("buildSystemPrompt", () => {
  it("includes the patient context and core guardrails, with no em-dash", () => {
    const s = buildSystemPrompt(ctx);
    expect(s).toContain("Harold Pemberton");
    expect(s).toContain("Invisalign");
    expect(s.toLowerCase()).toContain("no em-dash");
    expect(s.toLowerCase()).toContain("clinical");
    expect(s.toLowerCase()).toContain("find_slots");
    expect(s.toLowerCase()).toContain("confirm");
    expect(s).not.toContain("—");
    expect(s).toContain("£");
    expect(s.toLowerCase()).toContain("nhs or private"); // no funding jargon to patients
    expect(s.toLowerCase()).toContain("reschedule");
    expect(s.toLowerCase()).toContain("cancel");
    expect(s.toLowerCase()).toContain("rebook"); // a cancellation offers to rebook (retention)
    expect(s.toLowerCase()).toContain("treatment_info"); // can guide on treatments
  });

  it("locks scope on-topic and lists the human-escalation triggers", () => {
    const s = buildSystemPrompt(ctx).toLowerCase();
    // Stay on topic / no random messaging
    expect(s).toContain("stay on topic");
    expect(s).toContain("steer back");
    expect(s).toContain("never start a new topic");
    // Explicit escalation triggers
    expect(s).toContain("escalate_to_human");
    expect(s).toContain("complaint");
    expect(s).toContain("emergency");
    expect(s).toContain("speak to a person");
  });

  it("personalises a known patient with last visit and recall when present", () => {
    const s = buildSystemPrompt({
      ...ctx,
      isKnownPatient: true,
      lastVisitAt: "2024-05-10T09:00:00Z",
      recallDueAt: "2026-01-05T00:00:00Z",
    });
    expect(s).toContain("matches a patient on our records");
    expect(s).toContain("10 May 2024"); // last visit, UK formatted, no em-dash
    expect(s).toContain("5 January 2026"); // recall due
    expect(s).not.toContain("—");
  });

  it("treats an unrecognised number as a brand new enquiry and does not claim to know them", () => {
    const s = buildSystemPrompt({
      patientId: "lead:+447403097379",
      siteId: "site-cc",
      patientName: "there",
      treatment: null,
      fundingType: null,
      isKnownPatient: false,
    });
    expect(s).toContain("does NOT match anyone on our records");
    expect(s.toLowerCase()).toContain("brand new enquiry");
    expect(s.toLowerCase()).toContain("register_patient"); // can onboard a new patient
    expect(s.toLowerCase()).toContain("escalate_to_human");
    expect(s).not.toContain("—");
  });
});

describe("buildSystemPrompt lead context", () => {
  it("grounds a lead conversation in their smile-assessment answers with never-recite rules", () => {
    const prompt = buildSystemPrompt({
      patientId: "lead:+447700900000",
      siteId: "site-cc",
      patientName: "there",
      treatment: "Whitening my teeth",
      fundingType: null,
      isKnownPatient: false,
      assessmentAnswers: [
        "How soon would you like to get started? => As soon as possible",
        "Where are you based? => England",
      ],
    });
    expect(prompt).toContain("WHAT THEY TOLD US");
    expect(prompt).toContain("As soon as possible");
    expect(prompt).toContain("Do not recite these answers back");
    expect(prompt).toContain("never repeat anything about money");
  });

  it("tells the agent to ask a new enquiry where they are based and lists booking links", () => {
    const prompt = buildSystemPrompt({
      patientId: "lead:+447700900000",
      siteId: "site-cc",
      patientName: "there",
      treatment: null,
      fundingType: null,
      isKnownPatient: false,
      practiceSites: [
        { id: "site-cc", name: "N15 Vitality Dental", bookingUrl: "https://x.example/book/vitality?site=site-cc" },
        { id: "site-rv", name: "N17 Dental", bookingUrl: "https://x.example/book/vitality?site=site-rv" },
      ],
    });
    expect(prompt).toContain("PRACTICE LOCATIONS:");
    expect(prompt).toContain("ask where they are based");
    expect(prompt).toContain("You can only search and book appointments at N15 Vitality Dental.");
    expect(prompt).toContain("N17 Dental: https://x.example/book/vitality?site=site-rv");
  });

  it("never shows the location-routing block to a known patient", () => {
    const prompt = buildSystemPrompt({
      patientId: "p1",
      siteId: "site-cc",
      patientName: "Amira Khan",
      treatment: null,
      fundingType: null,
      isKnownPatient: true,
      practiceSites: [
        { id: "site-cc", name: "N15 Vitality Dental" },
        { id: "site-rv", name: "N17 Dental" },
      ],
    });
    expect(prompt).not.toContain("PRACTICE LOCATIONS:");
  });
});
