import { describe, it, expect, vi, beforeEach } from "vitest";
import { APPROVER_ROLES } from "@/lib/absence/rules";

// ===========================================================================
// POST /api/staff-check-in/adjust — writing an attendance entry by hand.
//
// The clocking route stamps the SERVER clock and has no self-service anything to
// argue about. This one is the opposite: an explicit `occurredAt`, on somebody
// ELSE's pay-relevant record, after the fact. So the properties that matter are
// the ones that keep the log honest rather than the ones that keep it convenient:
//
//   * there is NO "resolve from my session" path — a correction is by definition
//     about somebody else, and a route that defaulted to the caller would be a
//     quiet way to write your own hours;
//   * a REASON is mandatory and is stored WITH the entry;
//   * the entry is marked `source: "admin"`, so the log distinguishes what
//     happened from what was written down later;
//   * the pure rule (`validateAdjustment`) decides, and its refusal is a 409 that
//     writes nothing.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  getStaff: vi.fn(),
  listEvents: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
  getSites: () => [{ id: "site-n15", name: "N15" }],
}));

vi.mock("@/lib/auth/guard", async () => {
  const { APPROVER_ROLES: ROLES } = await import("@/lib/absence/rules");
  return {
    requireUser: h.requireUser,
    requireClientAccess: () => null,
    requireSiteAccess: () => null,
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

vi.mock("@/lib/rota/repository", () => ({ getStaff: h.getStaff }));
vi.mock("@/lib/clock/repository", () => ({ listEvents: h.listEvents, recordEvent: h.recordEvent }));

import { POST } from "./route";

const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };
const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };

/** An hour ago, so nothing here depends on the wall clock of the machine. */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/staff-check-in/adjust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: "vitality", ...body }),
    }),
  );
}

const VALID = {
  staffId: "staff-1",
  kind: "in",
  occurredAt: hoursAgo(3),
  reason: "Amina forgot to tap in when she arrived at 8",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(MANAGER);
  h.requireCapability.mockResolvedValue(null);
  h.getStaff.mockResolvedValue({ id: "staff-1", name: "Amina", siteId: "site-n15", active: true });
  h.listEvents.mockResolvedValue({ ready: true, events: [] });
  h.recordEvent.mockImplementation(async (input: Record<string, unknown>) => ({ id: "evt-1", ...input }));
});

describe("only an approver may write somebody's attendance by hand", () => {
  it("refuses the staff role and the clinician", async () => {
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      expect((await post({ ...VALID })).status, `${user.role}`).toBe(403);
    }
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  // NOT ASSERTED, AND DELIBERATELY NOT ASSERTED THE OTHER WAY EITHER:
  // this route carries NO `requireCapability`. Its sibling POST /api/staff-check-in
  // gates the same act — recording an attendance event for somebody else — on
  // `people.clock.record-for-other`, which IS in the catalog and IS enforced there.
  // So revoking that key from a named manager stops them tapping a colleague in and
  // does not stop them writing a backdated entry here, which is the stronger power
  // of the two. Raised for a decision rather than fixed inside a test-writing pass,
  // and left unpinned rather than pinned to today's weaker behaviour — a test that
  // asserted "no capability is asked for" would bless the gap. The fix, if taken, is
  // one line beside the role guard.
});

describe("the entry cannot be vague, and cannot be about nobody", () => {
  it("REQUIRES an explicit staffId — there is no 'me' shortcut on this route", async () => {
    const { staffId: _omitted, ...withoutStaff } = VALID;
    const res = await post(withoutStaff);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("staffId");
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("REQUIRES a reason, and says why", async () => {
    const { reason: _omitted, ...withoutReason } = VALID;
    const res = await post(withoutReason);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("reason");
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("REQUIRES an occurredAt, and refuses one it cannot read", async () => {
    const { occurredAt: _omitted, ...withoutTime } = VALID;
    expect((await post(withoutTime)).status).toBe(400);
    expect((await post({ ...VALID, occurredAt: "some time yesterday" })).status).toBe(400);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("refuses a kind that is neither in nor out", async () => {
    expect((await post({ ...VALID, kind: "lunch" })).status).toBe(400);
  });

  it("refuses a staff member who is not this practice's", async () => {
    h.getStaff.mockResolvedValue(null);
    expect((await post({ ...VALID })).status).toBe(404);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("refuses a site id that is not one of this practice's", async () => {
    const res = await post({ ...VALID, siteId: "site-somewhere-else" });
    expect(res.status).toBe(400);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });
});

describe("what gets written is what an employment dispute would ask for", () => {
  it("stores the explicit time, the reason, source 'admin' and who recorded it", async () => {
    const res = await post({ ...VALID });
    expect(res.status).toBe(201);
    expect(h.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: "staff-1",
        kind: "in",
        occurredAt: new Date(Date.parse(VALID.occurredAt)).toISOString(),
        source: "admin",
        recordedBy: "u-mgr",
        note: VALID.reason,
      }),
    );
  });

  it("refuses with a 409 when the pure rule says the correction is not legal", async () => {
    // Already clocked in an hour before the correction: `validateAdjustment` refuses
    // a second arrival, and the route does not second-guess it.
    h.listEvents.mockResolvedValue({
      ready: true,
      events: [
        { id: "e1", staffId: "staff-1", kind: "in", occurredAt: hoursAgo(4), source: "manual" },
      ],
    });
    const res = await post({ ...VALID });
    expect(res.status).toBe(409);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it("says clocking is not switched on rather than writing into a table that is not there", async () => {
    h.listEvents.mockResolvedValue({ ready: false, events: [] });
    const res = await post({ ...VALID });
    expect(res.status).toBe(503);
    expect(h.recordEvent).not.toHaveBeenCalled();
  });
});

describe("the double is honest", () => {
  it("the stand-in approver guard is driven by the REAL role list", () => {
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
  });
});
