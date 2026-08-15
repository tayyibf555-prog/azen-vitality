import { describe, it, expect, vi, beforeEach } from "vitest";
import { APPROVER_ROLES } from "@/lib/absence/rules";

// ===========================================================================
// PATCH / DELETE /api/rota/shift/[id] — the two writes that change somebody's
// week after they have already been told about it.
//
// Three properties are the reason this file exists, and none of them is provable
// from `src/lib/rota/edit.test.ts` (which tests the pure rules) or from the two
// platform coverage sweeps (which prove only that SOME guard is present):
//
//   1. DELETE DOES NOT DELETE. It tombstones, because the generator runs every
//      sweep tick and a hard-deleted slot un-deletes itself within the hour.
//   2. A MOVE INVALIDATES THE LAST TEXT. `notificationIsStale` decides, and the
//      route must pass its answer to `updateShift` — a time change re-notifies,
//      a note change must not text the whole team.
//   3. AN ID FROM ANOTHER PRACTICE READS AS ABSENT, so this is not an existence
//      oracle over another practice's rota.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  getShift: vi.fn(),
  listShifts: vi.fn(),
  listStaff: vi.fn(),
  updateShift: vi.fn(),
  tombstoneShift: vi.fn(),
  listApprovedAbsence: vi.fn(),
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

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: h.requireCapability,
  hasCapability: async () => true,
}));

vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({ isAllSites: false, siteIds: ["site-n15"], label: "N15" }),
}));

vi.mock("@/lib/rota/repository", () => ({
  getShift: h.getShift,
  listShifts: h.listShifts,
  listStaff: h.listStaff,
  updateShift: h.updateShift,
  tombstoneShift: h.tombstoneShift,
}));
vi.mock("@/lib/absence/repository", () => ({ listApprovedAbsence: h.listApprovedAbsence }));

import { PATCH, DELETE } from "./route";

const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };
const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

function shift(over: Record<string, unknown> = {}) {
  return {
    id: "shift-1",
    clientId: "vitality",
    siteId: "site-n15",
    staffId: "staff-1",
    shiftDate: day(3),
    startTime: "09:00",
    endTime: "17:00",
    role: "nurse",
    status: "notified",
    origin: "generated",
    pairedStaffId: null,
    note: null,
    publishedAt: "2026-08-01T09:00:00.000Z",
    publishedVersion: 1,
    ...over,
  };
}

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request("http://localhost/api/rota/shift/shift-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: "vitality", ...body }),
    }),
    { params: Promise.resolve({ id: "shift-1" }) },
  );
}

