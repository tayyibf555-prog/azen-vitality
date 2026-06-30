import { describe, it, expect } from "vitest";
import { complianceTasks } from "./tasks";
import { MOCK_AUDITS, MOCK_POLICIES, MOCK_TRAINING_RECORDS } from "./mock";
import { KIND_BASE } from "@/lib/task-queue/logic";

const ctx = { clientSlug: "vitality", siteId: "site-1" };

describe("complianceTasks", () => {
  const tasks = complianceTasks(ctx);

  it("produces one task per attention-needing audit, policy and training record", () => {
    const attention = (s: string) => s === "overdue" || s === "due_soon";
    const expected =
      MOCK_AUDITS.filter((a) => attention(a.status)).length +
      MOCK_POLICIES.filter((p) => p.status === "missing" || p.status === "review_due").length +
      MOCK_TRAINING_RECORDS.filter((t) => attention(t.status)).length;
    expect(tasks).toHaveLength(expected);
    // It must not surface anything already in good standing.
    expect(tasks.length).toBeGreaterThan(0);
  });

  it("keys every task stably as compliance:<itemId> and never duplicates", () => {
    const keys = tasks.map((t) => t.key);
    expect(keys.every((k) => k.startsWith("compliance:"))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length); // unique -> overlay sticks, no dupes
    // A known overdue audit maps to its stable id.
    expect(keys).toContain("compliance:audit-htm-0105-decontamination");
    expect(keys).toContain("compliance:audit-fire-risk-assessment");
  });

  it("is deterministic: the same input yields identical tasks", () => {
    expect(complianceTasks(ctx)).toEqual(tasks);
  });

  it("turns overdue audits into high-priority tasks above their kind base", () => {
    const htm = tasks.find((t) => t.key === "compliance:audit-htm-0105-decontamination")!;
    expect(htm.kind).toBe("compliance_audit");
    expect(htm.title).toMatch(/^Overdue:/);
    // Overdue gets the full urgency boost, so it outranks the bare kind base.
    expect(htm.priority).toBeGreaterThan(KIND_BASE.compliance_audit);
  });

  it("ranks an overdue audit above a due-soon audit of the same kind", () => {
    const overdue = tasks.find((t) => t.key === "compliance:audit-fire-risk-assessment")!;
    const dueSoon = tasks.find((t) => t.key === "compliance:audit-water-safety-checks")!;
    expect(overdue.priority).toBeGreaterThan(dueSoon.priority);
    expect(dueSoon.title).toMatch(/^Due soon:/);
  });

  it("treats a missing required policy as overdue and names it", () => {
    const cont = tasks.find((t) => t.key === "compliance:policy-business-continuity")!;
    expect(cont.kind).toBe("compliance_policy");
    expect(cont.title).toMatch(/^Missing:/);
    expect(cont.priority).toBeGreaterThan(KIND_BASE.compliance_policy);
  });

  it("resolves staff and requirement names on overdue training", () => {
    const tr = tasks.find((t) => t.key === "compliance:tr-nurse1-medical-emergencies-cpr")!;
    expect(tr.kind).toBe("compliance_training");
    expect(tr.title).toContain("Sophie Kelman");
    expect(tr.title).toContain("Medical emergencies and CPR");
    expect(tr.title).toMatch(/^Overdue:/);
  });

  it("carries the deep link and a non-empty sort label on every task", () => {
    for (const t of tasks) {
      expect(t.href).toBe(`/c/${ctx.clientSlug}/compliance`);
      expect(t.module).toBe("compliance");
      expect(t.siteId).toBe(ctx.siteId);
      expect(t.patientName.length).toBeGreaterThan(0); // secondary sort key stays stable
      expect(t.dueHint).toBeTruthy();
    }
  });
});
