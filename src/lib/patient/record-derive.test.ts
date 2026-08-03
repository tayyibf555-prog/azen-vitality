import { describe, it, expect } from "vitest";
import { accountFiguresReconcile, ageLabel, ageYears, balanceLabel, derivePatient } from "./record-derive";
import type { AppointmentRecord, PatientDetail, PatientRecord } from "@/lib/dentally/read";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function patient(over: Partial<PatientRecord> = {}): PatientRecord {
  return {
    id: "p1",
    name: "Alex Berry",
    title: "Mr",
    email: null,
    phone: null,
    siteId: "site-cc",
    active: true,
    archivedReason: null,
    recallDueAt: null,
    dentistRecallAt: null,
    hygienistRecallAt: null,
    lastVisitAt: null,
    dateOfBirth: null,
    gender: null,
    smsConsent: false,
    emailConsent: false,
    paymentPlanId: null,
    ...over,
  };
}

function appt(over: Partial<AppointmentRecord> & { id: string; start: string; state: string }): AppointmentRecord {
  return {
    patientId: "p1",
    patientName: "Alex Berry",
    siteId: "site-cc",
    finish: null,
    durationMin: 30,
    reason: null,
    note: null,
    practitioner: null,
    practitionerId: null,
    ...over,
  };
}

function detail(over: Partial<PatientDetail> = {}): PatientDetail {
  return {
    appointments: [],
    plans: [],
    notes: [],
    lifetimeSpend: 0,
    outstanding: 0,
    credit: 0,
    totalInvoiced: 0,
    invoices: [],
    reads: { appointments: "ok", plans: "ok", notes: "ok", invoices: "ok" },
    ...over,
  };
}

describe("ageLabel", () => {
  it("renders Dentally's own format", () => {
    // Born 17 May 1967, read on 31 July 2026 -> 59 years and 2 months.
    expect(ageLabel("1967-05-17", NOW)).toBe("59y 2m");
  });

  it("is exact on a birthday", () => {
    expect(ageLabel("1967-07-31", NOW)).toBe("59y 0m");
  });

  it("does not round up the day before a birthday", () => {
    expect(ageLabel("1967-08-01", NOW)).toBe("58y 11m");
  });

  it("handles a leap-day birth", () => {
    // 29 Feb 2000, read 31 July 2026: 26 years and 5 months.
    expect(ageLabel("2000-02-29", NOW)).toBe("26y 5m");
  });

  it("returns null, never 0, when there is no date of birth", () => {
    expect(ageLabel(null, NOW)).toBeNull();
    expect(ageYears(null, NOW)).toBeNull();
    expect(ageYears(null, NOW)).not.toBe(0);
  });

  it("returns null for an unparseable date rather than a nonsense age", () => {
    expect(ageLabel("not-a-date", NOW)).toBeNull();
  });

  it("returns null for a date of birth in the future rather than a negative age", () => {
    expect(ageLabel("2030-01-01", NOW)).toBeNull();
  });
});

describe("derivePatient: lastSeenAt", () => {
  it("prefers the newest COMPLETED appointment", () => {
    const d = derivePatient(
      patient({ lastVisitAt: "2020-01-01T09:00:00.000Z" }),
      detail({
        appointments: [
          appt({ id: "a1", start: "2026-01-10T09:00:00.000Z", state: "completed" }),
          appt({ id: "a2", start: "2025-01-10T09:00:00.000Z", state: "completed" }),
        ],
      }),
      NOW,
    );
    expect(d.lastSeenAt).toBe("2026-01-10T09:00:00.000Z");
  });

  it("falls back to the patient record's own lastVisitAt when nothing is completed", () => {
    const d = derivePatient(
      patient({ lastVisitAt: "2020-01-01T09:00:00.000Z" }),
      detail({
        appointments: [
          appt({ id: "a1", start: "2026-01-10T09:00:00.000Z", state: "cancelled" }),
          appt({ id: "a2", start: "2026-02-10T09:00:00.000Z", state: "did_not_attend" }),
        ],
      }),
      NOW,
    );
    expect(d.lastSeenAt).toBe("2020-01-01T09:00:00.000Z");
  });

  it("never treats a did-not-attend as a visit", () => {
    const d = derivePatient(
      patient({ lastVisitAt: null }),
      detail({ appointments: [appt({ id: "a1", start: "2026-06-10T09:00:00.000Z", state: "did_not_attend" })] }),
      NOW,
    );
    expect(d.lastSeenAt).toBeNull();
    expect(d.completedVisits).toBe(0);
  });

  it("carries the practitioner from the newest completed appointment", () => {
    const d = derivePatient(
      patient(),
      detail({
        appointments: [
          appt({ id: "a1", start: "2026-01-10T09:00:00.000Z", state: "completed", practitioner: "Jan Kupeli" }),
        ],
      }),
      NOW,
    );
    expect(d.lastSeenBy).toBe("Jan Kupeli");
  });
});

