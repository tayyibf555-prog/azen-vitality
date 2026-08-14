import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// /api/permissions AT THE HTTP EDGE.
//
// The pure rules are proven in src/lib/capabilities/admin-rules.test.ts. What
// this file proves is that the ROUTE actually consults them, in the right order,
// with a subject read from the database rather than from the request body — and
// that a failed read is answered honestly instead of as an empty grid.
//
// The admin rules are REAL here, not mocked. A mocked rule set would let the
// route stop calling them while every test stayed green, which is the failure
// this file exists to catch.
// ===========================================================================

const h = vi.hoisted(() => ({
  user: {
    id: "owner-1",
    name: "Dr S",
    email: "jawad@vitalitydental.co.uk",
    role: "client_owner",
    clientId: "vitality",
    siteIds: ["site-cc"],
  } as Record<string, unknown> | null,
  /** What requireCapability("security.capability.manage") answers. */
  capabilityDenied: null as Response | null,
  /** The actor's own resolved set, for the no-amplification rule. */
  actorCapabilities: new Set<string>(),
  people: [] as Array<{ id: string; name: string; email: string; role: string }>,
  overrides: [] as Array<{ appUserId: string; capability: string; granted: boolean; updatedAt: string | null; updatedBy: string | null }>,
  listThrows: false,
  writes: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<Record<string, unknown>>,
  writeThrows: false,
}));

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", name: "Vitality Dental" } : undefined),
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => h.user,
  requireClientAccess: (u: { clientId?: string } | null, cid: string) =>
    u && u.clientId && u.clientId !== cid ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
  requireOwnerRole: (u: { role?: string } | null) =>
    u && u.role !== "client_owner" && u.role !== "agency_admin"
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
}));

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => h.capabilityDenied,
  hasCapability: async () => h.capabilityDenied === null,
}));

vi.mock("@/lib/capabilities/repository", () => ({
  getCapabilities: async () => h.actorCapabilities,
  listClientPeople: async () => {
    if (h.listThrows) throw new Error("relation \"app_user\" does not exist");
    return h.people;
  },
  listOverrides: async () => {
    if (h.listThrows) throw new Error("relation \"user_capability\" does not exist");
    return h.overrides;
  },
  getClientPerson: async (_clientId: string, id: string) => h.people.find((p) => p.id === id) ?? null,
  setOverride: async (clientId: string, appUserId: string, capability: string, granted: boolean, updatedBy: string | null) => {
    if (h.writeThrows) throw new Error("write failed");
    h.writes.push({ clientId, appUserId, capability, granted, updatedBy });
  },
  clearOverride: async (clientId: string, appUserId: string, capability: string) => {
    if (h.writeThrows) throw new Error("delete failed");
    h.deletes.push({ clientId, appUserId, capability });
  },
}));

import { CAPABILITY_KEYS } from "@/lib/capabilities/keys";
import { ROLE_DEFAULTS } from "@/lib/capabilities/defaults";
import { PROTECTED_SUBJECT_ROLES, isProtectedSubject } from "@/lib/capabilities/admin-rules";
import type { Role } from "@/lib/types";
import { GET, POST, DELETE } from "./route";

/** Every role the platform has; adding a sixth fails tsc here first. */
const ALL_ROLES: Role[] = [
  "agency_admin",
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
];

const EDITABLE = "clinical.chart.write";

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/permissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/permissions", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.user = {
    id: "owner-1",
    name: "Dr S",
    email: "jawad@vitalitydental.co.uk",
    role: "client_owner",
    clientId: "vitality",
    siteIds: ["site-cc"],
  };
  h.capabilityDenied = null;
  h.actorCapabilities = new Set<string>(ROLE_DEFAULTS.client_owner);
  h.people = [
    { id: "owner-1", name: "Dr S", email: "jawad@vitalitydental.co.uk", role: "client_owner" },
    { id: "mgr-1", name: "Blerta", email: "blerta@vitalitydental.co.uk", role: "client_coordinator" },
    { id: "nurse-1", name: "Amara", email: "amara@vitalitydental.co.uk", role: "client_staff" },
  ];
  h.overrides = [];
  h.listThrows = false;
  h.writes = [];
  h.deletes = [];
  h.writeThrows = false;
});

