import { describe, it, expect } from "vitest";
import { classifyRecall, rankByDue, shouldGraduate, type RecallInput } from "./normalise";

const NOW = new Date("2026-06-18T09:00:00Z");
const DAY = 86_400_000;
function isoFromNow(days: number): string {
  // Positive days = overdue (in the past); negative = due in the future.
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function base(p: Partial<RecallInput> = {}): RecallInput {
  return {
    siteId: "site-cc",
    patient: {
      id: "123",
      first_name: "Sarah",
      last_name: "Lindqvist",
      use_sms: true,
      use_email: false,
      marketing: 1,
      dentist_recall_date: null,
      hygienist_recall_date: null,
    },
    lastVisitAt: "2026-01-10T00:00:00Z",
    futureBookingExists: false,
    ...p,
  };
}

describe("classifyRecall", () => {
  it("maps core fields, id, recall type and consent for a due-soon dentist recall", () => {
    const targets = classifyRecall(
      base({ patient: { ...base().patient, dentist_recall_date: isoFromNow(-7) } }),
      NOW,
    );
    expect(targets).toHaveLength(1);
    const t = targets[0];
    expect(t.id).toBe("site-cc:123:dentist");
    expect(t.recallType).toBe("dentist");
    expect(t.patientName).toBe("Sarah Lindqvist");
    expect(t.overdueDays).toBe(-7);
    expect(t.status).toBe("due");
    expect(t.consent).toEqual({ sms: true, email: false, marketing: true });
  });

  it("includes an in-window overdue recall", () => {
    const targets = classifyRecall(
      base({ patient: { ...base().patient, hygienist_recall_date: isoFromNow(29) } }),
      NOW,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].recallType).toBe("hygienist");
    expect(targets[0].overdueDays).toBe(29);
  });

  it("includes a recall exactly at the grace boundary but excludes one past it", () => {
    const atBoundary = classifyRecall(
      base({ patient: { ...base().patient, dentist_recall_date: isoFromNow(60) } }),
      NOW,
    );
    expect(atBoundary).toHaveLength(1);

    const pastBoundary = classifyRecall(
      base({ patient: { ...base().patient, dentist_recall_date: isoFromNow(61) } }),
      NOW,
    );
    expect(pastBoundary).toHaveLength(0); // belongs to reactivation
  });

  it("excludes a recall that is still earlier than the lead window", () => {
    const targets = classifyRecall(
      base({ patient: { ...base().patient, dentist_recall_date: isoFromNow(-30) } }),
      NOW,
    );
    expect(targets).toHaveLength(0);
  });

  it("produces two targets when both dentist and hygienist recalls are in window", () => {
    const targets = classifyRecall(
      base({
        patient: {
          ...base().patient,
          dentist_recall_date: isoFromNow(-5),
          hygienist_recall_date: isoFromNow(20),
        },
      }),
      NOW,
    );
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.id).sort()).toEqual(["site-cc:123:dentist", "site-cc:123:hygienist"]);
  });

  it("returns nothing when a future booking exists, even with a due recall", () => {
    const targets = classifyRecall(
      base({
        futureBookingExists: true,
        patient: { ...base().patient, dentist_recall_date: isoFromNow(10) },
      }),
      NOW,
    );
    expect(targets).toHaveLength(0);
  });

  it("ignores a malformed recall date instead of misclassifying", () => {
    const targets = classifyRecall(
      base({ patient: { ...base().patient, dentist_recall_date: "not-a-date" } }),
      NOW,
    );
    expect(targets).toHaveLength(0);
  });

  it("does not copy any field outside the whitelist (no clinical data)", () => {
    const dirty = base({ patient: { ...base().patient, dentist_recall_date: isoFromNow(5) } });
    (dirty.patient as Record<string, unknown>).medical_notes = "SECRET";
    const targets = classifyRecall(dirty, NOW);
    expect(JSON.stringify(targets)).not.toContain("SECRET");
  });
});

describe("rankByDue", () => {
  it("orders the most overdue / soonest due first", () => {
    const targets = classifyRecall(
      base({
        patient: {
          ...base().patient,
          dentist_recall_date: isoFromNow(-5), // due in 5 days
          hygienist_recall_date: isoFromNow(40), // 40 days overdue
        },
      }),
      NOW,
    );
    const ranked = rankByDue(targets);
    expect(ranked[0].recallType).toBe("hygienist"); // earliest due date
    expect(ranked[1].recallType).toBe("dentist");
  });
});

describe("shouldGraduate", () => {
  it("graduates only once past the grace boundary", () => {
    expect(shouldGraduate(61, 60)).toBe(true);
    expect(shouldGraduate(60, 60)).toBe(false);
    expect(shouldGraduate(-5, 60)).toBe(false);
  });
});
