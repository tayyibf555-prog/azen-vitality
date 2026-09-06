// ===========================================================================
// THE KILL-SWITCH PANEL'S OWN LOCK, DRIVEN THROUGH THE HANDLERS
// (charter §0/9 + §0/11, ruling W3/17).
//
// WHY THIS FILE EXISTS. `/api/systems` is the whole System-controls surface:
// every system slug, whether it is armed, who armed it and when, plus the
// switch-on vocabulary. Its own header says "only the practice owner (or an
// agency admin) can read or change the switches", and `requireOwnerRole` is what
// makes that true — `src/proxy.ts` matches page paths for a login redirect and
// never `/api`, and `requireClientAccess` proves tenancy only, so any role
// attached to the practice clears it.
//
// Until this file, NOTHING executed either handler. The only references were
// source greps that the mutation `if (roleDenied) return roleDenied;` ->
// `if (false && roleDenied) return roleDenied;` leaves satisfied word for word:
//   - src/components/client/systems/control-panel.test.ts reads the route as
//     TEXT and says so in its own comment ("this is not a behaviour proof");
//   - client-api-module-guard-coverage.test.ts tests a ROLE_GUARD_CALL regex;
//   - destructive-route-capability-coverage.test.ts looks for a ROLE_TOKEN
//     substring.
// The whole 14,225-test suite stayed green under that mutation while a
// receptionist could read the practice's entire messaging-armament state.
//
// So this drives the REAL GET and POST with only the session read faked. The
// real `requireOwnerRole`, `requireClientAccess` and `requireCapability` run.
// `systems-owner-lock-refuses-every-non-owner` is the named test the GET-side
// mutation reddens. The POST carries a genuine SECOND lock —
// `requireCapability(auth, "system.toggle")`, base-granted to owners only — so
// the POST's own role guard is pinned separately by
// `systems-owner-lock-post-refuses-a-manager-who-holds-system-toggle`, which
// grants the capability first so the role guard is the only thing left standing.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  user: null as unknown,
  /** Every (slug, enabled) the route actually wrote. */
  writes: [] as Array<{ slug: string; enabled: boolean }>,
  /** Rows in `app_user_capability` for the caller. Empty = role defaults. */
  capabilityOverrides: [] as Array<{ capability: string; granted: boolean }>,
}));

// PARTIAL: requireClientAccess and requireOwnerRole are the REAL guards; only
// the session read is faked. A stubbed role predicate would be testing the stub.
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireUser: async () => store.user };
});

vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));

vi.mock("@/lib/systems/repository", () => ({
  getSystemStates: async () => [
    { slug: "speed-to-lead", enabled: true, updatedAt: "2026-09-01T00:00:00.000Z", updatedBy: "u-owner" },
  ],
  setSystemEnabled: async (_clientId: string, slug: string, enabled: boolean) => {
    store.writes.push({ slug, enabled });
  },
}));

// The capability layer's own database seam — the `app_user_capability` overlay
// `getCapabilities` reads. Default is no rows, so the ROLE defaults decide, which
// is what production does for a practice that has granted nothing by hand. The
// last test in this file puts a real grant row in it.
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: store.capabilityOverrides, error: null }),
        }),
      }),
    }),
  }),
}));

import { GET, POST } from "./route";

/** Every clearance in the platform, and whether it may reach System controls. */
const CLEARANCES: ReadonlyArray<{ role: string; mayReach: boolean; who: string }> = [
  { role: "agency_admin", mayReach: true, who: "the agency" },
  { role: "client_owner", mayReach: true, who: "the practice owner" },
  { role: "client_coordinator", mayReach: false, who: "the practice manager" },
  { role: "client_clinician", mayReach: false, who: "a dentist" },
  { role: "client_staff", mayReach: false, who: "a nurse or receptionist" },
];

function asRole(role: string) {
  store.user = {
    id: `u-${role}`,
    name: role,
    email: `${role}@vitality.example`,
    role,
    clientId: "vitality",
    siteIds: ["site-cc"],
  };
}

function read(): Promise<Response> {
  return GET(new Request("http://localhost/api/systems?client=vitality"));
}

function flip(enabled: boolean): Promise<Response> {
  return POST(
    new Request("http://localhost/api/systems", {
      method: "POST",
      body: JSON.stringify({ client: "vitality", slug: "speed-to-lead", enabled }),
    }),
  );
}

beforeEach(() => {
  store.user = null;
  store.writes = [];
  store.capabilityOverrides = [];
});

