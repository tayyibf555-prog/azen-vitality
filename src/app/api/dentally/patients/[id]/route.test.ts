// Site-scope guard on the patient-record read. The by-id Dentally reads
// (appointments/notes/invoices) are keyed on patient id ALONE, so the route must
// verify the requested patient actually belongs to the caller's authorised site,
// not merely that the caller may reach the site they named. These lock that fix.
//
// The route now reads through getPatientRecord / getPatientRecordInScope
// (src/lib/patient/record.ts) rather than calling getPatientById and
// getPatientDetail itself, so that the record PAGE and this endpoint are served by
// one function behind one cache entry and cannot disagree about a figure. The guard
// itself is unchanged and is asserted here exactly as before: the scoped variant
// resolves the patient by id and checks their site BEFORE running the expensive
// per-patient reads, so a foreign patient's record is never fetched at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireSiteAccess: vi.fn(),
  getPatientRecord: vi.fn(),
  getPatientRecordInScope: vi.fn(),
  numberHealthFor: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireSiteAccess: h.requireSiteAccess,
}));
vi.mock("@/lib/patient/record", () => ({
  getPatientRecord: h.getPatientRecord,
  getPatientRecordInScope: h.getPatientRecordInScope,
}));
vi.mock("@/lib/messaging/number-health", () => ({
  numberHealthFor: h.numberHealthFor,
}));

import { GET } from "./route";

const OWNER = {
  id: "u1",
  email: "o@x",
  role: "client_owner",
  clientId: "vitality",
  siteIds: ["site-cc", "site-rv", "site-ng"],
};

const READS = { appointments: "ok", plans: "ok", notes: "ok", invoices: "ok" } as const;

function recordFor(patient: { id: string; siteId: string; phone?: string | null }) {
  return {
    patient: { phone: null, ...patient },
    detail: {
      appointments: [],
      plans: [],
      notes: [],
      lifetimeSpend: 0,
      outstanding: 0,
      credit: 0,
      totalInvoiced: 0,
      invoices: [],
      reads: READS,
    },
    derived: { ageYears: null, ageLabel: null, completedVisits: 0 },
    reads: READS,
  };
}

/** The real getPatientRecordInScope: resolves by id, then requires the site to match. */
function scopedFake(patient: { id: string; siteId: string; phone?: string | null } | null) {
  return async (_id: string, siteIds: string[]) => {
    if (!patient) return null;
    return siteIds.includes(patient.siteId) ? recordFor(patient) : null;
  };
}

function call(id: string, siteId?: string) {
  const url =
    siteId !== undefined
      ? `http://localhost/api/dentally/patients/${id}?siteId=${siteId}`
      : `http://localhost/api/dentally/patients/${id}`;
  return GET(new Request(url), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(OWNER); // enforced by default
  h.requireSiteAccess.mockReturnValue(null); // caller holds the named site
  h.numberHealthFor.mockResolvedValue({ state: "unchecked", lineType: null });
});

describe("GET /api/dentally/patients/[id] site-scope guard", () => {
  it("returns the record when the patient's real site matches the named site", async () => {
    h.getPatientRecordInScope.mockImplementation(scopedFake({ id: "p1", siteId: "site-cc" }));
    const res = await call("p1", "site-cc");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(h.getPatientRecordInScope).toHaveBeenCalledWith("p1", ["site-cc"]);
    // The endpoint serves the same four pieces the record page renders, so the quick
    // view never has to compute a figure of its own.
    expect(body.patient.id).toBe("p1");
    expect(body.detail).toBeDefined();
    expect(body.derived).toBeDefined();
    expect(body.reads).toEqual(READS);
  });

  it("BLOCKS the IDOR: a patient whose real site differs from the named site is 404, not returned", async () => {
    // Caller holds site-cc (requireSiteAccess passes), but the patient lives in
    // site-rv. Without the guard, the record read would leak that patient's PII.
    h.getPatientRecordInScope.mockImplementation(scopedFake({ id: "p2", siteId: "site-rv" }));
    const res = await call("p2", "site-cc");
    expect(res.status).toBe(404);
    // Never the unscoped read: that would fetch a foreign patient's whole record.
    expect(h.getPatientRecord).not.toHaveBeenCalled();
  });

  it("404s (never leaks existence) when the patient cannot be resolved", async () => {
    h.getPatientRecordInScope.mockImplementation(scopedFake(null));
    const res = await call("ghost", "site-cc");
    expect(res.status).toBe(404);
    expect(h.getPatientRecord).not.toHaveBeenCalled();
  });

  it("returns the SAME 404 body for a wrong-site patient and a non-existent one", async () => {
    h.getPatientRecordInScope.mockImplementation(scopedFake({ id: "p2", siteId: "site-rv" }));
    const wrongSite = await (await call("p2", "site-cc")).json();
    h.getPatientRecordInScope.mockImplementation(scopedFake(null));
    const missing = await (await call("ghost", "site-cc")).json();
    expect(wrongSite).toEqual(missing);
  });

  it("still 400s when siteId is missing", async () => {
    const res = await call("p1");
    expect(res.status).toBe(400);
    expect(h.getPatientRecordInScope).not.toHaveBeenCalled();
    expect(h.getPatientRecord).not.toHaveBeenCalled();
  });

  it("still 403s when the caller may not reach the named site (pre-existing guard)", async () => {
    h.requireSiteAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await call("p1", "site-elsewhere");
    expect(res.status).toBe(403);
    expect(h.getPatientRecordInScope).not.toHaveBeenCalled();
    expect(h.getPatientRecord).not.toHaveBeenCalled();
  });

  it("skips the patient->site check when enforcement is off (auth null), preserving the pilot", async () => {
    h.requireUser.mockResolvedValue(null); // unenforced
    h.getPatientRecord.mockResolvedValue(recordFor({ id: "p1", siteId: "site-cc" }));
    const res = await call("p1", "site-cc");
    expect(res.status).toBe(200);
    expect(h.getPatientRecordInScope).not.toHaveBeenCalled();
    expect(h.getPatientRecord).toHaveBeenCalledWith("p1", "site-cc");
  });
});

describe("GET /api/dentally/patients/[id] number-health read-back", () => {
  it("returns the number-health verdict, resolved from the patient's own number (never the URL)", async () => {
    h.getPatientRecordInScope.mockImplementation(
      scopedFake({ id: "p1", siteId: "site-cc", phone: "07700 900123" }),
    );
    h.numberHealthFor.mockResolvedValue({ state: "mobile", lineType: "mobile" });
    const res = await call("p1", "site-cc");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(h.numberHealthFor).toHaveBeenCalledWith("07700 900123");
    expect(body.numberHealth).toEqual({ state: "mobile", lineType: "mobile" });
  });

  it("does not compute a verdict when enforcement is off (auth null): numberHealth is null", async () => {
    h.requireUser.mockResolvedValue(null);
    h.getPatientRecord.mockResolvedValue(recordFor({ id: "p1", siteId: "site-cc", phone: "07700 900123" }));
    const res = await call("p1", "site-cc");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(h.numberHealthFor).not.toHaveBeenCalled();
    expect(body.numberHealth).toBeNull();
  });

  it("never leaks a verdict for a mismatched-site patient (blocked before the lookup)", async () => {
    h.getPatientRecordInScope.mockImplementation(
      scopedFake({ id: "p2", siteId: "site-rv", phone: "07700 900123" }),
    );
    const res = await call("p2", "site-cc");
    expect(res.status).toBe(404);
    expect(h.numberHealthFor).not.toHaveBeenCalled();
  });
});
