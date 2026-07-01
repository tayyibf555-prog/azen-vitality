import { describe, it, expect } from "vitest";
import { classifyRecall, shouldGraduate, type RecallInput } from "./normalise";
import { londonOverdueDays } from "@/lib/time/london";
import { RECALL_CADENCE, stepDef, advanceAfter, dueAt, nextStep } from "./cadence";

// AREA 7: cadence scheduling correctness (Europe/London due calc) and the 60-day
// reactivation seam proven at the classification boundary — a recall in [-lead, +grace]
// stays with recall; one past +grace leaves recall so reactivation can adopt it,
// with NO overlap day (the boundary belongs to exactly one module).

// ---------------------------------------------------------------------------
// Europe/London due calculation.
// ---------------------------------------------------------------------------
describe("londonOverdueDays — whole-day, DST-stable", () => {
  it("is 0 on the London day of the due date even across the UTC midnight boundary", () => {
    // 23:30 UTC on 30 Jun is 00:30 London on 1 Jul (BST, +1). A due date of 1 Jul
    // must read as due-today (0), not one day early, when 'now' is that instant.
    const now = new Date("2026-06-30T23:30:00Z");
    expect(londonOverdueDays("2026-07-01T09:00:00Z", now)).toBe(0);
  });

  it("counts a whole overdue day in London terms", () => {
    const now = new Date("2026-07-02T10:00:00Z");
    expect(londonOverdueDays("2026-07-01T09:00:00Z", now)).toBe(1);
  });

  it("is negative for a future due date (due soon)", () => {
    const now = new Date("2026-06-25T10:00:00Z");
    expect(londonOverdueDays("2026-07-01T09:00:00Z", now)).toBe(-6);
  });

  it("does not drift across a BST->GMT DST change (late Oct)", () => {
    // 26 Oct 2025 was the BST->GMT switch. A 30-day span across it must still be 30.
    const now = new Date("2025-11-10T12:00:00Z");
    expect(londonOverdueDays("2025-10-11T12:00:00Z", now)).toBe(30);
  });

  it("fails safe to 'far future' for an unparseable date (never reads as overdue)", () => {
    expect(londonOverdueDays("not-a-date", new Date())).toBe(Number.NEGATIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// The 60-day seam: recall owns [-14, +60], reactivation owns (+60, ...).
// ---------------------------------------------------------------------------
const NOW = new Date("2026-06-18T12:00:00Z");
const DAY = 86_400_000;
function dueDaysOverdue(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}
function base(recallDate: string): RecallInput {
  return {
    siteId: "site-cc",
    patient: {
      id: "p-seam",
      first_name: "Jo",
      last_name: "Bloggs",
      use_sms: true,
      use_email: true,
      marketing: 1,
      dentist_recall_date: recallDate,
      hygienist_recall_date: null,
    },
    lastVisitAt: null,
    futureBookingExists: false,
  };
}

describe("60-day seam — recall vs reactivation ownership (no overlap day)", () => {
  it("recall CLAIMS the boundary day (exactly +60) and reactivation must not", () => {
    // classifyRecall keeps <= graceDays; shouldGraduate is strictly > graceDays.
    const atBoundary = classifyRecall(base(dueDaysOverdue(60)), NOW);
    expect(atBoundary).toHaveLength(1); // recall still owns +60
    expect(shouldGraduate(60, 60)).toBe(false); // reactivation does NOT adopt +60
  });

  it("recall RELEASES the day after the boundary (+61) and reactivation adopts it", () => {
    const pastBoundary = classifyRecall(base(dueDaysOverdue(61)), NOW);
    expect(pastBoundary).toHaveLength(0); // recall no longer classifies it
    expect(shouldGraduate(61, 60)).toBe(true); // reactivation legitimately adopts +61
  });

  it("the classify cutoff and the graduate cutoff meet with no gap and no overlap", () => {
    // For every day d, at most one module owns it: recall for d<=60, reactivation for d>60.
    for (let d = 58; d <= 63; d++) {
      const recallOwns = classifyRecall(base(dueDaysOverdue(d)), NOW).length === 1;
      const reactivationOwns = shouldGraduate(d, 60);
      // Exactly one of the two is true (XOR): never both (double-contact), never
      // neither within this band (dropped patient).
      expect(recallOwns !== reactivationOwns).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cadence step scheduling gaps: 0, +5, +7 anchored to each send.
// ---------------------------------------------------------------------------
describe("cadence scheduling gaps", () => {
  it("step 1 fires immediately, step 2 at +5d, step 3 at +7d from the prior send", () => {
    expect(stepDef(1, RECALL_CADENCE)!.waitDays).toBe(0);
    expect(stepDef(2, RECALL_CADENCE)!.waitDays).toBe(5);
    expect(stepDef(3, RECALL_CADENCE)!.waitDays).toBe(7);

    const send1 = new Date("2026-06-18T09:00:00Z");
    const afterStep1 = advanceAfter(1, send1, RECALL_CADENCE);
    expect(afterStep1.status).toBe("active");
    // step 2 due 5 days after send1
    expect(afterStep1.nextDueAt).toBe(dueAt(stepDef(2, RECALL_CADENCE)!, send1));
    expect((new Date(afterStep1.nextDueAt!).getTime() - send1.getTime()) / DAY).toBe(5);

    const send2 = new Date(afterStep1.nextDueAt!);
    const afterStep2 = advanceAfter(2, send2, RECALL_CADENCE);
    expect((new Date(afterStep2.nextDueAt!).getTime() - send2.getTime()) / DAY).toBe(7);
  });

  it("exhausts after the final step with no next step", () => {
    expect(nextStep(3, RECALL_CADENCE)).toBeNull();
    const done = advanceAfter(3, NOW, RECALL_CADENCE);
    expect(done.status).toBe("exhausted");
    expect(done.nextDueAt).toBeNull();
    expect(done.endedAt).toBe(NOW.toISOString());
  });
});
