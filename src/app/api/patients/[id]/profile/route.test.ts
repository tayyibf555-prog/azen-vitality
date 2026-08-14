// Guard chain + verbs for GET/PATCH /api/patients/[id]/profile.
//
// This route EDITS A REAL CLINICAL RECORD, so the gate is tested harder than the payload.
// Order enforced: requireUser -> role (owner / practice manager / agency only) -> client
// access -> site access -> patient/site IDOR. The chain in lib/patient/access is NOT
// mocked, so the role and IDOR checks run for real; only the auth primitives and the
// service beneath are doubled.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireClientAccess: vi.fn(),
  requireSiteAccess: vi.fn(),
  getPatientById: vi.fn(),
  applyProfileEdit: vi.fn(),
  getProfile: vi.fn(),
  listProfileAudit: vi.fn(),
  writeEnabled: true,
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
vi.mock("@/lib/dentally/write", () => ({ isDentallyWriteEnabled: () => h.writeEnabled }));
vi.mock("@/lib/patient/profile-service", () => ({
  applyProfileEdit: h.applyProfileEdit,
  getProfile: h.getProfile,
}));

// The PER-PERSON gate, faked at the seam. Its own behaviour — the 403, and the
// 503 when auth is not enforced — is proven in
// src/lib/auth/capability-guard.test.ts; the fs sweep in
// src/app/api/destructive-route-capability-coverage.test.ts proves this route
// calls it. Stubbed open here so these cases stay about the route's own logic.
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));

vi.mock("@/lib/patient/profile-audit", () => ({ listProfileAudit: h.listProfileAudit }));

import { GET, PATCH } from "./route";

const OWNER = { id: "u1", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
const MANAGER = { id: "u2", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"] };
const BELOW = { id: "u3", email: "e@x", role: "client_employee", clientId: "vitality", siteIds: ["site-cc"] };

const LIVE = { first_name: "Alan", last_name: "Turing", email_address: "alan@example.co.uk", active: true };

function patch(id: string, body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/patients/${id}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
function get(id: string, siteId?: string) {
  const url =
    siteId !== undefined
      ? `http://localhost/api/patients/${id}/profile?siteId=${siteId}`
      : `http://localhost/api/patients/${id}/profile`;
  return GET(new Request(url), { params: Promise.resolve({ id }) });
}
/** A well-formed edit body: change the email, everything else as loaded. */
function editBody(changes: Record<string, unknown> = { email_address: "a.turing@example.co.uk" }) {
  return { siteId: "site-cc", changes, expected: LIVE, reason: "patient asked us to update it" };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.writeEnabled = true;
  h.requireUser.mockResolvedValue(OWNER);
  h.requireClientAccess.mockReturnValue(null);
  h.requireSiteAccess.mockReturnValue(null);
  h.getPatientById.mockResolvedValue({ id: "p1", siteId: "site-cc" });
  h.applyProfileEdit.mockResolvedValue({ ok: true, changed: ["email_address"], profile: LIVE, auditRecorded: true });
  h.getProfile.mockResolvedValue(LIVE);
  h.listProfileAudit.mockResolvedValue([]);
});

describe("role gate", () => {
  it("an owner may edit (200)", async () => {
    const res = await patch("p1", editBody());
    expect(res.status).toBe(200);
    expect(h.applyProfileEdit).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-cc", patientId: "p1", actorEmail: "o@x" }),
    );
  });

  it("a practice manager (client_coordinator) may edit (200)", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    expect((await patch("p1", editBody())).status).toBe(200);
  });

  it("any role below that is 403 and never reaches the edit", async () => {
    h.requireUser.mockResolvedValue(BELOW);
    const res = await patch("p1", editBody());
    expect(res.status).toBe(403);
    expect(h.applyProfileEdit).not.toHaveBeenCalled();
  });

  it("a role below that cannot even READ the profile (403)", async () => {
    h.requireUser.mockResolvedValue(BELOW);
    expect((await get("p1", "site-cc")).status).toBe(403);
    expect(h.getProfile).not.toHaveBeenCalled();
  });

  it("401 when not signed in", async () => {
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await patch("p1", editBody());
    expect(res.status).toBe(401);
    expect(h.applyProfileEdit).not.toHaveBeenCalled();
  });
});

