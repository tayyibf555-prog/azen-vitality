import { describe, it, expect, vi, beforeEach } from "vitest";
import { APPROVER_ROLES } from "@/lib/absence/rules";
import { linkMissingCopy } from "@/lib/my-work/rules";

// ===========================================================================
// GET /api/rota/shifts — two callers, and the second one is the whole reason
// the fifth role exists.
//
//   MANAGER   ?client=&from=&to=          approver + rota.view, site-scoped.
//   SELF      ?client=&from=&to=&mine=1   the caller's own PUBLISHED shifts.
//
// The self branch has NO role guard and NO capability, because both refuse
// `client_staff`. What is under test is therefore not the happy path but the
// three properties that stand in their place:
//
//   * the staff id is the SESSION's, and a `staffId` in the query is not read;
//   * the narrowing happens AT THE QUERY, not in the response;
//   * only PUBLISHED shifts are asked for, so a draft week can never reach the
//     person who would have to work it.
//
// `requireApproverRole` is reimplemented from the REAL, IMPORTED `APPROVER_ROLES`
// (the /api/absence test's pattern): importing the actual guard would drag
// server-only Supabase plumbing into a node test, and hard-coding the role list
// would let this file keep passing after the real one changed.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  findStaffByAppUser: vi.fn(),
  listShifts: vi.fn(),
  listStaff: vi.fn(),
  getConfig: vi.fn(),
  createManualShift: vi.fn(),
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
  getViewScope: async () => ({ isAllSites: false, siteIds: ["site-n15"], label: "N15", siteName: "N15" }),
}));

// The self-service seam is REAL here, not stubbed: "the staff row comes from the
// session" is the property under test, and stubbing the function that enforces it
// would leave nothing behind.
vi.mock("@/lib/clock/repository", () => ({ findStaffByAppUser: h.findStaffByAppUser }));

vi.mock("@/lib/rota/repository", () => ({
  listShifts: h.listShifts,
  listStaff: h.listStaff,
  getConfig: h.getConfig,
  createManualShift: h.createManualShift,
}));
vi.mock("@/lib/absence/repository", () => ({ listApprovedAbsence: h.listApprovedAbsence }));

import { GET, POST } from "./route";

const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };
const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };

const MY_STAFF = { id: "staff-1", name: "Amina", role: "nurse", siteId: "site-n15" };

