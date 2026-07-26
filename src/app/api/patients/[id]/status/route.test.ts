// Guard chain + verbs for PATCH/GET /api/patients/[id]/status.
//
// Order enforced: requireUser -> role (owner/coordinator/agency only) -> client access
// -> site access -> patient/site IDOR check. The chain now lives in lib/patient/access
// (shared with the profile-edit route) and is NOT mocked here, so the role gate and the
// IDOR check are exercised for real; only the auth primitives underneath are doubled.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireClientAccess: vi.fn(),
  requireSiteAccess: vi.fn(),
  getPatientById: vi.fn(),
  applyStatusChange: vi.fn(),
  getOverride: vi.fn(),
  listAudit: vi.fn(),
}));

vi.mock("@/lib/telemetry", () => ({ recordUsage: vi.fn(async () => undefined) }));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireClientAccess: h.requireClientAccess,
  requireSiteAccess: h.requireSiteAccess,
}));
vi.mock("@/lib/dentally/read", () => ({ getPatientById: h.getPatientById }));
vi.mock("@/lib/mock/clients", () => ({
  // site-cc belongs to vitality; anything else is unknown.
  getSite: (id: string) => (id === "site-cc" ? { clientId: "vitality" } : undefined),
}));
vi.mock("@/lib/patient-status/service", () => ({ applyStatusChange: h.applyStatusChange }));
vi.mock("@/lib/patient-status/repository", () => ({ getOverride: h.getOverride, listAudit: h.listAudit }));

import { PATCH, GET } from "./route";

const OWNER = { id: "u1", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
const COORD = { id: "u2", email: "c@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"] };
const OTHER = { id: "u3", email: "e@x", role: "client_employee", clientId: "vitality", siteIds: ["site-cc"] };

function patch(id: string, body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/patients/${id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
function get(id: string, siteId?: string) {
  const url = siteId !== undefined
    ? `http://localhost/api/patients/${id}/status?siteId=${siteId}`
    : `http://localhost/api/patients/${id}/status`;
  return GET(new Request(url), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(OWNER);
  h.requireClientAccess.mockReturnValue(null);
  h.requireSiteAccess.mockReturnValue(null);
  h.getPatientById.mockResolvedValue({ id: "p1", siteId: "site-cc" });
  h.applyStatusChange.mockResolvedValue({ status: "inactive", dentally: "skipped", fromStatus: null });
  h.getOverride.mockResolvedValue(null);
  h.listAudit.mockResolvedValue([]);
});

describe("role gate", () => {
  it("owner may change status (200)", async () => {
    const res = await patch("p1", { siteId: "site-cc", status: "inactive" });
    expect(res.status).toBe(200);
    expect(h.applyStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-cc", patientId: "p1", status: "inactive", actorEmail: "o@x" }),
    );
  });

  it("practice-manager (coordinator) may change status (200)", async () => {
    h.requireUser.mockResolvedValue(COORD);
    const res = await patch("p1", { siteId: "site-cc", status: "do_not_contact" });
    expect(res.status).toBe(200);
  });

  it("any other role is 403 and never applies the change", async () => {
    h.requireUser.mockResolvedValue(OTHER);
    const res = await patch("p1", { siteId: "site-cc", status: "inactive" });
    expect(res.status).toBe(403);
    expect(h.applyStatusChange).not.toHaveBeenCalled();
  });

  it("401 when not signed in (requireUser returns a 401 Response)", async () => {
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await patch("p1", { siteId: "site-cc", status: "inactive" });
    expect(res.status).toBe(401);
    expect(h.applyStatusChange).not.toHaveBeenCalled();
  });
});

describe("site scope + IDOR", () => {
  it("403 when the caller may not reach the named site", async () => {
    h.requireSiteAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await patch("p1", { siteId: "site-cc", status: "inactive" });
    expect(res.status).toBe(403);
    expect(h.applyStatusChange).not.toHaveBeenCalled();
  });

  it("404 IDOR: a patient whose real site differs from the named site", async () => {
    h.getPatientById.mockResolvedValue({ id: "p1", siteId: "site-other" });
    const res = await patch("p1", { siteId: "site-cc", status: "inactive" });
    expect(res.status).toBe(404);
    expect(h.applyStatusChange).not.toHaveBeenCalled();
  });

  it("400 for an unknown site", async () => {
    const res = await patch("p1", { siteId: "site-unknown", status: "inactive" });
    expect(res.status).toBe(400);
  });

  it("400 for an invalid status value", async () => {
    const res = await patch("p1", { siteId: "site-cc", status: "banned" });
    expect(res.status).toBe(400);
    expect(h.applyStatusChange).not.toHaveBeenCalled();
  });

  it("unenforced (auth null) skips the IDOR read and proceeds", async () => {
    h.requireUser.mockResolvedValue(null);
    const res = await patch("p1", { siteId: "site-cc", status: "inactive" });
    expect(res.status).toBe(200);
    expect(h.getPatientById).not.toHaveBeenCalled();
  });
});

describe("GET returns override + trail", () => {
  it("returns the current override and last audit entries", async () => {
    h.getOverride.mockResolvedValue({ status: "do_not_contact" });
    h.listAudit.mockResolvedValue([{ id: "a1", action: "set_status", toStatus: "do_not_contact" }]);
    const res = await get("p1", "site-cc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.override.status).toBe("do_not_contact");
    expect(body.audit).toHaveLength(1);
    // Reads a wider slice than it shows, because profile-edit rows share the table and
    // are filtered out below; the caller still sees at most 10 status entries.
    expect(h.listAudit).toHaveBeenCalledWith("site-cc", "p1", 50);
  });

  it("profile-edit rows never appear in the STATUS history", async () => {
    // patient_admin_audit is shared with the profile editor. An 'edit:<field>' row
    // carries a field VALUE in to_status, which the status reader coerces to 'active';
    // showing it here would invent a status change that never happened.
    h.listAudit.mockResolvedValue([
      { id: "a1", action: "edit:mobile_phone", toStatus: "active" },
      { id: "a2", action: "set_status", toStatus: "inactive" },
    ]);
    const body = await (await get("p1", "site-cc")).json();
    expect(body.audit.map((a: { id: string }) => a.id)).toEqual(["a2"]);
  });

  it("shows at most 10 status entries even when many are read", async () => {
    h.listAudit.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, action: "set_status", toStatus: "active" })),
    );
    const body = await (await get("p1", "site-cc")).json();
    expect(body.audit).toHaveLength(10);
  });

  it("GET is also role + site guarded (403 for a foreign site)", async () => {
    h.requireSiteAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await get("p1", "site-cc");
    expect(res.status).toBe(403);
    expect(h.listAudit).not.toHaveBeenCalled();
  });
});