describe("site scope + IDOR", () => {
  it("403 when the caller may not reach the named site", async () => {
    h.requireSiteAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await patch("p1", editBody());
    expect(res.status).toBe(403);
    expect(h.applyProfileEdit).not.toHaveBeenCalled();
  });

  it("403 when the caller may not reach the client that owns the site", async () => {
    h.requireClientAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    expect((await patch("p1", editBody())).status).toBe(403);
    expect(h.applyProfileEdit).not.toHaveBeenCalled();
  });

  it("404 IDOR: editing a patient whose real site is NOT the named site", async () => {
    h.getPatientById.mockResolvedValue({ id: "p1", siteId: "site-ng" });
    const res = await patch("p1", editBody());
    expect(res.status).toBe(404);
    expect(h.applyProfileEdit).not.toHaveBeenCalled();
  });

  it("404 IDOR on the READ path too", async () => {
    h.getPatientById.mockResolvedValue({ id: "p1", siteId: "site-ng" });
    expect((await get("p1", "site-cc")).status).toBe(404);
    expect(h.getProfile).not.toHaveBeenCalled();
  });

  it("400 for an unknown site, 400 for no site at all", async () => {
    expect((await patch("p1", { ...editBody(), siteId: "site-nope" })).status).toBe(400);
    expect((await patch("p1", { ...editBody(), siteId: "" })).status).toBe(400);
    expect((await get("p1")).status).toBe(400);
  });
});

describe("whitelist at the boundary", () => {
  it("drops an unexpected key and never passes it to the service", async () => {
    const res = await patch("p1", editBody({ email_address: "a.turing@example.co.uk", id: "999", site_id: "site-ng" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dropped.sort()).toEqual(["id", "site_id"]);
    const sent = h.applyProfileEdit.mock.calls[0][0].changes;
    expect(sent).toEqual({ email_address: "a.turing@example.co.uk" });
  });

  it("400 with per-field messages when a value is invalid", async () => {
    const res = await patch("p1", editBody({ email_address: "nope", gender: "male" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fields.email_address).toBeTruthy();
    expect(body.fields.gender).toBeTruthy();
    expect(h.applyProfileEdit).not.toHaveBeenCalled();
  });

  it("400 when the body carries no editable field at all", async () => {
    const res = await patch("p1", editBody({ id: "999" }));
    expect(res.status).toBe(400);
    expect(h.applyProfileEdit).not.toHaveBeenCalled();
  });

  it("400 for an unreadable body", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/patients/p1/profile", { method: "PATCH", body: "{oops" }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("outcomes are mapped to honest status codes", () => {
  it("503 and a plain message when patient editing is switched off", async () => {
    h.applyProfileEdit.mockResolvedValue({
      ok: false,
      code: "write_disabled",
      message: "Patient editing is switched off.",
    });
    const res = await patch("p1", editBody());
    expect(res.status).toBe(503);
    expect((await res.json()).message).toContain("switched off");
  });

  it("409 with the colliding fields on a concurrent edit", async () => {
    h.applyProfileEdit.mockResolvedValue({
      ok: false,
      code: "conflict",
      conflicts: ["email_address"],
      message: "This record changed while you were editing it.",
    });
    const res = await patch("p1", editBody());
    expect(res.status).toBe(409);
    expect((await res.json()).conflicts).toEqual(["email_address"]);
  });

  it("502 when Dentally refused the write", async () => {
    h.applyProfileEdit.mockResolvedValue({ ok: false, code: "dentally_failed", message: "Dentally refused that." });
    expect((await patch("p1", editBody())).status).toBe(502);
  });

  it("404 when the record could not be read from Dentally", async () => {
    h.applyProfileEdit.mockResolvedValue({ ok: false, code: "not_found", message: "not found" });
    expect((await patch("p1", editBody())).status).toBe(404);
  });

  it("500 rather than a half-truth when the service throws", async () => {
    h.applyProfileEdit.mockRejectedValue(new Error("boom"));
    expect((await patch("p1", editBody())).status).toBe(500);
  });
});

describe("GET", () => {
  it("returns the current values, the edit history and whether editing is on", async () => {
    h.listProfileAudit.mockResolvedValue([{ id: "a1", field: "mobile_phone" }]);
    const res = await get("p1", "site-cc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.first_name).toBe("Alan");
    expect(body.audit).toHaveLength(1);
    expect(body.editingEnabled).toBe(true);
    expect(h.listProfileAudit).toHaveBeenCalledWith("site-cc", "p1", 20);
  });

  it("reports editing as off when the Dentally write gate is shut", async () => {
    h.writeEnabled = false;
    expect((await (await get("p1", "site-cc")).json()).editingEnabled).toBe(false);
  });

  it("404 when the patient has no readable record", async () => {
    h.getProfile.mockResolvedValue(null);
    expect((await get("p1", "site-cc")).status).toBe(404);
  });
});
