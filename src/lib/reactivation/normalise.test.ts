import { describe, it, expect } from "vitest";
import { toReactivationTarget, type ReactivationInput } from "./normalise";

const NOW = new Date("2026-06-18T09:00:00Z");

function base(p: Partial<ReactivationInput> = {}): ReactivationInput {
  return {
    siteId: "site-cc",
    patient: {
      id: "123", first_name: "Sarah", last_name: "Lindqvist",
      use_sms: true, use_email: false, marketing: 1,
      archived: false, archived_reason: null,
      dentist_recall_date: null, hygienist_recall_date: null,
    },
    lastVisitAt: "2024-06-01T00:00:00Z",
    futureBookingExists: false,
    plan: null,
    amountOutstanding: 0,
    historicSpend: 600,
    lastTouchAt: null,
    ...p,
  };
}

describe("toReactivationTarget", () => {
  it("maps core fields, GBP value and consent", () => {
    const t = toReactivationTarget(base(), NOW)!;
    expect(t.dentallyPatientId).toBe("123");
    expect(t.patientName).toBe("Sarah Lindqvist");
    expect(t.consent).toEqual({ sms: true, email: false, marketing: true });
    expect(t.id).toBe("site-cc:123");
  });

  it("classifies a long-gone patient as lapsed and falls back to historic spend", () => {
    const t = toReactivationTarget(base(), NOW)!;
    expect(t.reason).toBe("lapsed");
    expect(t.recoverableValue).toBe(600);
  });

  it("NEVER targets an archived (deceased/moved-away) patient, except explicitly 'lapsed' (finding #16)", () => {
    // A deceased patient who is also long-gone would otherwise classify as 'lapsed'
    // and be auto-texted "we miss you". Archived + non-lapsed reason must be excluded.
    expect(
      toReactivationTarget(base({ patient: { ...base().patient, archived: true, archived_reason: "deceased" } }), NOW),
    ).toBeNull();
    expect(
      toReactivationTarget(base({ patient: { ...base().patient, archived: true, archived_reason: null } }), NOW),
    ).toBeNull();
    // The one archived cohort reactivation IS for: explicitly 'lapsed'.
    expect(
      toReactivationTarget(base({ patient: { ...base().patient, archived: true, archived_reason: "lapsed" } }), NOW),
    ).not.toBeNull();
  });

  it("skips a patient marked inactive/deactivated in Dentally (active === false)", () => {
    expect(toReactivationTarget(base({ patient: { ...base().patient, active: false } }), NOW)).toBeNull();
    // A missing/true active flag is treated as a live patient (unchanged behaviour).
    expect(toReactivationTarget(base({ patient: { ...base().patient, active: true } }), NOW)).not.toBeNull();
    expect(toReactivationTarget(base(), NOW)).not.toBeNull();
  });

  it("skips a patient last seen beyond the 3-year cap (too cold to reactivate)", () => {
    // The 2017-era rows: excluded despite otherwise classifying as 'lapsed'.
    expect(toReactivationTarget(base({ lastVisitAt: "2017-06-15T00:00:00Z" }), NOW)).toBeNull();
    // Just inside the window (~2 years) still qualifies.
    expect(toReactivationTarget(base({ lastVisitAt: "2024-06-01T00:00:00Z" }), NOW)).not.toBeNull();
  });

  it("uses the baseline value when there is no plan and no historic spend", () => {
    const t = toReactivationTarget(base({ historicSpend: 0 }), NOW)!;
    expect(t.recoverableValue).toBe(80);
  });

  it("classifies an open, cold, outstanding plan as stalled_plan with outstanding value", () => {
    const t = toReactivationTarget(
      base({
        plan: { id: "pl-9", name: "Invisalign full arch", planned_private_treatment_value: 3400, accepted_at: "2026-01-01T00:00:00Z" },
        amountOutstanding: 3400,
      }),
      NOW,
    )!;
    expect(t.reason).toBe("stalled_plan");
    expect(t.recoverableValue).toBe(3400);
    expect(t.treatment).toBe("Invisalign full arch");
    expect(t.dentallyPlanId).toBe("pl-9");
  });

  it("classifies a long-overdue recall (no future booking) as overdue_recall", () => {
    const t = toReactivationTarget(
      base({
        lastVisitAt: "2026-05-01T00:00:00Z",
        patient: { ...base().patient, dentist_recall_date: "2026-01-01T00:00:00Z" },
      }),
      NOW,
    )!;
    expect(t.reason).toBe("overdue_recall");
    expect(t.recallDueAt).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null when the patient is active and has none of the three signals", () => {
    const t = toReactivationTarget(
      base({ lastVisitAt: "2026-06-01T00:00:00Z", futureBookingExists: true }),
      NOW,
    );
    expect(t).toBeNull();
  });

  it("does not copy any field outside the whitelist (no clinical data)", () => {
    const dirty = base();
    (dirty.patient as Record<string, unknown>).medical_notes = "SECRET";
    const t = toReactivationTarget(dirty, NOW)!;
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });

  it("prefers stalled_plan over overdue_recall when both apply", () => {
    const t = toReactivationTarget(
      base({
        plan: { id: "pl-1", name: "Crown", planned_private_treatment_value: 900, accepted_at: "2026-01-01T00:00:00Z" },
        amountOutstanding: 900,
        patient: { ...base().patient, dentist_recall_date: "2026-01-01T00:00:00Z" },
      }),
      NOW,
    )!;
    expect(t.reason).toBe("stalled_plan");
  });

  it("treats archived_reason 'lapsed' as lapsed even with a recent visit", () => {
    const t = toReactivationTarget(
      base({
        lastVisitAt: "2026-06-01T00:00:00Z",
        patient: { ...base().patient, archived_reason: "lapsed" },
      }),
      NOW,
    )!;
    expect(t.reason).toBe("lapsed");
  });

  it("does not classify an overdue recall when a future booking exists", () => {
    const t = toReactivationTarget(
      base({
        lastVisitAt: "2026-05-01T00:00:00Z",
        futureBookingExists: true,
        patient: { ...base().patient, dentist_recall_date: "2026-01-01T00:00:00Z" },
      }),
      NOW,
    );
    expect(t).toBeNull();
  });

  it("ignores a malformed recall date instead of misclassifying", () => {
    const t = toReactivationTarget(
      base({
        lastVisitAt: "2026-06-01T00:00:00Z",
        patient: { ...base().patient, dentist_recall_date: "not-a-date" },
      }),
      NOW,
    );
    expect(t).toBeNull();
  });
});
