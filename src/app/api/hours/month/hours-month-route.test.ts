import { describe, it, expect, vi, beforeEach } from "vitest";
import { APPROVER_ROLES } from "@/lib/absence/rules";

// ===========================================================================
// GET /api/hours/month — the month's worked hours, and (only sometimes) cost.
//
// THE CLAIM THIS FILE EXISTS TO PROVE: pay is omitted SERVER-SIDE. Not hidden in
// the UI, not nulled in the response — the rate table is never read, and the cost
// keys are never built, for a caller without `hr.view-pay`. "The column is not
// rendered" and "the figure never left the server" look identical on screen and
// are completely different facts in an employment dispute.
//
// Second claim: OMISSION, NOT REFUSAL. A practice manager without the pay key
// still gets the whole month. Refusing the report to hide a column she was never
// shown would take her own screen away, which is why this is `hasCapability` and
// not `requireCapability`.
// ===========================================================================

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireCapability: vi.fn(),
  hasCapability: vi.fn(),
  listStaff: vi.fn(),
  listShifts: vi.fn(),
  listAllEvents: vi.fn(),
  listPayRates: vi.fn(),
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/auth/guard", async () => {
  const { APPROVER_ROLES: ROLES } = await import("@/lib/absence/rules");
  const { canRoleAccessModule } = await import("@/lib/nav");
  const forbidden = () => Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  return {
    requireUser: h.requireUser,
    requireClientAccess: () => null,
    requireModuleApiAccess: (user: { role: string } | null, slug: string) =>
      user && !canRoleAccessModule(user.role as never, slug) ? forbidden() : null,
    requireApproverRole: (user: { role: string } | null) =>
      user && !(ROLES as readonly string[]).includes(user.role) ? forbidden() : null,
  };
});

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: h.requireCapability,
  hasCapability: h.hasCapability,
}));

vi.mock("@/lib/site-view", () => ({
  getViewScope: async () => ({ isAllSites: false, siteIds: ["site-n15"], label: "N15" }),
}));

vi.mock("@/lib/rota/repository", () => ({ listStaff: h.listStaff, listShifts: h.listShifts }));
vi.mock("@/lib/clock/repository", () => ({ listAllEvents: h.listAllEvents }));
vi.mock("@/lib/hr/repository", () => ({ listPayRates: h.listPayRates }));

import { GET } from "./route";

const OWNER = { id: "u-own", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: ["site-n15"] };
const MANAGER = { id: "u-mgr", email: "m@x", role: "client_coordinator", clientId: "vitality", siteIds: ["site-n15"] };
const NURSE = { id: "u-nurse", email: "n@x", role: "client_staff", clientId: "vitality", siteIds: ["site-n15"] };
const CLINICIAN = { id: "u-cli", email: "c@x", role: "client_clinician", clientId: "vitality", siteIds: ["site-n15"] };

/** A month key that is always the current one, so this file cannot expire. */
function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function dayInMonth(dayOfMonth: number): string {
  return `${thisMonth()}-${String(dayOfMonth).padStart(2, "0")}`;
}

