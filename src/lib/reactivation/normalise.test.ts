import { describe, it, expect, afterEach, vi } from "vitest";
import {
  toReactivationTarget,
  withinLapseWindow,
  effectiveMaxLapseMonths,
  DEFAULT_CONFIG,
  UNLIMITED_MAX_LAPSE_MONTHS,
  type ReactivationInput,
} from "./normalise";

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
    // ~10 months before NOW: past the lapsed threshold (lapseMonths = 9).
    lastVisitAt: "2025-08-15T00:00:00Z",
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

  it("targets a patient lapsed years ago: there is NO upper bound by default", () => {
    // The practice asked for every lapsed patient to be reachable, not only those
    // lapsed under a year. Nine years gone still classifies as 'lapsed'.
    const ancient = toReactivationTarget(base({ lastVisitAt: "2017-06-15T00:00:00Z" }), NOW);
    expect(ancient).not.toBeNull();
    expect(ancient!.reason).toBe("lapsed");
    // Five years, and just over a year, likewise.
    expect(toReactivationTarget(base({ lastVisitAt: "2021-06-15T00:00:00Z" }), NOW)).not.toBeNull();
    expect(toReactivationTarget(base({ lastVisitAt: "2025-05-01T00:00:00Z" }), NOW)).not.toBeNull();
  });

  it("still excludes beyond a maximum lapse WHEN the practice configures one", () => {
    const capped = { ...DEFAULT_CONFIG, maxLapseMonths: 24 };
    // Five years gone is outside a 24-month ceiling.
    expect(toReactivationTarget(base({ lastVisitAt: "2021-06-15T00:00:00Z" }), NOW, capped)).toBeNull();
    // ~13.5 months is inside it.
    expect(toReactivationTarget(base({ lastVisitAt: "2025-05-01T00:00:00Z" }), NOW, capped)).not.toBeNull();
  });

  it("keeps the LOWER bound: a patient seen inside the lapse threshold is not a target", () => {
    // ~8 months (lapseMonths = 9), no recall date, no plan, no future booking.
    expect(toReactivationTarget(base({ lastVisitAt: "2025-10-20T00:00:00Z" }), NOW)).toBeNull();
    // ~10 months crosses the threshold.
    expect(toReactivationTarget(base({ lastVisitAt: "2025-08-15T00:00:00Z" }), NOW)).not.toBeNull();
  });

  it("keeps the recall seam at 60 days overdue", () => {
    const recent = { lastVisitAt: "2026-06-01T00:00:00Z" };
    // 34 days overdue: still recall's patient, reactivation must not claim them.
    expect(
      toReactivationTarget(
        base({ ...recent, patient: { ...base().patient, dentist_recall_date: "2026-05-15T00:00:00Z" } }),
        NOW,
      ),
    ).toBeNull();
    // 79 days overdue: past the 60-day seam, reactivation adopts them.
    const handed = toReactivationTarget(
      base({ ...recent, patient: { ...base().patient, dentist_recall_date: "2026-03-31T00:00:00Z" } }),
      NOW,
    );
    expect(handed!.reason).toBe("overdue_recall");
  });

  it("fails closed on an unknown last visit: no provable relationship, no text", () => {
    // Removing the upper bound must NOT open the door to patients with no visit on
    // record at all: "we miss you" can only go to someone we can prove attended.
    expect(toReactivationTarget(base({ lastVisitAt: null }), NOW)).toBeNull();
    // An unparseable date is equally unprovable.
    expect(toReactivationTarget(base({ lastVisitAt: "not-a-date" }), NOW)).toBeNull();
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

describe("withinLapseWindow (the shared send-time re-check)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("admits a patient lapsed five years by default: no upper bound", () => {
    expect(withinLapseWindow("2021-06-15T00:00:00Z", NOW)).toBe(true);
    expect(withinLapseWindow("2009-01-01T00:00:00Z", NOW)).toBe(true);
  });

  it("excludes beyond an explicitly configured maximum", () => {
    expect(withinLapseWindow("2021-06-15T00:00:00Z", NOW, 24)).toBe(false);
    expect(withinLapseWindow("2025-05-01T00:00:00Z", NOW, 24)).toBe(true);
  });

  it("honours the deployment-wide env override at every choke point", () => {
    vi.stubEnv("REACTIVATION_MAX_LAPSE_MONTHS", "12");
    expect(withinLapseWindow("2021-06-15T00:00:00Z", NOW)).toBe(false);
    expect(withinLapseWindow("2025-08-15T00:00:00Z", NOW)).toBe(true);
  });

  it("still fails closed with no provable visit, whatever the ceiling", () => {
    expect(withinLapseWindow(null, NOW)).toBe(false);
    expect(withinLapseWindow("not-a-date", NOW)).toBe(false);
  });
});

describe("effectiveMaxLapseMonths", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to unlimited", () => {
    expect(effectiveMaxLapseMonths()).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
    expect(DEFAULT_CONFIG.maxLapseMonths).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
  });

  it("reads a valid positive override", () => {
    vi.stubEnv("REACTIVATION_MAX_LAPSE_MONTHS", "18");
    expect(effectiveMaxLapseMonths()).toBe(18);
  });

  it("falls back to unlimited on a malformed override rather than to NaN", () => {
    vi.stubEnv("REACTIVATION_MAX_LAPSE_MONTHS", "18m");
    expect(effectiveMaxLapseMonths()).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
    vi.stubEnv("REACTIVATION_MAX_LAPSE_MONTHS", "0");
    expect(effectiveMaxLapseMonths()).toBe(UNLIMITED_MAX_LAPSE_MONTHS);
  });
});
