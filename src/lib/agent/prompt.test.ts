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
});
