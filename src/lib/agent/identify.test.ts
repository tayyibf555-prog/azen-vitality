import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DentallyClient } from "@/lib/dentally/client";

vi.mock("./repository", () => ({
  lookupPhoneIdentity: vi.fn(),
  upsertPhoneIdentity: vi.fn(),
}));

import { identifyByPhone } from "./identify";
import { lookupPhoneIdentity, upsertPhoneIdentity } from "./repository";

const lookup = vi.mocked(lookupPhoneIdentity);
const upsert = vi.mocked(upsertPhoneIdentity);

function dentallyReturning(patients: unknown[]): Pick<DentallyClient, "findPatientsByPhone"> {
  return { findPatientsByPhone: async () => ({ patients }) };
}

describe("identifyByPhone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the cached directory identity first and does not hit Dentally", async () => {
    lookup.mockResolvedValue({
      patientId: "pat-010", siteId: "site-cc", patientName: "Harold Pemberton",
      treatment: "Invisalign", fundingType: "private", lastVisitAt: null, recallDueAt: null,
      source: "directory",
    });
    const dentally = dentallyReturning([]);
    const spy = vi.spyOn(dentally, "findPatientsByPhone");

    const id = await identifyByPhone("+447700900010", { dentally });

    expect(id?.patientName).toBe("Harold Pemberton");
    expect(id?.source).toBe("directory");
    expect(spy).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("falls back to a Dentally phone search and caches the hit", async () => {
    lookup.mockResolvedValue(null);
    const id = await identifyByPhone("+447700900001", {
      dentally: dentallyReturning([
        {
          id: "pat-001", first_name: "Eleanor", last_name: "Whitfield", site_id: "site-cc",
          // National-format mobile that normalises to the inbound E.164 — the defensive
          // post-filter accepts it only on an exact E.164 match.
          mobile_phone: "07700 900001",
          dentist_recall_date: null, last_visit_at: "2026-05-15T10:00:00Z",
        },
      ]),
    });

    expect(id?.patientName).toBe("Eleanor Whitfield");
    expect(id?.siteId).toBe("site-cc");
    expect(id?.lastVisitAt).toBe("2026-05-15T10:00:00Z");
    expect(id?.source).toBe("dentally");
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("REJECTS a candidate whose mobile does not match the inbound number (unfiltered list guard, finding #10)", async () => {
    lookup.mockResolvedValue(null);
    // The endpoint returned a patient whose number is NOT the caller's (as an
    // uncalibrated/unfiltered filter would): never identify them as this caller.
    const id = await identifyByPhone("+447700900001", {
      dentally: dentallyReturning([
        { id: "pat-999", first_name: "Wrong", last_name: "Person", site_id: "site-cc", mobile_phone: "+447700900555" },
      ]),
    });
    expect(id).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns null for an unrecognised number", async () => {
    lookup.mockResolvedValue(null);
    const id = await identifyByPhone("+447403097379", { dentally: dentallyReturning([]) });
    expect(id).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});