describe("derivePatient: nextAppointment", () => {
  it("is the SOONEST future booked appointment, not the newest", () => {
    const d = derivePatient(
      patient(),
      detail({
        appointments: [
          appt({ id: "far", start: "2026-12-01T09:00:00.000Z", state: "booked" }),
          appt({ id: "near", start: "2026-08-05T09:00:00.000Z", state: "booked" }),
        ],
      }),
      NOW,
    );
    expect(d.nextAppointment?.id).toBe("near");
  });

  it("ignores cancelled and did-not-attend future rows", () => {
    const d = derivePatient(
      patient(),
      detail({
        appointments: [
          appt({ id: "c", start: "2026-08-02T09:00:00.000Z", state: "cancelled" }),
          appt({ id: "d", start: "2026-08-03T09:00:00.000Z", state: "did_not_attend" }),
          appt({ id: "b", start: "2026-08-09T09:00:00.000Z", state: "booked" }),
        ],
      }),
      NOW,
    );
    expect(d.nextAppointment?.id).toBe("b");
  });

  it("ignores past-dated rows even when they are booked", () => {
    const d = derivePatient(
      patient(),
      detail({ appointments: [appt({ id: "past", start: "2026-01-01T09:00:00.000Z", state: "booked" })] }),
      NOW,
    );
    expect(d.nextAppointment).toBeNull();
  });

  it("accepts a pending booking", () => {
    const d = derivePatient(
      patient(),
      detail({ appointments: [appt({ id: "p", start: "2026-09-01T09:00:00.000Z", state: "pending" })] }),
      NOW,
    );
    expect(d.nextAppointment?.id).toBe("p");
  });
});

describe("derivePatient: counts and figures", () => {
  it("counts completed visits, did-not-attends and cancellations separately", () => {
    const d = derivePatient(
      patient(),
      detail({
        appointments: [
          appt({ id: "1", start: "2025-01-01T09:00:00.000Z", state: "completed" }),
          appt({ id: "2", start: "2025-02-01T09:00:00.000Z", state: "completed" }),
          appt({ id: "3", start: "2025-03-01T09:00:00.000Z", state: "did_not_attend" }),
          appt({ id: "4", start: "2025-04-01T09:00:00.000Z", state: "cancelled" }),
          appt({ id: "5", start: "2025-05-01T09:00:00.000Z", state: "cancelled" }),
        ],
      }),
      NOW,
    );
    expect(d.completedVisits).toBe(2);
    expect(d.didNotAttendCount).toBe(1);
    expect(d.cancelledCount).toBe(2);
  });

  it("passes the money figures straight through from the server read", () => {
    const d = derivePatient(
      patient(),
      detail({ lifetimeSpend: 1234, outstanding: 56, totalInvoiced: 1290 }),
      NOW,
    );
    expect(d.lifetimeSpend).toBe(1234);
    expect(d.outstanding).toBe(56);
    expect(d.totalInvoiced).toBe(1290);
  });

  it("resolves funding from the plan id and never defaults an unknown plan to private", () => {
    expect(derivePatient(patient({ paymentPlanId: 1 }), detail(), NOW).funding).toBe("nhs");
    expect(derivePatient(patient({ paymentPlanId: 2 }), detail(), NOW).funding).toBe("private");
    expect(derivePatient(patient({ paymentPlanId: 999999 }), detail(), NOW).funding).toBe("unknown");
    expect(derivePatient(patient({ paymentPlanId: null }), detail(), NOW).funding).toBe("unknown");
  });

  it("carries the two recall dates separately, as Dentally shows them", () => {
    const d = derivePatient(
      patient({ dentistRecallAt: "2026-10-01", hygienistRecallAt: "2026-09-01" }),
      detail(),
      NOW,
    );
    expect(d.dentistRecallAt).toBe("2026-10-01");
    expect(d.hygienistRecallAt).toBe("2026-09-01");
  });
});