function get(query = `client=vitality&month=${thisMonth()}`) {
  return GET(new Request(`http://localhost/api/hours/month?${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue(OWNER);
  h.requireCapability.mockResolvedValue(null);
  h.hasCapability.mockResolvedValue(true);
  h.listStaff.mockResolvedValue([{ id: "staff-1", name: "Amina", role: "nurse", siteId: "site-n15" }]);
  h.listShifts.mockResolvedValue([]);
  h.listAllEvents.mockResolvedValue({
    ready: true,
    truncated: false,
    events: [
      { id: "e1", staffId: "staff-1", siteId: "site-n15", kind: "in", occurredAt: `${dayInMonth(2)}T08:00:00.000Z` },
      { id: "e2", staffId: "staff-1", siteId: "site-n15", kind: "out", occurredAt: `${dayInMonth(2)}T16:00:00.000Z` },
    ],
  });
  h.listPayRates.mockResolvedValue({
    ready: true,
    rates: [{ staffId: "staff-1", hourlyPence: 1500, effectiveFrom: `${thisMonth()}-01`, effectiveTo: null }],
  });
});

describe("who may read the month at all", () => {
  it("refuses the staff role and the clinician: 'hours' is in neither allow-list", async () => {
    for (const user of [NURSE, CLINICIAN]) {
      h.requireUser.mockResolvedValue(user);
      expect((await get()).status, `${user.role}`).toBe(403);
    }
    expect(h.listAllEvents).not.toHaveBeenCalled();
  });

  it("asks for hours.view on top of the role", async () => {
    await get();
    expect(h.requireCapability).toHaveBeenCalledWith(OWNER, "hours.view");
  });
});

describe("pay is OMITTED SERVER-SIDE, not hidden on the way out", () => {
  it("never reads the rate table for a caller without hr.view-pay", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.hasCapability.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(200);
    // THE ASSERTION THAT MATTERS: the table is not queried at all. A response with
    // the costs stripped afterwards would still have put them in this process.
    expect(h.listPayRates).not.toHaveBeenCalled();
  });

  it("and the cost keys are ABSENT from the payload, not null or zero", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.hasCapability.mockResolvedValue(false);
    const body = await (await get()).json();
    const payload = JSON.stringify(body);
    for (const key of ["costPence", "ratePence", "unpricedDays"]) {
      expect(payload, `${key} must not appear at all`).not.toContain(key);
    }
    expect(body.report.includesCost).toBe(false);
  });

  it("OMISSION, NOT REFUSAL: the manager still gets the whole month", async () => {
    h.requireUser.mockResolvedValue(MANAGER);
    h.hasCapability.mockResolvedValue(false);
    const body = await (await get()).json();
    expect(body.ok).toBe(true);
    expect(body.report.rows.length).toBeGreaterThan(0);
    expect(body.report.rows[0].closedMinutes).toBeGreaterThan(0);
  });

  it("with the key, the rates ARE read and the cost is priced", async () => {
    // The control: without this, "listPayRates was not called" could be satisfied
    // by a route that never prices anything for anybody.
    h.hasCapability.mockResolvedValue(true);
    const body = await (await get()).json();
    expect(h.listPayRates).toHaveBeenCalledWith("vitality", ["staff-1"]);
    expect(body.report.includesCost).toBe(true);
    expect(JSON.stringify(body)).toContain("costPence");
  });
});

describe("the report says what it is, and what it is not", () => {
  it("carries the payroll boundary on the response, not only on the screen", async () => {
    const body = await (await get()).json();
    expect(body.boundary).toContain("Not payroll");
    expect(body.boundary).toContain("HMRC");
  });

  it("stamps the read time server-side, so an export cannot invent one", async () => {
    const body = await (await get()).json();
    expect(Number.isNaN(Date.parse(body.asOf))).toBe(false);
  });

  it("falls back to the CURRENT month on a malformed one, and says which it used", async () => {
    // Not a 400: the month is a view parameter, and a report that refuses to draw
    // because a URL was mistyped is less useful than one that draws this month and
    // names it. `report.month` is what the screen and the export both stamp, so the
    // fallback cannot be mistaken for the month that was asked for.
    const res = await get("client=vitality&month=August");
    expect(res.status).toBe(200);
    expect((await res.json()).report.month).toBe(thisMonth());
  });

  it("a failed read is loud: 503 and no month at all", async () => {
    h.listAllEvents.mockRejectedValue(new Error("connection reset"));
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("carries 'not switched on' and truncation through rather than swallowing them", async () => {
    h.listAllEvents.mockResolvedValue({ ready: false, truncated: true, events: [] });
    const body = await (await get()).json();
    expect(body.report.ready).toBe(false);
    expect(body.report.truncated).toBe(true);
  });
});

describe("the double is honest", () => {
  it("the stand-in approver guard is driven by the REAL role list", () => {
    expect([...APPROVER_ROLES]).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
  });
});
