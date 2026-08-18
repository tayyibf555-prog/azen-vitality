// The single source. The patient record has two surfaces (the full page and the
// quick-view drawer) and they must never disagree about a figure, so BOTH read
// through getPatientRecord and neither computes anything.
//
// These lock the two properties that make that true:
//   1. one call resolves the patient AND the detail, and derives every figure from
//      them at one moment;
//   2. the site check in getPatientRecordInScope happens BEFORE the expensive
//      per-patient reads, and returns the same null for "does not exist" and
//      "outside your scope".
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  cachedRead: vi.fn(),
  getPatientById: vi.fn(),
  getPatientDetailUncached: vi.fn(),
}));

vi.mock("@/lib/dentally/read", () => ({
  // The real cachedRead is a no-op under VITEST anyway; this stub keeps the test
  // honest about WHICH key the record is stored under, which is the property that
  // makes the page and the quick view share one moment in time.
  cachedRead: h.cachedRead,
  getPatientById: h.getPatientById,
  getPatientDetailUncached: h.getPatientDetailUncached,
}));

import { getPatientRecord, getPatientRecordInScope } from "./record";

const READS = { appointments: "ok", plans: "ok", notes: "ok", invoices: "ok" } as const;

function patient(over: Record<string, unknown> = {}) {
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
    dateOfBirth: "1967-05-17",
    gender: null,
    smsConsent: false,
    emailConsent: false,
    paymentPlanId: 2,
    ...over,
  };
}

const DETAIL = {
  appointments: [],
  plans: [],
  notes: [],
  lifetimeSpend: 1200,
  outstanding: 45,
  credit: 0,
  totalInvoiced: 1245,
  invoices: [],
  reads: READS,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Pass-through, so the key can be asserted without simulating a cache. Signature
  // is cachedRead(clientId, key, fn, ttl) -- fn is the THIRD arg.
  h.cachedRead.mockImplementation((_clientId: string | null, _key: string, fn: () => Promise<unknown>) => fn());
  h.getPatientById.mockResolvedValue(patient());
  h.getPatientDetailUncached.mockResolvedValue(DETAIL);
});

describe("getPatientRecord", () => {
  it("resolves the patient AND the detail under ONE cache key", async () => {
    await getPatientRecord("p1", "site-cc");
    expect(h.cachedRead).toHaveBeenCalledTimes(1);
    // The tenancy key comes first, then the read key.
    expect(h.cachedRead.mock.calls[0][0]).toBe("vitality");
    expect(h.cachedRead.mock.calls[0][1]).toBe("patientrecord:site-cc:p1");
    expect(h.getPatientById).toHaveBeenCalledTimes(1);
    expect(h.getPatientDetailUncached).toHaveBeenCalledTimes(1);
  });

  it("uses the UNCACHED detail read, so it cannot have its own separate TTL", async () => {
    await getPatientRecord("p1", "site-cc");
    expect(h.getPatientDetailUncached).toHaveBeenCalledWith("p1", "site-cc");
  });

  it("derives every figure once, from the record it just read", async () => {
    const record = await getPatientRecord("p1", "site-cc");
    expect(record?.derived.lifetimeSpend).toBe(1200);
    expect(record?.derived.outstanding).toBe(45);
    expect(record?.derived.totalInvoiced).toBe(1245);
    expect(record?.derived.funding).toBe("private");
    expect(record?.derived.ageLabel).toMatch(/^\d+y \d+m$/);
    // reads is lifted from the detail, so a panel can say "we could not read this".
    expect(record?.reads).toEqual(READS);
  });

  it("returns null when the patient cannot be resolved", async () => {
    h.getPatientById.mockResolvedValue(null);
    expect(await getPatientRecord("ghost", "site-cc")).toBeNull();
  });
});

describe("getPatientRecordInScope", () => {
  it("returns the record when the patient's site is in scope", async () => {
    const record = await getPatientRecordInScope("p1", ["site-cc", "site-rv"]);
    expect(record?.patient.id).toBe("p1");
  });

  it("checks the site BEFORE the expensive per-patient reads run", async () => {
    h.getPatientById.mockResolvedValue(patient({ siteId: "site-rv" }));
    const record = await getPatientRecordInScope("p1", ["site-cc"]);
    expect(record).toBeNull();
    // The whole point: a foreign patient's record is never even fetched.
    expect(h.getPatientDetailUncached).not.toHaveBeenCalled();
  });

  it("returns the SAME null for out-of-scope and non-existent, so neither can be told apart", async () => {
    h.getPatientById.mockResolvedValue(patient({ siteId: "site-rv" }));
    const outOfScope = await getPatientRecordInScope("p1", ["site-cc"]);
    h.getPatientById.mockResolvedValue(null);
    const missing = await getPatientRecordInScope("ghost", ["site-cc"]);
    expect(outOfScope).toBeNull();
    expect(missing).toBeNull();
  });

  it("returns null for an empty scope rather than falling back to every site", async () => {
    expect(await getPatientRecordInScope("p1", [])).toBeNull();
    expect(h.getPatientById).not.toHaveBeenCalled();
  });
});
