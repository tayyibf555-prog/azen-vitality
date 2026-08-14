// The self-service half of /api/absence, which is the half that did not exist.
//
// Before this change both methods called `requireApproverRole` across the door,
// so `client_clinician` — a role that CAN open the Holiday page, because
// "absence" is in CLINICIAN_SLUGS — got a 403 from every call the page made. The
// page rendered and did nothing, and `canRequest`'s self-request branch was
// unreachable. `client_staff` would have inherited exactly the same dead surface.
//
// WHAT IS ACTUALLY UNDER TEST HERE is the security claim, not the happy path:
//
//   * a non-approver's list is narrowed AT THE QUERY to the staff id resolved
//     from their SESSION, so a direct call returns no more than their page;
//   * a non-approver's `staffId` — in the query string or in the body — is not
//     read at all, so there is nothing to spoof;
//   * a non-approver may cancel their OWN request and nobody else's, and a
//     foreign absence id answers 404 rather than 403, so the endpoint is not an
//     existence oracle over the practice's absence table;
//   * approve and refuse are untouched: still approver-only.
//
// `requireApproverRole` is reimplemented from the REAL, IMPORTED `APPROVER_ROLES`
// rather than stubbed to a fixed answer — importing the actual guard would drag
// server-only Supabase plumbing into a node test, and hard-coding the role list
// would let this file keep passing after the real one changed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { APPROVER_ROLES } from "@/lib/absence/rules";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  findStaffByAppUser: vi.fn(),
  listAbsence: vi.fn(),
  createAbsence: vi.fn(),
  getAbsence: vi.fn(),
  cancelAbsence: vi.fn(),
  decideAbsence: vi.fn(),
  listStaff: vi.fn(),
  getStaff: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/auth/guard", async () => {
  const { APPROVER_ROLES: ROLES } = await import("@/lib/absence/rules");
  return {
    requireUser: h.requireUser,
    requireClientAccess: () => null,
    requireApproverRole: (user: { role: string } | null) =>
      user && !(ROLES as readonly string[]).includes(user.role)
        ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
        : null,
  };
});

// The per-person gate is stubbed open: its own behaviour is proven in
// src/lib/auth/capability-guard.test.ts, and the fs sweep in
// destructive-route-capability-coverage.test.ts proves these routes call it.
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));

vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({ isAllSites: true, siteIds: ["site-n15"], label: "All sites", siteName: null }),
}));

vi.mock("@/lib/rota/repository", () => ({ listStaff: h.listStaff, getStaff: h.getStaff }));
vi.mock("@/lib/clock/repository", () => ({ findStaffByAppUser: h.findStaffByAppUser }));
vi.mock("@/lib/absence/repository", () => ({
  listAbsence: h.listAbsence,
  createAbsence: h.createAbsence,
  getAbsence: h.getAbsence,
  cancelAbsence: h.cancelAbsence,
  decideAbsence: h.decideAbsence,
}));

import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";

const OWNER = { id: "u-owner", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: ["site-n15"] };
const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };
const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };

const MY_STAFF = { id: "staff-1", name: "Amina", role: "nurse", siteId: "site-n15" };