describe("1. GET renders the whole grid", () => {
  it("returns one row per person and one cell per capability", async () => {
    const res = await GET(new Request("http://localhost/api/permissions?client=vitality"));
    const json = (await res.json()) as { ok: boolean; people: Array<{ id: string; cells: unknown[] }>; capabilities: unknown[] };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.people).toHaveLength(3);
    expect(json.capabilities).toHaveLength(CAPABILITY_KEYS.length);
    for (const person of json.people) expect(person.cells).toHaveLength(CAPABILITY_KEYS.length);
  });

  it("a cell with no stored row reads as inherited from the role", async () => {
    const res = await GET(new Request("http://localhost/api/permissions?client=vitality"));
    const json = (await res.json()) as { people: Array<{ id: string; cells: Array<{ capability: string; held: boolean; source: string }> }> };
    const blerta = json.people.find((p) => p.id === "mgr-1")!;
    const chart = blerta.cells.find((c) => c.capability === EDITABLE)!;
    expect(chart.source).toBe("role");
    // ...and it says what the role actually says, which after the named tightening
    // is that a practice manager does not chart.
    expect(chart.held).toBe(false);
  });

  it("a stored row reads as decided, in the direction it was decided", async () => {
    h.overrides = [
      { appUserId: "mgr-1", capability: EDITABLE, granted: true, updatedAt: null, updatedBy: null },
    ];
    const res = await GET(new Request("http://localhost/api/permissions?client=vitality"));
    const json = (await res.json()) as { people: Array<{ id: string; cells: Array<{ capability: string; held: boolean; source: string }> }> };
    const cell = json.people.find((p) => p.id === "mgr-1")!.cells.find((c) => c.capability === EDITABLE)!;
    expect(cell.held).toBe(true);
    expect(cell.source).toBe("granted");
  });

  it("a stored row on the LOCKED key is inert, in the grid as well as in the guard", async () => {
    h.overrides = [
      { appUserId: "mgr-1", capability: "security.capability.manage", granted: true, updatedAt: null, updatedBy: null },
    ];
    const res = await GET(new Request("http://localhost/api/permissions?client=vitality"));
    const json = (await res.json()) as { people: Array<{ id: string; cells: Array<{ capability: string; held: boolean }> }> };
    const cell = json.people
      .find((p) => p.id === "mgr-1")!
      .cells.find((c) => c.capability === "security.capability.manage")!;
    expect(cell.held).toBe(false);
  });

  it("the greyed roles are the SAME LIST the rules refuse, not a retyped copy", async () => {
    // The grid greys a row it may not edit. That list used to be typed into the
    // route as ["agency_admin","client_owner"] with nothing tying it to
    // `isProtectedSubject`, which is what actually refuses the write. It failed
    // safe — the server still refuses — but a third protected role would have
    // rendered as an editable cell that 403s on click, which reads as a broken
    // screen rather than as a rule. Derived here, and checked BOTH ways.
    const res = await GET(new Request("http://localhost/api/permissions?client=vitality"));
    const json = (await res.json()) as { protectedRoles: string[] };
    expect([...json.protectedRoles].sort()).toEqual([...PROTECTED_SUBJECT_ROLES].sort());
    for (const role of json.protectedRoles) {
      expect(isProtectedSubject(role as Role), `${role} is greyed but not protected`).toBe(true);
    }
    for (const role of ALL_ROLES) {
      expect(
        json.protectedRoles.includes(role),
        `${role} is protected by the rules but not greyed in the grid`,
      ).toBe(isProtectedSubject(role));
    }
  });

  it("FAILS LOUDLY when the tables cannot be read, rather than rendering an empty grid", async () => {
    h.listThrows = true;
    const res = await GET(new Request("http://localhost/api/permissions?client=vitality"));
    expect(res.status).toBe(503);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("could not read");
  });

  it("refuses a non-owner and an unknown client", async () => {
    h.user = { ...(h.user as Record<string, unknown>), role: "client_coordinator" };
    expect((await GET(new Request("http://localhost/api/permissions?client=vitality"))).status).toBe(403);
    h.user = { ...(h.user as Record<string, unknown>), role: "client_owner" };
    expect((await GET(new Request("http://localhost/api/permissions?client=nope"))).status).toBe(404);
  });
});

