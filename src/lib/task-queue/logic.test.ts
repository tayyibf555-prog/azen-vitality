import { describe, it, expect } from "vitest";
import { computePriority, applyOverlay, KIND_BASE } from "./logic";
import type { CandidateTask, TaskOverlayState } from "./types";

function cand(p: Partial<CandidateTask> & { key: string }): CandidateTask {
  return {
    module: "speed-to-lead",
    kind: "contact_lead",
    title: "t",
    subtitle: null,
    patientName: "Zoe",
    patientId: null,
    siteId: "site-cc",
    priority: 50,
    dueHint: null,
    href: "/x",
    ...p,
  };
}

describe("computePriority", () => {
  it("uses the kind base and orders kinds sensibly", () => {
    expect(computePriority("confirm_appt")).toBe(KIND_BASE.confirm_appt);
    expect(computePriority("confirm_appt")).toBeGreaterThan(computePriority("chase_recall"));
    expect(computePriority("contact_lead")).toBeGreaterThan(computePriority("reactivate"));
  });
  it("adds a bounded risk boost for confirmations", () => {
    expect(computePriority("confirm_appt", { riskScore: 100 })).toBe(100); // 90 + 10
    expect(computePriority("confirm_appt", { riskScore: 0 })).toBe(90);
  });
  it("adds a bounded overdue boost and a value boost, clamped at 100", () => {
    expect(computePriority("chase_recall", { overdueDays: 70 })).toBe(56); // 48 + min(8, 10)
    expect(computePriority("chase_recall", { overdueDays: 0 })).toBe(48);
    expect(computePriority("follow_up_plan", { recoverableValue: 1_000_000 })).toBe(70); // 62 + 8
    expect(computePriority("confirm_appt", { riskScore: 1000, overdueDays: 1000 })).toBe(100);
  });
});

describe("applyOverlay", () => {
  const now = "2026-06-27T12:00:00Z";
  const candidates = [
    cand({ key: "a", priority: 60, patientName: "Bob" }),
    cand({ key: "b", priority: 90, patientName: "Amy" }),
    cand({ key: "c", priority: 70, patientName: "Cara" }),
    cand({ key: "d", priority: 80, patientName: "Dan" }),
  ];
  function overlay(p: Partial<TaskOverlayState> & { taskKey: string }): TaskOverlayState {
    return { status: "open", assignee: null, snoozedUntil: null, note: null, ...p };
  }

  it("defaults to open and sorts by priority desc", () => {
    const tasks = applyOverlay(candidates, new Map(), now);
    expect(tasks.map((t) => t.key)).toEqual(["b", "d", "c", "a"]); // 90,80,70,60
    expect(tasks.every((t) => t.status === "open")).toBe(true);
  });

  it("hides done and dismissed tasks", () => {
    const m = new Map([
      ["b", overlay({ taskKey: "b", status: "done" })],
      ["c", overlay({ taskKey: "c", status: "dismissed" })],
    ]);
    expect(applyOverlay(candidates, m, now).map((t) => t.key)).toEqual(["d", "a"]);
  });

  it("hides an actively-snoozed task but resurfaces an expired one", () => {
    const m = new Map([
      ["b", overlay({ taskKey: "b", status: "snoozed", snoozedUntil: "2026-06-27T18:00:00Z" })], // future -> hide
      ["d", overlay({ taskKey: "d", status: "snoozed", snoozedUntil: "2026-06-27T06:00:00Z" })], // past -> resurface
    ]);
    const tasks = applyOverlay(candidates, m, now);
    expect(tasks.map((t) => t.key)).toEqual(["d", "c", "a"]); // b hidden; d back as open
    const d = tasks.find((t) => t.key === "d")!;
    expect(d.status).toBe("open");
    expect(d.snoozedUntil).toBeNull();
  });

  it("carries the assignee through for an open/claimed task", () => {
    const m = new Map([["a", overlay({ taskKey: "a", status: "open", assignee: "jo@x.co" })]]);
    const a = applyOverlay(candidates, m, now).find((t) => t.key === "a")!;
    expect(a.assignee).toBe("jo@x.co");
  });
});