/** A day key n days from now, so nothing in this file can become a time bomb. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

const FROM = day(0);
const TO = day(27);

function shift(over: Record<string, unknown> = {}) {
  return {
    id: "shift-1",
    clientId: "vitality",
    siteId: "site-n15",
    staffId: "staff-1",
    shiftDate: FROM,
    startTime: "09:00",
    endTime: "17:00",
    role: "nurse",
    status: "scheduled",
    publishedAt: "2026-08-10T09:00:00.000Z",
    publishedVersion: 2,
    ...over,
  };
}

function get(query: string) {
  return GET(new Request(`http://localhost/api/rota/shifts?${query}`));
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/rota/shifts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(NURSE);
  h.requireCapability.mockResolvedValue(null);
  h.findStaffByAppUser.mockResolvedValue(MY_STAFF);
  h.listShifts.mockResolvedValue([shift()]);
  h.listStaff.mockResolvedValue([{ id: "staff-1", name: "Amina" }, { id: "staff-2", name: "Bea" }]);
  h.getConfig.mockResolvedValue({});
  h.listApprovedAbsence.mockResolvedValue([]);
});

describe("the double is honest", () => {
  it("the stand-in approver guard is driven by the REAL role list", () => {
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
    expect(APPROVER_ROLES).not.toContain("client_staff");
    expect(APPROVER_ROLES).not.toContain("client_clinician");
  });
});

describe("mine=1: the caller's own published shifts, narrowed at the query", () => {
  it("asks the database for the SESSION's staff id and for published rows only", async () => {
    const res = await get(`client=vitality&from=${FROM}&to=${TO}&mine=1`);
    expect(res.status).toBe(200);
    expect(h.listShifts).toHaveBeenCalledWith(
      "vitality",
      FROM,
      TO,
      expect.objectContaining({ staffIds: ["staff-1"], publishedOnly: true }),
    );
    expect(h.findStaffByAppUser).toHaveBeenCalledWith("vitality", "u-nurse");
  });

  it("IGNORES a staffId in the query, so a filter is not an access bypass", async () => {
    await get(`client=vitality&from=${FROM}&to=${TO}&mine=1&staffId=staff-2`);
    expect(h.listShifts).toHaveBeenCalledWith(
      "vitality",
      FROM,
      TO,
      expect.objectContaining({ staffIds: ["staff-1"] }),
    );
    expect(h.listShifts).not.toHaveBeenCalledWith(
      "vitality",
      FROM,
      TO,
      expect.objectContaining({ staffIds: ["staff-2"] }),
    );
  });

  it("A NURSE GETS AN ANSWER AT ALL — the branch skips the guards that refuse her", async () => {
    // The bug this whole seam was built for: every guard on the manager read
    // (approver role, rota.view) refuses `client_staff`, so before `mine=1` the My
    // rota tab 403'd for the only role it exists for.
    const res = await get(`client=vitality&from=${FROM}&to=${TO}&mine=1`);
    expect(res.status).toBe(200);
    expect((await res.json()).mine).toBe(true);
    // The capability is NOT consulted on this branch: a nurse holds no rota.view,
    // and asking for one would 403 her out of her own rota.
    expect(h.requireCapability).not.toHaveBeenCalled();
  });

  it("the clinician reaches it too, through the same branch", async () => {
    h.requireUser.mockResolvedValue(CLINICIAN);
    expect((await get(`client=vitality&from=${FROM}&to=${TO}&mine=1`)).status).toBe(200);
  });

  it("hands back no staff list, no config and no absence: none of it is theirs", async () => {
    const body = await (await get(`client=vitality&from=${FROM}&to=${TO}&mine=1`)).json();
    expect(body.staff).toBeUndefined();
    expect(body.config).toBeUndefined();
    expect(body.absences).toBeUndefined();
    expect(h.listStaff).not.toHaveBeenCalled();
  });

  it("says the login is not linked, in the practice's own words, rather than answering []", async () => {
    h.findStaffByAppUser.mockResolvedValue(null);
    const res = await get(`client=vitality&from=${FROM}&to=${TO}&mine=1`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(linkMissingCopy("there are no shifts to show"));
    // ...and it does not go near the rota for somebody it cannot identify.
    expect(h.listShifts).not.toHaveBeenCalled();
  });

  it("still bounds the window: the self branch is not a way round the 62-day cap", async () => {
    const wide = await get(`client=vitality&from=${FROM}&to=${day(400)}&mine=1`);
    expect(wide.status).toBe(400);
    expect(h.listShifts).not.toHaveBeenCalled();

    const malformed = await get(`client=vitality&from=not-a-date&to=${TO}&mine=1`);
    expect(malformed.status).toBe(400);
  });

  it("only mine=1 takes the branch: mine=0 is a manager read and is refused for a nurse", async () => {
    const res = await get(`client=vitality&from=${FROM}&to=${TO}&mine=0`);
    expect(res.status).toBe(403);
    expect(h.listShifts).not.toHaveBeenCalled();
  });
});

describe("the manager read is unchanged", () => {
  it("refuses the staff role and the clinician outright", async () => {
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      const res = await get(`client=vitality&from=${FROM}&to=${TO}`);
      expect(res.status, `${user.role} must be refused the whole rota`).toBe(403);
    }
  });

  it("gives an approver the whole site-scoped week, with staff, config and absence", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    const body = await (await get(`client=vitality&from=${FROM}&to=${TO}`)).json();
    expect(body.ok).toBe(true);
    expect(body.staff).toHaveLength(2);
    expect(h.listShifts).toHaveBeenCalledWith("vitality", FROM, TO, { siteIds: ["site-n15"] });
    // And it is NOT published-only: a manager edits the draft, which is the point.
    expect(h.listShifts).not.toHaveBeenCalledWith(
      "vitality",
      FROM,
      TO,
      expect.objectContaining({ publishedOnly: true }),
    );
    expect(h.requireCapability).toHaveBeenCalledWith(MANAGER, "rota.view");
  });

  it("survives an absence read that fails, because absence is a garnish not a precondition", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.listApprovedAbsence.mockRejectedValue(new Error("0067 not applied"));
    const res = await get(`client=vitality&from=${FROM}&to=${TO}`);
    expect(res.status).toBe(200);
    expect((await res.json()).absences).toEqual([]);
  });

  it("an unknown practice is a 404, not a read against an invented client id", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    expect((await get(`client=nope&from=${FROM}&to=${TO}`)).status).toBe(404);
    expect(h.listShifts).not.toHaveBeenCalled();
  });
});

describe("POST: creating one shift by hand stays the approver's act", () => {
  const valid = {
    clientSlug: "vitality",
    siteId: "site-n15",
    staffId: "staff-1",
    shiftDate: day(3),
    startTime: "09:00",
    endTime: "17:00",
    role: "nurse",
  };

  it("refuses the staff role and the clinician", async () => {
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      expect((await post(valid)).status, `${user.role} must not write the rota`).toBe(403);
    }
    expect(h.createManualShift).not.toHaveBeenCalled();
  });

  it("mine=1 is a READ contract: it buys no write access", async () => {
    // The self branch exists on GET only. A staff login POSTing with mine in the
    // body or the query is still refused by the role guard.
    h.requireUser.mockResolvedValue(NURSE);
    const res = await POST(
      new Request("http://localhost/api/rota/shifts?mine=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...valid, mine: 1 }),
      }),
    );
    expect(res.status).toBe(403);
    expect(h.createManualShift).not.toHaveBeenCalled();
  });

  // ONE ASSERTION SHORT OF NOTHING. Asserting that `requireCapability` was CALLED
  // proves the line exists, not that its answer is honoured; deleting
  // `if (capDenied) return capDenied;` left every test above green. These give the
  // mocked guard a real 403 and check the route stops.
  it("HONOURS a refusal from rota.edit, and creates nothing", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.requireCapability.mockResolvedValue(
      Response.json({ ok: false, error: "forbidden" }, { status: 403 }),
    );
    const res = await post(valid);
    expect(res.status).toBe(403);
    expect(h.createManualShift).not.toHaveBeenCalled();
    // ...and it stops BEFORE the reads, not after them.
    expect(h.listStaff).not.toHaveBeenCalled();
  });

  it("PROVES TENANCY before it believes a staff id", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    const res = await post({ ...valid, staffId: "staff-from-another-practice" });
    expect(res.status).toBe(404);
    expect(h.createManualShift).not.toHaveBeenCalled();
  });

  it("refuses a site the caller is not viewing", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    const res = await post({ ...valid, siteId: "site-cc" });
    expect(res.status).toBe(400);
    expect(h.createManualShift).not.toHaveBeenCalled();
  });

  it("creates the shift when the rules allow it, and reports warnings WITH the success", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.listShifts.mockResolvedValue([]);
    h.createManualShift.mockImplementation(async (input: Record<string, unknown>) => ({ id: "new-1", ...input }));
    const res = await post(valid);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // An EMPTY array satisfies `Array.isArray`, and the case above deliberately
    // gives the rules nothing to fire on — so the two cases below are what
    // actually prove the route consults `validateShiftEdit` at all.
    expect(body.warnings).toEqual([]);
    expect(h.createManualShift).toHaveBeenCalledWith(expect.objectContaining({ staffId: "staff-1" }));
  });

  // THE REFUSAL. The route's only use of the rules is a 400 branch and a warnings
  // array, and neither was executed: the happy path above sets `listShifts` to []
  // so no rule can fire. Deleting the whole `if (!validation.ok)` block kept the
  // suite green. The sibling PATCH route has had this since day one
  // (shift-route.test.ts: "returns the rules' own message when the edit is
  // invalid, and writes nothing").
  it("REFUSES an edit the rules reject, in the rules' own words, and writes nothing", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    // Amina is already working 09:00-17:00 that day.
    h.listShifts.mockResolvedValue([
      shift({ id: "existing", staffId: "staff-1", shiftDate: valid.shiftDate }),
    ]);

    const res = await post(valid);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.issues.map((i: { code: string }) => i.code)).toContain("double-booked");
    // The message is the RULES' message, not one the route invented.
    expect(body.error).toBe(
      "That person is already working at that time, so they cannot take this shift too.",
    );
    expect(h.createManualShift).not.toHaveBeenCalled();
  });

  it("still CREATES on a warning, and hands the warning back with the shift", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.listShifts.mockResolvedValue([]);
    h.listApprovedAbsence.mockResolvedValue([
      {
        id: "abs-1",
        clientId: "vitality",
        siteId: null,
        staffId: "staff-1",
        kind: "holiday",
        status: "approved",
        startDate: valid.shiftDate,
        endDate: valid.shiftDate,
        note: null,
        requestedBy: null,
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      },
    ]);
    h.createManualShift.mockImplementation(async (input: Record<string, unknown>) => ({ id: "new-1", ...input }));

    const res = await post(valid);
    // Somebody being off is a thing to SAY, not a thing to refuse: the practice is
    // short and the manager is asking them in anyway.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warnings.map((w: { code: string }) => w.code)).toEqual(["on-approved-absence"]);
    expect(h.createManualShift).toHaveBeenCalledTimes(1);
  });
});
