// G1 + G2: the no-show Cancel and Rebook actions write to the REAL practice diary,
// so they must go through the same gate as every other write path:
//   - never a DentallyClient built straight from DENTALLY_API_KEY (the READ key),
//   - never a write at all unless isDentallyWriteEnabled(),
//   - never the raw request body forwarded to Dentally, and
//   - never offer a "freed" slot to the waitlist unless Dentally really released it.
//
// Drives the REAL route handler; only the DB / Dentally / auth seams are faked.
// The DentallyClient constructor is booby-trapped so any direct, ungated client
// build fails the test loudly rather than silently reaching api.dentally.co.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  writeEnabled: false,
  cancelAppointment: vi.fn(),
  createAppointment: vi.fn(),
  offerSlot: vi.fn(),
  setTargetStatus: vi.fn(),
  updateCadence: vi.fn(),
  target: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient {
    constructor() {
      throw new Error("a DentallyClient was constructed directly; writes must go through dentallyAgentClient()");
    }
  },
  DentallyError: class DentallyError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
}));
vi.mock("@/lib/dentally/write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dentally/write")>();
  return {
    // Keep the REAL buildManualBookingPayload: its validation contract is part of
    // what this test is checking.
    buildManualBookingPayload: actual.buildManualBookingPayload,
    isDentallyWriteEnabled: () => h.writeEnabled,
    dentallyAgentClient: () => ({
      cancelAppointment: (...a: unknown[]) => h.cancelAppointment(...a),
      createAppointment: (...a: unknown[]) => h.createAppointment(...a),
    }),
  };
});
vi.mock("@/lib/noshow/repository", () => ({
  getTarget: async () => h.target,
  getCadenceByTarget: async () => ({ id: "cad-1", siteId: "site-1" }),
  updateCadence: (...a: unknown[]) => h.updateCadence(...a),
  setTargetStatus: (...a: unknown[]) => h.setTargetStatus(...a),
  addWaitlistEntry: async () => ({ id: "wl-1" }),
}));
vi.mock("@/lib/noshow/fill", () => ({
  offerSlotToNextCandidate: (...a: unknown[]) => h.offerSlot(...a),
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => null, // enforcement off in this environment
  requireSiteAccess: () => null,
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => ({ id: "site-1", clientId: "vitality" }),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true }));

import { POST } from "./route";

function post(action: string, body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost/api/noshow/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ action }) });
}

beforeEach(() => {
  h.writeEnabled = false;
  h.cancelAppointment.mockReset().mockResolvedValue(undefined);
  h.createAppointment.mockReset().mockResolvedValue({ appointment: { id: "appt-new" } });
  h.offerSlot.mockReset().mockResolvedValue({ waitlistId: "wl-1" });
  h.setTargetStatus.mockReset().mockResolvedValue(undefined);
  h.updateCadence.mockReset().mockResolvedValue(undefined);
  h.target = {
    id: "site-1:p-1:appt-1",
    siteId: "site-1",
    dentallyPatientId: "p-1",
    appointmentId: "appt-1",
    appointmentStartAt: "2026-08-01T09:00:00.000Z",
    durationMin: 30,
    practitioner: "Dr Khan",
  };
});

describe("no-show cancel: the Dentally write gate", () => {
  it("never touches Dentally while the write gate is shut", async () => {
    const res = await post("cancel", { targetId: "site-1:p-1:appt-1" });
    const data = (await res.json()) as { ok: boolean; dentallyCancelled: boolean; offeredTo: string | null };

    expect(res.status).toBe(200);
    expect(h.cancelAppointment).not.toHaveBeenCalled();
    expect(data.dentallyCancelled).toBe(false);
    // Our side still stops the reminders.
    expect(h.setTargetStatus).toHaveBeenCalledWith("site-1:p-1:appt-1", "cancelled");
  });

  it("does NOT offer the slot to the waitlist when the Dentally cancel never happened", async () => {
    await post("cancel", { targetId: "site-1:p-1:appt-1" });
    expect(h.offerSlot).not.toHaveBeenCalled();
  });

  it("does NOT offer the slot when the Dentally cancel FAILED", async () => {
    h.writeEnabled = true;
    h.cancelAppointment.mockRejectedValue(new Error("Dentally 500"));

    const res = await post("cancel", { targetId: "site-1:p-1:appt-1" });
    const data = (await res.json()) as { dentallyCancelled: boolean; offeredTo: string | null };

    expect(h.cancelAppointment).toHaveBeenCalledWith("appt-1");
    expect(data.dentallyCancelled).toBe(false);
    expect(data.offeredTo).toBeNull();
    expect(h.offerSlot).not.toHaveBeenCalled();
  });

  it("offers the slot only once Dentally has genuinely released it", async () => {
    h.writeEnabled = true;

    const res = await post("cancel", { targetId: "site-1:p-1:appt-1" });
    const data = (await res.json()) as { dentallyCancelled: boolean; offeredTo: string | null };

    expect(data.dentallyCancelled).toBe(true);
    expect(data.offeredTo).toBe("wl-1");
    expect(h.offerSlot).toHaveBeenCalledTimes(1);
    expect(h.offerSlot.mock.calls[0][0]).toMatchObject({ appointmentId: "appt-1", siteId: "site-1" });
  });
});

describe("no-show rebook: the Dentally write gate", () => {
  it("refuses honestly with 503 while the write gate is shut", async () => {
    const res = await post("book", {
      targetId: "site-1:p-1:appt-1",
      start: "2026-08-05T09:00:00.000Z",
      practitioner_id: 77,
    });

    expect(res.status).toBe(503);
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("takes patient_id from OUR target, never from the request body", async () => {
    h.writeEnabled = true;

    const res = await post("book", {
      targetId: "site-1:p-1:appt-1",
      patient_id: "someone-elses-patient",
      start: "2026-08-05T09:00:00.000Z",
      practitioner_id: 77,
    });

    expect(res.status).toBe(200);
    expect(h.createAppointment).toHaveBeenCalledTimes(1);
    const payload = h.createAppointment.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.patient_id).toBe("p-1");
  });

  it("sends only whitelisted fields and derives the finish time from the appointment duration", async () => {
    h.writeEnabled = true;

    await post("book", {
      targetId: "site-1:p-1:appt-1",
      start: "2026-08-05T09:00:00.000Z",
      practitioner_id: 77,
      // Smuggled fields that must never reach Dentally.
      site_id: "other-site",
      cancel_everything: true,
    });

    const payload = h.createAppointment.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["booked_via_api", "finish_time", "notes", "patient_id", "practitioner_id", "reason", "start_time"].sort(),
    );
    expect(payload.finish_time).toBe("2026-08-05T09:30:00.000Z");
  });

  it("refuses a booking Dentally would reject for a missing practitioner", async () => {
    h.writeEnabled = true;

    const res = await post("book", { targetId: "site-1:p-1:appt-1", start: "2026-08-05T09:00:00.000Z" });

    expect(res.status).toBe(400);
    expect(h.createAppointment).not.toHaveBeenCalled();
  });

  it("stops the old appointment's reminders once the rebooking lands", async () => {
    h.writeEnabled = true;

    await post("book", {
      targetId: "site-1:p-1:appt-1",
      start: "2026-08-05T09:00:00.000Z",
      practitioner_id: 77,
    });

    expect(h.setTargetStatus).toHaveBeenCalledWith("site-1:p-1:appt-1", "confirmed");
    expect(h.updateCadence).toHaveBeenCalledWith("cad-1", expect.objectContaining({ status: "confirmed" }));
  });
});
