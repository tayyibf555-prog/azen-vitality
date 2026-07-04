// Site-scope guard on the patient-detail read. The by-id Dentally reads
// (appointments/notes/invoices) are keyed on patient id ALONE, so the route must
// verify the requested patient actually belongs to the caller's authorised site,
// not merely that the caller may reach the site they named. These lock that fix.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireSiteAccess: vi.fn(),
  getPatientById: vi.fn(),
  getPatientDetail: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireSiteAccess: h.requireSiteAccess,
}));
vi.mock("@/lib/dentally/read", () => ({
  getPatientById: h.getPatientById,
  getPatientDetail: h.getPatientDetail,
}));

import { GET } from "./route";

const OWNER = {
  id: "u1",
  email: "o@x",
  role: "client_owner",
  clientId: "vitality",
  siteIds: ["site-cc", "site-rv", "site-ng"],
};

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
  h.getPatientDetail.mockResolvedValue({ appointments: [], plans: [], notes: [], lifetimeSpend: 0 });
});

describe("GET /api/dentally/patients/[id] site-scope guard", () => {
  it("returns the record when the patient's real site matches the named site", async () => {
    h.getPatientById.mockResolvedValue({ id: "p1", siteId: "site-cc" });
    const res = await call("p1", "site-cc");
    expect(res.status).toBe(200);
    expect(h.getPatientDetail).toHaveBeenCalledWith("p1", "site-cc");
  });

  it("BLOCKS the IDOR: a patient whose real site differs from the named site is 404, not returned", async () => {
    // Caller holds site-cc (requireSiteAccess passes), but the patient lives in
    // site-rv. Without the guard, getPatientDetail would leak that patient's PII.
    h.getPatientById.mockResolvedValue({ id: "p2", siteId: "site-rv" });
    const res = await call("p2", "site-cc");
    expect(res.status).toBe(404);
    expect(h.getPatientDetail).not.toHaveBeenCalled();
  });

  it("404s (never leaks existence) when the patient cannot be resolved", async () => {
    h.getPatientById.mockResolvedValue(null);
    const res = await call("ghost", "site-cc");
    expect(res.status).toBe(404);
    expect(h.getPatientDetail).not.toHaveBeenCalled();
  });

  it("still 400s when siteId is missing", async () => {
    const res = await call("p1");
    expect(res.status).toBe(400);
    expect(h.getPatientById).not.toHaveBeenCalled();
  });

  it("still 403s when the caller may not reach the named site (pre-existing guard)", async () => {
    h.requireSiteAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await call("p1", "site-elsewhere");
    expect(res.status).toBe(403);
    expect(h.getPatientById).not.toHaveBeenCalled();
  });

  it("skips the patient->site check when enforcement is off (auth null), preserving the pilot", async () => {
    h.requireUser.mockResolvedValue(null); // unenforced
    const res = await call("p1", "site-cc");
    expect(res.status).toBe(200);
    expect(h.getPatientById).not.toHaveBeenCalled();
    expect(h.getPatientDetail).toHaveBeenCalledWith("p1", "site-cc");
  });
});