describe("2. POST writes exactly one decision", () => {
  it("stores the row with the actor recorded as the decider", async () => {
    const res = await POST(post({ client: "vitality", appUserId: "mgr-1", capability: EDITABLE, granted: true }));
    expect(res.status).toBe(200);
    expect(h.writes).toEqual([
      { clientId: "vitality", appUserId: "mgr-1", capability: EDITABLE, granted: true, updatedBy: "owner-1" },
    ]);
  });

  it("refuses a capability the catalog does not have, and writes nothing", async () => {
    const res = await POST(post({ client: "vitality", appUserId: "mgr-1", capability: "money.payment.delete", granted: true }));
    expect(res.status).toBe(400);
    expect(h.writes).toEqual([]);
  });

  it("refuses the LOCKED key with its own reason", async () => {
    const res = await POST(post({ client: "vitality", appUserId: "mgr-1", capability: "security.capability.manage", granted: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("capability-is-locked");
    expect(h.writes).toEqual([]);
  });

  it("refuses a self-edit", async () => {
    const res = await POST(post({ client: "vitality", appUserId: "owner-1", capability: EDITABLE, granted: false }));
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("no-self-edit");
    expect(h.writes).toEqual([]);
  });

  it("refuses editing another OWNER's row", async () => {
    h.people.push({ id: "owner-2", name: "Murtaza", email: "m@vitalitydental.co.uk", role: "client_owner" });
    const res = await POST(post({ client: "vitality", appUserId: "owner-2", capability: EDITABLE, granted: false }));
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("subject-is-protected");
  });

  it("refuses granting something the actor does not hold", async () => {
    h.actorCapabilities = new Set<string>();
    const res = await POST(post({ client: "vitality", appUserId: "mgr-1", capability: EDITABLE, granted: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("actor-lacks-capability");
  });

  it("THE SUBJECT'S ROLE COMES FROM THE DATABASE, never from the body", async () => {
    // A caller who could name the subject's role could claim a coordinator is a
    // "client_staff" and slip past nothing — but could equally claim an owner is a
    // coordinator and edit them. The route looks the person up instead, so a body
    // field named `role` is simply ignored.
    h.people.push({ id: "owner-2", name: "Murtaza", email: "m@vitalitydental.co.uk", role: "client_owner" });
    const res = await POST(
      post({ client: "vitality", appUserId: "owner-2", capability: EDITABLE, granted: false, role: "client_staff" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("subject-is-protected");
  });

  it("refuses a person who is not a login of this practice", async () => {
    const res = await POST(post({ client: "vitality", appUserId: "someone-elses-staff", capability: EDITABLE, granted: true }));
    expect(res.status).toBe(404);
    expect(h.writes).toEqual([]);
  });

  it("is refused entirely when the capability guard says no (the 503 on an unenforced environment)", async () => {
    h.capabilityDenied = Response.json(
      { ok: false, error: "This action is unavailable because sign-in is not configured on this environment." },
      { status: 503 },
    );
    const res = await POST(post({ client: "vitality", appUserId: "mgr-1", capability: EDITABLE, granted: true }));
    expect(res.status).toBe(503);
    expect(h.writes).toEqual([]);
  });

  it("requires granted to be a boolean, so a missing field cannot read as a revoke", async () => {
    const res = await POST(post({ client: "vitality", appUserId: "mgr-1", capability: EDITABLE }));
    expect(res.status).toBe(400);
    expect(h.writes).toEqual([]);
  });

  it("reports a failed write honestly and claims nothing", async () => {
    h.writeThrows = true;
    const res = await POST(post({ client: "vitality", appUserId: "mgr-1", capability: EDITABLE, granted: true }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Nothing has been changed");
  });
});

describe("3. DELETE resets to the role default", () => {
  it("deletes the row rather than writing one that agrees with the role", async () => {
    // The absence of a row IS "ask the role". Storing an agreeing row would pin
    // the person to today's default and silently strand them the day it changes.
    const res = await DELETE(del({ client: "vitality", appUserId: "mgr-1", capability: EDITABLE }));
    expect(res.status).toBe(200);
    expect(h.deletes).toEqual([{ clientId: "vitality", appUserId: "mgr-1", capability: EDITABLE }]);
    expect(h.writes).toEqual([]);
  });

  it("obeys the same rules as a write", async () => {
    expect((await DELETE(del({ client: "vitality", appUserId: "owner-1", capability: EDITABLE }))).status).toBe(403);
    expect(
      (await DELETE(del({ client: "vitality", appUserId: "mgr-1", capability: "security.capability.manage" }))).status,
    ).toBe(403);
    expect(h.deletes).toEqual([]);
  });
});
