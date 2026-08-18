// The practitioner read used to sit on the critical path of a cold dashboard load:
// `await readPractitioners(...)` ran to completion BEFORE any of the six panel scans
// began, adding a whole Dentally round trip to the front of the page for a read that
// only the appointment panel consumes. It is now started alongside the scans and
// awaited inside scanAppointments, after that panel's own paging.
//
// This test pins BOTH halves of that change with a single fixture:
//  - CONCURRENCY (the perf win): listPractitioners is rigged to resolve only AFTER
//    listAppointments has been entered. Under the old serial order that is a
//    deadlock — the scans never start, so listAppointments is never called, so the
//    practitioner read never unblocks — and the test would time out. Completing at
//    all is the proof the two reads now overlap.
//  - ZERO DATA LOSS: the one appointment carries a practitioner_id but no inline
//    practitioner NAME, so its name must still be backfilled from the practitioner
//    list, exactly as when the ready-made name map was passed in.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  let releaseSeen: () => void = () => {};
  const appointmentsSeen = new Promise<void>((res) => {
    releaseSeen = res;
  });
  const startIso = new Date().toISOString();
  const client = {
    listAppointments: vi.fn(async () => {
      // Entering the appointment scan is what releases the practitioner read.
      releaseSeen();
      return {
        appointments: [
          {
            id: "appt-1",
            start_time: startIso,
            patient_id: "pat-1",
            patient_name: "Pat One",
            practitioner_id: "prac-1", // but NO `practitioner` name field
            duration: 30,
            state: "",
          },
        ],
      };
    }),
    listPractitioners: vi.fn(async () => {
      await appointmentsSeen; // serial order can never satisfy this -> deadlock -> timeout
      return {
        practitioners: [{ id: "prac-1", active: true, user: { first_name: "Alice", last_name: "Ng" } }],
      };
    }),
    listPayments: vi.fn(async () => ({ payments: [] })),
    listNhsClaims: vi.fn(async () => ({ nhs_claims: [] })),
    listPatients: vi.fn(async () => ({ patients: [] })),
    listTreatmentPlans: vi.fn(async () => ({ treatment_plans: [] })),
    listInvoices: vi.fn(async () => ({ invoices: [] })),
  };
  return { client };
});

// Keep the real module (its pure helpers are used all over the dashboard build) and
// override only the client factory, so every scan reads the rigged client above.
vi.mock("@/lib/dentally/read", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/dentally/read")>();
  return { ...actual, dentallyFromEnv: () => h.client };
});

import { readPracticeDashboard } from "./read";

describe("readPracticeDashboard: the practitioner read overlaps the panel scans", () => {
  it("completes (does not serialise behind the practitioner read) and still resolves appointment practitioner names", async () => {
    const view = await readPracticeDashboard({ clientId: "vitality", now: new Date() });

    // Reaching here proves concurrency: listPractitioners only resolves after
    // listAppointments is called, which is impossible if practitioners were awaited
    // before the scans.
    expect(h.client.listAppointments).toHaveBeenCalled();
    expect(h.client.listPractitioners).toHaveBeenCalled();

    // Zero data loss: the appointment carried no inline practitioner name, so it must
    // have been filled from the practitioner list — the resolution the decoupling had
    // to preserve.
    expect(view.appointments.length).toBeGreaterThan(0);
    expect(view.appointments.every((r) => r.practitionerName === "Alice Ng")).toBe(true);
  });
});
