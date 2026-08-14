import { describe, it, expect, vi, beforeEach } from "vitest";
import { canRoleAccessModule } from "@/lib/nav";

// ===========================================================================
// GET / PATCH /api/hr/profile — the employee file itself.
//
// The most sensitive table in the platform: dates of birth, home addresses, an
// NI fragment, pay. So the three claims worth pinning are about what NEVER leaves
// the server and who may write:
//
//   * PAY IS OMITTED SERVER-SIDE. Without `hr.view-pay` the rate table is not
//     read and the `pay` key is never created — absent, not null.
//   * WRITING IS OWNER-LEVEL. Reading the file is the practice manager's job;
//     changing somebody's recorded date of birth is not.
//   * THE FULL NI NUMBER IS NOT STORABLE. Four characters reconcile a payroll
//     export and are useless alone; the route refuses more, in front of the
//     column's own constraint.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  hasCapability: vi.fn(),
  listStaff: vi.fn(),
  getStaff: vi.fn(),
  listHrProfiles: vi.fn(),
  listPayRates: vi.fn(),
  upsertHrProfile: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/auth/guard", async () => {
  const { canRoleAccessModule: can } = await import("@/lib/nav");
  const { APPROVER_ROLES } = await import("@/lib/absence/rules");
  const forbidden = () => Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  return {
    requireUser: h.requireUser,
    requireClientAccess: () => null,
    requireModuleApiAccess: (user: { role: string } | null, slug: string) =>
      user && !can(user.role as never, slug) ? forbidden() : null,
    requireApproverRole: (user: { role: string } | null) =>
      user && !(APPROVER_ROLES as readonly string[]).includes(user.role) ? forbidden() : null,
    requireOwnerRole: (user: { role: string } | null) =>
      user && !["agency_admin", "client_owner"].includes(user.role) ? forbidden() : null,
  };
});

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: h.hasCapability,
}));

vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({ isAllSites: false, siteIds: ["site-n15"], label: "N15" }),
}));

vi.mock("@/lib/rota/repository", () => ({ listStaff: h.listStaff, getStaff: h.getStaff }));
vi.mock("@/lib/hr/repository", () => ({
  listHrProfiles: h.listHrProfiles,
  listPayRates: h.listPayRates,
  upsertHrProfile: h.upsertHrProfile,
}));

import { GET, PATCH } from "./route";

const OWNER = { id: "u-own", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: ["site-n15"] };
const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };
const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };

const STAFF = {
  id: "staff-1",
  name: "Amina",
  role: "nurse",
  siteId: "site-n15",
  active: true,
  availability: {},
};

function get(query = "client=vitality") {
  return GET(new Request(`http://localhost/api/hr/profile?${query}`));
}

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request("http://localhost/api/hr/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: "vitality", staffId: "staff-1", ...body }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(OWNER);
  h.hasCapability.mockResolvedValue(true);
  h.listStaff.mockResolvedValue([STAFF]);
  h.getStaff.mockResolvedValue(STAFF);
  h.listHrProfiles.mockResolvedValue({ ready: true, profiles: new Map() });
  h.listPayRates.mockResolvedValue({
    ready: true,
    rates: [{ staffId: "staff-1", hourlyPence: 1500, effectiveFrom: "2026-01-01", effectiveTo: null }],
  });
  h.upsertHrProfile.mockImplementation(async (_client: string, staffId: string, fields: unknown) => ({
    staffId,
    ...(fields as Record<string, unknown>),
  }));
});

describe("the employee file is not a surface for the people it is about", () => {
  it("refuses the staff role and the clinician on both methods", async () => {
    expect(canRoleAccessModule("client_staff", "staff-hr")).toBe(false);
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      expect((await get()).status, `${user.role} GET`).toBe(403);
      expect((await patch({ dateOfBirth: "1990-01-01" })).status, `${user.role} PATCH`).toBe(403);
    }
    expect(h.listHrProfiles).not.toHaveBeenCalled();
    expect(h.upsertHrProfile).not.toHaveBeenCalled();
  });
});

describe("pay is OMITTED SERVER-SIDE from the file, not stripped on the way out", () => {
  it("never reads the rate table without hr.view-pay", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.hasCapability.mockResolvedValue(false);
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(h.listPayRates).not.toHaveBeenCalled();
    expect(body.includesPay).toBe(false);
    // ABSENT, not null: the key is only ever created when the caller may see it.
    expect(Object.keys(body.people[0])).not.toContain("pay");
  });

  it("reads it, and prices the day, for a caller who holds the key", async () => {
    const body = await (await get()).json();
    expect(h.listPayRates).toHaveBeenCalledWith("vitality", ["staff-1"]);
    expect(body.includesPay).toBe(true);
    expect(body.people[0].pay.currentPence).toBe(1500);
  });

  it("tells the screen whether it may offer editing, without that being the lock", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    expect((await (await get()).json()).canEdit).toBe(false);
    h.requireUser.mockResolvedValue(OWNER);
    expect((await (await get()).json()).canEdit).toBe(true);
  });

  it("says 'not set up' rather than rendering an empty team", async () => {
    h.listHrProfiles.mockResolvedValue({ ready: false, profiles: new Map() });
    const body = await (await get()).json();
    expect(body.ready).toBe(false);
  });
});

describe("PATCH: writing the file is owner-level, and the fields are policed", () => {
  it("THE PRACTICE MANAGER MAY READ IT AND MAY NOT WRITE IT", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    expect((await get()).status).toBe(200);
    expect((await patch({ dateOfBirth: "1990-01-01" })).status).toBe(403);
    expect(h.upsertHrProfile).not.toHaveBeenCalled();
  });

  it("REFUSES MORE THAN FOUR CHARACTERS OF AN NI NUMBER", async () => {
    const res = await patch({ niNumberLast4: "QQ123456C" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("last four");
    expect(h.upsertHrProfile).not.toHaveBeenCalled();
  });

  it("refuses a date that is not a date, and a leaving date before the start", async () => {
    expect((await patch({ dateOfBirth: "01/01/1990" })).status).toBe(400);
    expect(
      (await patch({ employmentStart: "2026-06-01", employmentEnd: "2026-05-01" })).status,
    ).toBe(400);
    expect(h.upsertHrProfile).not.toHaveBeenCalled();
  });

  it("refuses out-of-range contracted days and entitlement overrides", async () => {
    expect((await patch({ contractedDaysPerWeek: 9 })).status).toBe(400);
    expect((await patch({ entitlementDaysOverride: 400 })).status).toBe(400);
    expect((await patch({ leaveYearStartMonth: 13 })).status).toBe(400);
  });

  it("proves the staff member is this practice's before writing anything", async () => {
    h.getStaff.mockResolvedValue(null);
    const res = await patch({ dateOfBirth: "1990-01-01" });
    expect(res.status).toBe(404);
    expect(h.upsertHrProfile).not.toHaveBeenCalled();
  });

  it("stores a valid change", async () => {
    const res = await patch({ dateOfBirth: "1990-01-01", niNumberLast4: "123C" });
    expect(res.status).toBe(200);
    expect(h.upsertHrProfile).toHaveBeenCalledWith(
      "vitality",
      "staff-1",
      expect.objectContaining({ dateOfBirth: "1990-01-01", niNumberLast4: "123C" }),
      expect.anything(),
    );
  });
});