function del(body: Record<string, unknown> = {}) {
  return DELETE(
    new Request("http://localhost/api/rota/shift/shift-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: "vitality", ...body }),
    }),
    { params: Promise.resolve({ id: "shift-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(MANAGER);
  h.requireCapability.mockResolvedValue(null);
  h.getShift.mockResolvedValue(shift());
  h.listShifts.mockResolvedValue([shift()]);
  h.listStaff.mockResolvedValue([{ id: "staff-1", name: "Amina" }, { id: "staff-2", name: "Bea" }]);
  h.updateShift.mockResolvedValue(true);
  h.tombstoneShift.mockResolvedValue(true);
  h.listApprovedAbsence.mockResolvedValue([]);
});

describe("who may edit one shift", () => {
  it("refuses the staff role and the clinician on both methods", async () => {
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      expect((await patch({ startTime: "10:00" })).status, `${user.role} PATCH`).toBe(403);
      expect((await del()).status, `${user.role} DELETE`).toBe(403);
    }
    expect(h.updateShift).not.toHaveBeenCalled();
    expect(h.tombstoneShift).not.toHaveBeenCalled();
  });

  it("asks for rota.edit on both, so an owner can revoke it from one named person", async () => {
    await patch({ startTime: "10:00" });
    expect(h.requireCapability).toHaveBeenCalledWith(MANAGER, "rota.edit");
    await del();
    expect(h.requireCapability).toHaveBeenCalledWith(MANAGER, "rota.edit");
  });

  // ONE ASSERTION SHORT OF NOTHING. Asserting that `requireCapability` was CALLED
  // proves the line exists, not that its answer is honoured; deleting
  // `if (capDenied) return capDenied;` left every test above green. These give the
  // mocked guard a real 403 and check the route stops.
  it("HONOURS a refusal from rota.edit on both methods, and writes nothing", async () => {
    h.requireCapability.mockResolvedValue(
      Response.json({ ok: false, error: "forbidden" }, { status: 403 }),
    );

    expect((await patch({ startTime: "10:00" })).status).toBe(403);
    expect((await del()).status).toBe(403);
    expect(h.updateShift).not.toHaveBeenCalled();
    expect(h.tombstoneShift).not.toHaveBeenCalled();
  });

  it("honours a 503 too, which is what an un-enforced environment answers", async () => {
    // `rota.edit` is destructive, so `requireCapability` refuses outright rather
    // than passing through when sign-in is not configured.
    h.requireCapability.mockResolvedValue(
      Response.json({ ok: false, error: "unavailable" }, { status: 503 }),
    );
    expect((await patch({ startTime: "10:00" })).status).toBe(503);
    expect(h.updateShift).not.toHaveBeenCalled();
  });
});

describe("a shift belonging to another practice reads as absent", () => {
  it("PATCH answers 404 and writes nothing", async () => {
    h.getShift.mockResolvedValue(null);
    expect((await patch({ startTime: "10:00" })).status).toBe(404);
    expect(h.updateShift).not.toHaveBeenCalled();
  });

  it("DELETE answers 404 and tombstones nothing", async () => {
    h.getShift.mockResolvedValue(null);
    expect((await del()).status).toBe(404);
    expect(h.tombstoneShift).not.toHaveBeenCalled();
  });

  it("the read is client-scoped, which is what makes that true", async () => {
    await patch({ startTime: "10:00" });
    expect(h.getShift).toHaveBeenCalledWith("shift-1", "vitality");
  });
});

describe("PATCH: the edit is judged as a RESULT, and re-notification follows from it", () => {
  it("a time change makes the last text stale, and says so", async () => {
    const res = await patch({ startTime: "07:00" });
    expect(res.status).toBe(200);
    expect((await res.json()).reNotify).toBe(true);
    // The stale flag is PASSED THROUGH to the repository, not merely reported: the
    // sweep re-texts from the row, so a response that said "reNotify" while storing
    // "still notified" would tell the screen one thing and the phone another.
    expect(h.updateShift).toHaveBeenCalledWith("shift-1", "vitality", expect.anything(), true);
  });

  it("a note-only change does NOT re-text the team", async () => {
    const res = await patch({ note: "covering reception till 2" });
    expect(res.status).toBe(200);
    expect((await res.json()).reNotify).toBe(false);
    expect(h.updateShift).toHaveBeenCalledWith("shift-1", "vitality", expect.anything(), false);
  });

  it("merges onto what is already there, so an unmentioned field is not blanked", async () => {
    await patch({ note: "note only" });
    expect(h.updateShift).toHaveBeenCalledWith(
      "shift-1",
      "vitality",
      expect.objectContaining({ startTime: "09:00", endTime: "17:00", staffId: "staff-1" }),
      false,
    );
  });

  it("refuses a staff member who is not on this practice's rota", async () => {
    const res = await patch({ staffId: "staff-from-elsewhere" });
    expect(res.status).toBe(404);
    expect(h.updateShift).not.toHaveBeenCalled();
  });

  it("refuses a site the caller is not viewing", async () => {
    const res = await patch({ siteId: "site-cc" });
    expect(res.status).toBe(400);
    expect(h.updateShift).not.toHaveBeenCalled();
  });

  it("returns the rules' own message when the edit is invalid, and writes nothing", async () => {
    const res = await patch({ startTime: "18:00", endTime: "09:00" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(h.updateShift).not.toHaveBeenCalled();
  });
});

describe("DELETE tombstones, because a hard delete un-deletes itself", () => {
  it("calls tombstoneShift and says which one it did", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(h.tombstoneShift).toHaveBeenCalledWith("shift-1", "vitality");
    expect(body.tombstoned).toBe(true);
    // The manager needs to know the person had already been told about this one.
    expect(body.wasPublished).toBe(true);
  });

  it("reports wasPublished false for a shift nobody was ever told about", async () => {
    h.getShift.mockResolvedValue(shift({ publishedAt: null, publishedVersion: null }));
    expect((await (await del()).json()).wasPublished).toBe(false);
  });

  it("a tombstone that did not take is a 404, not a cheerful ok", async () => {
    h.tombstoneShift.mockResolvedValue(false);
    expect((await del()).status).toBe(404);
  });
});

describe("the double is honest", () => {
  it("the stand-in approver guard is driven by the REAL role list", () => {
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
  });
});