describe("System controls is owner-only on the API, not only on the page", () => {
  it("systems-owner-lock-refuses-every-non-owner", async () => {
    for (const c of CLEARANCES.filter((x) => !x.mayReach)) {
      store.writes = [];
      asRole(c.role);

      const got = await read();
      expect(got.status, `${c.who} (${c.role}) read the kill-switch panel`).toBe(403);
      const body = (await got.json()) as { systems?: unknown[] };
      expect(body.systems, `${c.who} was handed the system list`).toBeUndefined();

      const flipped = await flip(false);
      expect(flipped.status, `${c.who} (${c.role}) flipped a system switch`).toBe(403);
      expect(store.writes, `${c.who} changed a kill switch`).toEqual([]);
    }
  });

  it("systems-owner-lock-admits-the-owner-and-the-agency", async () => {
    // The fail direction is CLOSED, not shut: a guard tightened to refuse
    // everybody would pass the refusal test above against a panel no owner
    // could open.
    for (const c of CLEARANCES.filter((x) => x.mayReach)) {
      store.writes = [];
      asRole(c.role);

      const got = await read();
      expect(got.status, `${c.who} (${c.role}) could not read the panel`).toBe(200);
      const body = (await got.json()) as { ok?: boolean; systems?: Array<{ slug: string }> };
      expect(body.ok).toBe(true);
      expect((body.systems ?? []).length, "the panel came back with no systems on it").toBeGreaterThan(0);

      const flipped = await flip(false);
      expect(flipped.status, `${c.who} (${c.role}) could not flip a switch`).toBe(200);
      expect(store.writes).toEqual([{ slug: "speed-to-lead", enabled: false }]);
    }
  });

  it("an unauthenticated caller reaches neither handler", async () => {
    // `requireUser` returning a Response is the enforced-auth path; a null user
    // is the AUTH_ENFORCED-off development path, which the guards no-op for by
    // design. This asserts the first.
    store.user = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await read()).status).toBe(401);
    expect((await flip(true)).status).toBe(401);
    expect(store.writes).toEqual([]);
  });

  it("the admitted clearances are exactly requireOwnerRole's own list", async () => {
    // Pins the TABLE above against the shipped guard rather than against a
    // second copy of the role names: a role admitted by requireOwnerRole but
    // marked `mayReach: false` here would otherwise make the refusal test red
    // for the right reason and this one is what says which side changed.
    const { requireOwnerRole } = await import("@/lib/auth/guard");
    for (const c of CLEARANCES) {
      const user = { id: "u", name: "Probe", email: "e", role: c.role, clientId: "vitality", siteIds: [] };
      const denied = requireOwnerRole(user as Parameters<typeof requireOwnerRole>[0]);
      expect(denied === null, `${c.role} disagrees with the table`).toBe(c.mayReach);
    }
  });
  // -------------------------------------------------------------------------
  // THE POST'S ROLE GUARD, PROVED SEPARATELY FROM THE CAPABILITY GUARD.
  //
  // `requireCapability(auth, "system.toggle")` sits behind `requireOwnerRole` on
  // the POST and its base grant is owner-only, so with no override row BOTH
  // guards refuse a manager and the mutation `if (false && roleDenied)` on the
  // POST alone survives — a real second lock, correctly reported rather than
  // pretended away. That makes this the only way to pin the POST's own role
  // guard: hand the manager the capability, so `requireCapability` would let her
  // through, and assert `requireOwnerRole` still does not.
  // -------------------------------------------------------------------------
  it("systems-owner-lock-post-refuses-a-manager-who-holds-system-toggle", async () => {
    asRole("client_coordinator");
    store.capabilityOverrides = [{ capability: "system.toggle", granted: true }];
    const flipped = await flip(true);
    expect(
      flipped.status,
      "the practice manager flipped a kill switch on a capability grant alone",
    ).toBe(403);
    expect(store.writes).toEqual([]);
  });

  it("the capability grant really would have admitted her but for the role guard", async () => {
    // The control for the test above: the same grant, read through the same
    // seam, does hold. Without this the 403 above could be a mock that never
    // granted anything and the test would prove nothing.
    const { hasCapability } = await import("@/lib/auth/capability-guard");
    store.capabilityOverrides = [{ capability: "system.toggle", granted: true }];
    const manager = {
      id: "u-grant-probe",
      name: "Practice manager",
      email: "manager@vitality.example",
      role: "client_coordinator",
      clientId: "vitality",
      siteIds: ["site-cc"],
    };
    expect(await hasCapability(manager as Parameters<typeof hasCapability>[0], "system.toggle")).toBe(true);
  });
});