/** A day key n days from now, so no test in this file can become a time bomb. */
function futureDay(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function absenceRow(over: Record<string, unknown> = {}) {
  return {
    id: "abs-1",
    clientId: "vitality",
    siteId: "site-n15",
    staffId: "staff-1",
    kind: "holiday",
    startDate: futureDay(10),
    endDate: futureDay(12),
    status: "pending",
    note: null,
    requestedBy: "u-nurse",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...over,
  };
}

function get(query: string) {
  return GET(new Request(`http://localhost/api/absence?${query}`));
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/absence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function patch(id: string, body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/absence/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(NURSE);
  h.findStaffByAppUser.mockResolvedValue(MY_STAFF);
  h.listAbsence.mockResolvedValue([]);
  h.listStaff.mockResolvedValue([{ id: "staff-1", name: "Amina" }, { id: "staff-2", name: "Bea" }]);
  h.getStaff.mockResolvedValue({ id: "staff-1", name: "Amina", siteId: "site-n15", active: true });
  h.createAbsence.mockImplementation(async (input: Record<string, unknown>) => absenceRow(input));
  h.getAbsence.mockResolvedValue(absenceRow());
  h.cancelAbsence.mockResolvedValue(true);
  h.decideAbsence.mockResolvedValue(true);
});

describe("the double is honest", () => {
  it("the stand-in approver guard is driven by the REAL role list", () => {
    // If `APPROVER_ROLES` ever gains a role, every 403 asserted below changes
    // meaning — so the list is imported and pinned here rather than assumed.
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
    expect(APPROVER_ROLES).not.toContain("client_staff");
    expect(APPROVER_ROLES).not.toContain("client_clinician");
  });
});

describe("GET: a non-approver is narrowed to their own rows AT THE QUERY", () => {
  it("asks the database only for the session's own staff id", async () => {
    const res = await get("client=vitality");
    expect(res.status).toBe(200);
    expect(h.listAbsence).toHaveBeenCalledWith("vitality", expect.objectContaining({ staffId: "staff-1" }));
  });

  it("IGNORES a staffId in the query string, so a filter is not an access bypass", async () => {
    await get("client=vitality&staffId=staff-2");
    expect(h.listAbsence).toHaveBeenCalledWith("vitality", expect.objectContaining({ staffId: "staff-1" }));
    expect(h.listAbsence).not.toHaveBeenCalledWith("vitality", expect.objectContaining({ staffId: "staff-2" }));
  });

  it("never hands a non-approver the rest of the team", async () => {
    const body = await (await get("client=vitality")).json();
    expect(body.canManage).toBe(false);
    expect(body.staff.map((s: { id: string }) => s.id)).toEqual(["staff-1"]);
  });

  it("says the login is not linked rather than answering with an empty list", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await get("client=vitality");
    const body = await res.json();
    expect(res.status).toBe(200);
    // linked:false is the honest answer. An empty `absences` with no flag would
    // render as "you have no holiday", which is a different and false statement.
    expect(body.linked).toBe(false);
    expect(body.absences).toEqual([]);
    // And it does not go near the database for somebody it cannot identify.
    expect(h.listAbsence).not.toHaveBeenCalled();
  });

  it("the clinician's Holiday page is no longer a dead surface", async () => {
    h.requireUser.mockResolvedValue(CLINICIAN);
    const res = await get("client=vitality");
    expect(res.status).toBe(200);
    expect((await res.json()).linked).toBe(true);
  });
});

describe("GET: the manager's view is unchanged", () => {
  it("an approver still sees the whole team and may filter by staffId", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    const body = await (await get("client=vitality&staffId=staff-2")).json();
    expect(body.canManage).toBe(true);
    expect(h.listAbsence).toHaveBeenCalledWith("vitality", expect.objectContaining({ staffId: "staff-2" }));
    expect(body.staff).toHaveLength(2);
  });
});