// The state vocabulary, and the defect that made this whole module wrong on live.
// derivePatient decided "still booked" with an ALLOW-list of ["booked", "pending"].
// "booked" is the MOCK's word; live Dentally sends Pending, Confirmed, Arrived, In
// surgery, Completed, Cancelled and Did not attend. Every future appointment in the
// fixtures is "booked", which is exactly why it was invisible locally.
describe("derivePatient: real Dentally states", () => {
  it("counts a Confirmed future appointment as the next one", () => {
    const d = derivePatient(
      patient(),
      detail({ appointments: [appt({ id: "c", start: "2026-08-05T09:00:00.000Z", state: "confirmed" })] }),
      NOW,
    );
    // Before the fix this was null and the record printed "None booked" for a patient
    // sitting in the chair that afternoon.
    expect(d.nextAppointment?.id).toBe("c");
  });

  it("counts Arrived and In surgery as live bookings too", () => {
    for (const state of ["arrived", "in_surgery"]) {
      const d = derivePatient(
        patient(),
        detail({ appointments: [appt({ id: state, start: "2026-08-05T09:00:00.000Z", state })] }),
        NOW,
      );
      expect(d.nextAppointment?.id).toBe(state);
    }
  });

  it("counts an Arrived or In surgery appointment as a visit, so Last seen is not blank", () => {
    const d = derivePatient(
      patient(),
      detail({
        appointments: [
          appt({ id: "here", start: "2026-07-31T09:00:00.000Z", state: "arrived", practitioner: "Jan Kupeli" }),
        ],
      }),
      NOW,
    );
    expect(d.completedVisits).toBe(1);
    expect(d.lastSeenAt).toBe("2026-07-31T09:00:00.000Z");
    expect(d.lastSeenBy).toBe("Jan Kupeli");
  });

  it("still excludes cancelled, did-not-attend and completed from the next appointment", () => {
    const d = derivePatient(
      patient(),
      detail({
        appointments: [
          appt({ id: "x", start: "2026-08-02T09:00:00.000Z", state: "cancelled" }),
          appt({ id: "y", start: "2026-08-03T09:00:00.000Z", state: "did_not_attend" }),
          appt({ id: "z", start: "2026-08-04T09:00:00.000Z", state: "completed" }),
        ],
      }),
      NOW,
    );
    expect(d.nextAppointment).toBeNull();
  });
});

describe("accountFiguresReconcile", () => {
  it("reconciles a clean patient: Balance = Total invoiced - Total paid", () => {
    // pat-001's real figures: 9,995 invoiced, 8,420 paid, 1,575 outstanding.
    expect(
      accountFiguresReconcile({ totalInvoiced: 9995, lifetimeSpend: 8420, outstanding: 1575, credit: 0 }),
    ).toBe(true);
  });

  it("reconciles when everything is settled", () => {
    expect(
      accountFiguresReconcile({ totalInvoiced: 1000, lifetimeSpend: 1000, outstanding: 0, credit: 0 }),
    ).toBe(true);
  });

  it("does NOT reconcile when a written-off invoice inflates Total invoiced only", () => {
    // A £900 course written off: in Total invoiced, but excluded from Paid and Balance.
    expect(
      accountFiguresReconcile({ totalInvoiced: 9995 + 900, lifetimeSpend: 8420, outstanding: 1575, credit: 0 }),
    ).toBe(false);
  });

  it("does NOT reconcile when the patient is in credit, where Balance is not a subtraction", () => {
    expect(
      accountFiguresReconcile({ totalInvoiced: 1000, lifetimeSpend: 1000, outstanding: 0, credit: 120 }),
    ).toBe(false);
  });

  it("tolerates a penny of floating-point drift", () => {
    expect(
      accountFiguresReconcile({ totalInvoiced: 100.01, lifetimeSpend: 50.0, outstanding: 50.0099, credit: 0 }),
    ).toBe(true);
  });
});

describe("balanceLabel", () => {
  const fmt = (n: number) => `£${n.toFixed(2)}`;

  it("shows a debt as the plain figure", () => {
    expect(balanceLabel(120, 0, fmt)).toEqual({ text: "£120.00", tone: "owed" });
  });

  it("shows a credit instead of £0.00, which is what the clamp used to print", () => {
    expect(balanceLabel(0, 120, fmt)).toEqual({ text: "£120.00 in credit", tone: "credit" });
  });

  it("shows zero when nothing is owed either way", () => {
    expect(balanceLabel(0, 0, fmt)).toEqual({ text: "£0.00", tone: "settled" });
  });

  it("lets a live debt win over a credit, so nothing owed is ever hidden by one", () => {
    expect(balanceLabel(50, 120, fmt).tone).toBe("owed");
  });
});