describe("POST: a self-request cannot be posted for anybody else", () => {
  it("files the request against the SESSION's staff id, not the body's", async () => {
    const res = await post({
      clientSlug: "vitality",
      staffId: "staff-2", // somebody else, deliberately
      kind: "holiday",
      startDate: futureDay(10),
      endDate: futureDay(12),
    });
    expect(res.status).toBe(201);
    expect(h.createAbsence).toHaveBeenCalledWith(expect.objectContaining({ staffId: "staff-1" }));
  });

  it("refuses, with the link copy, when the login has no staff record", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await post({
      clientSlug: "vitality",
      kind: "holiday",
      startDate: futureDay(10),
      endDate: futureDay(12),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("not linked to a staff record");
    expect(h.createAbsence).not.toHaveBeenCalled();
  });

  it("lets a clinician file their own, which is what the old guard made impossible", async () => {
    h.requireUser.mockResolvedValue(CLINICIAN);
    const res = await post({
      clientSlug: "vitality",
      kind: "sick",
      startDate: futureDay(1),
      endDate: futureDay(1),
    });
    expect(res.status).toBe(201);
  });

  it("an approver may still record absence for somebody else", async () => {
    h.requireUser.mockResolvedValue(OWNER);
    h.findStaffByAppUser.mockResolvedValue(null); // an owner who is not on the rota
    h.getStaff.mockResolvedValue({ id: "staff-2", name: "Bea", siteId: "site-n15", active: true });
    const res = await post({
      clientSlug: "vitality",
      staffId: "staff-2",
      kind: "holiday",
      startDate: futureDay(10),
      endDate: futureDay(12),
    });
    expect(res.status).toBe(201);
    expect(h.createAbsence).toHaveBeenCalledWith(expect.objectContaining({ staffId: "staff-2" }));
  });
});

describe("PATCH: withdrawing your own request, and nothing else", () => {
  it("a member of staff may withdraw their own pending request", async () => {
    const res = await patch("abs-1", { clientSlug: "vitality", action: "cancel" });
    expect(res.status).toBe(200);
    expect(h.cancelAbsence).toHaveBeenCalledWith("abs-1", "vitality");
  });

  it("SOMEBODY ELSE'S ABSENCE READS AS NOT FOUND, not as forbidden", async () => {
    // A 403 would confirm the id exists, which is an existence oracle over the
    // practice's absence table. It answers 404 and writes nothing.
    h.getAbsence.mockResolvedValue(absenceRow({ id: "abs-9", staffId: "staff-2", requestedBy: "u-other" }));
    const res = await patch("abs-9", { clientSlug: "vitality", action: "cancel" });
    expect(res.status).toBe(404);
    expect(h.cancelAbsence).not.toHaveBeenCalled();
  });

  it("cannot withdraw a request an unlinked login could not have raised", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await patch("abs-1", { clientSlug: "vitality", action: "cancel" });
    expect(res.status).toBe(404);
    expect(h.cancelAbsence).not.toHaveBeenCalled();
  });

  it("cannot withdraw somebody else's request that happens to be on their own row", async () => {
    // The row is theirs, but the manager raised it, so `canCancel` says no —
    // the pure rule decides, and this route does not second-guess it.
    h.getAbsence.mockResolvedValue(absenceRow({ requestedBy: "u-mgr" }));
    const res = await patch("abs-1", { clientSlug: "vitality", action: "cancel" });
    expect(res.status).toBe(403);
    expect(h.cancelAbsence).not.toHaveBeenCalled();
  });

  it("APPROVE AND REFUSE STAY APPROVER-ONLY", async () => {
    for (const action of ["approve", "refuse"]) {
      const res = await patch("abs-1", { clientSlug: "vitality", action });
      expect(res.status, `${action} must be refused for client_staff`).toBe(403);
      // Refused BY THE ROLE GUARD, at the door, not merely by `canDecide`
      // downstream. The distinction is the whole point of the fork: `canDecide`
      // would also refuse here (it always refuses a non-approver), so asserting
      // only the status would let the guard be removed without a test noticing.
      // The guard's answer is the bare token; the rule's is a sentence.
      expect(await res.json(), `${action} must be stopped by the role guard`).toEqual({
        ok: false,
        error: "forbidden",
      });
    }
    expect(h.decideAbsence).not.toHaveBeenCalled();
  });

  it("a clinician cannot approve either", async () => {
    h.requireUser.mockResolvedValue(CLINICIAN);
    expect((await patch("abs-1", { clientSlug: "vitality", action: "approve" })).status).toBe(403);
  });

  it("an approver still approves, and still cannot approve their own", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    expect((await patch("abs-1", { clientSlug: "vitality", action: "approve" })).status).toBe(200);

    h.getAbsence.mockResolvedValue(absenceRow({ requestedBy: "u-mgr" }));
    expect((await patch("abs-1", { clientSlug: "vitality", action: "approve" })).status).toBe(403);
  });
});
