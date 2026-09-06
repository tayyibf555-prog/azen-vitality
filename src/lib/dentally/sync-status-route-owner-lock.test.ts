import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE SYNC LEDGER'S OWN LOCK, DRIVEN THROUGH THE HANDLER
// (charter §0/9 + §0/11, ruling W3/17).
//
// WHY THIS FILE EXISTS. `GET /api/dentally/sync-status` hands back the whole
// `dentally_write_intent` ledger: every Dentally patient id and appointment id
// this platform has acted on, who acted, which module, and why a write was held
// back. Its own header says it carries "the same lock the System controls page
// and /api/systems carry", and `requireOwnerRole` is what makes that true —
// `src/proxy.ts` matches page paths for a login redirect and never `/api`, and
// `requireClientAccess` proves tenancy only, so every role attached to the
// practice clears it.
//
// Until this file NOTHING executed the handler. The lock was pinned by two
// source-text greps in `sync-surface.test.ts` and by the two API coverage
// sweeps, and all four read the guard's NAME rather than what that name is
// bound to. The mutation that proves it: change the route's import to
//
//   import { …, requireApproverRole as requireOwnerRole } from "@/lib/auth/guard";
//
// — realistic drift, since the interest-export route next door uses exactly that
// guard — and every one of the four stays satisfied word for word while the
// practice manager can read the ledger. Its sibling `/api/systems` got a
// behavioural suite in this same programme (`systems-route-owner-lock.test.ts`);
// the route whose rows name patients did not.
//
// So this drives the REAL GET with only the session read faked: the real
// `requireOwnerRole` and the real `requireClientAccess` run.
// `sync-status-owner-lock-refuses-every-non-owner` is the named test the alias
// mutation reddens. It lives beside the module it guards rather than under
// src/app because that is where this lane's files are; vitest collects
// `src/**/*.test.ts` either way, and `write-gate-staff-refusal.test.ts` already
// drives route handlers from here.
// ===========================================================================

const store = vi.hoisted(() => ({
  user: null as unknown,
  /** How many times the assembly actually ran — a refusal must never reach it. */
  assembled: 0,
  /** The page size the route asked for, so the clamp is observable. */
  limits: [] as number[],
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

vi.mock("@/lib/dentally/sync-status", () => ({
  assembleSyncStatus: async (clientId: string, limit: number) => {
    store.assembled += 1;
    store.limits.push(limit);
    return {
      mode: "dry_run",
      target: { host: "api.dentally.co", live: true },
      master: { slug: "dentally-write-back", off: true, clientId },
      headline: "Writing back to Dentally is OFF.",
      facts: [],
      counts: { dry_run: 0, queued: 0, sent: 0, failed: 0, blocked: 3 },
      total: 3,
      countCapped: false,
      intents: [{ id: "i1", dentallyPatientId: "pat-9" }],
      more: false,
      pageSize: limit,
      ledgerError: null,
    };
  },
}));

import { GET } from "@/app/api/dentally/sync-status/route";

/** Every clearance in the platform, and whether it may read the write ledger. */
const CLEARANCES: ReadonlyArray<{ role: string; mayReach: boolean; who: string }> = [
  { role: "agency_admin", mayReach: true, who: "the agency" },
  { role: "client_owner", mayReach: true, who: "the practice owner" },
  { role: "client_coordinator", mayReach: false, who: "the practice manager" },
  { role: "client_clinician", mayReach: false, who: "a dentist" },
  { role: "client_staff", mayReach: false, who: "a nurse or receptionist" },
];

function asRole(role: string, clientId = "vitality"): void {
  store.user = {
    id: `u-${role}`,
    name: role,
    email: `${role}@vitality.example`,
    role,
    clientId,
    siteIds: ["site-cc"],
  };
}

function read(query = "?client=vitality"): Promise<Response> {
  return GET(new Request(`http://localhost/api/dentally/sync-status${query}`));
}

beforeEach(() => {
  store.user = null;
  store.assembled = 0;
  store.limits = [];
});

describe("the Dentally write ledger is owner-only on the API, not only on the page", () => {
  it("sync-status-owner-lock-refuses-every-non-owner", async () => {
    for (const c of CLEARANCES.filter((x) => !x.mayReach)) {
      store.assembled = 0;
      asRole(c.role);

      const got = await read();
      expect(got.status, `${c.who} (${c.role}) read the Dentally write ledger`).toBe(403);
      const body = (await got.json()) as { ok?: boolean; intents?: unknown[] };
      expect(body.ok, `${c.who} was handed an ok payload`).not.toBe(true);
      expect(body.intents, `${c.who} was handed the ledger rows`).toBeUndefined();
      // The refusal happens BEFORE the ledger is read: a guard that returned 403
      // after assembling would still have queried a practice's write history.
      expect(store.assembled, `${c.who} caused the ledger to be read`).toBe(0);
    }
  });

  it("sync-status-owner-lock-admits-the-owner-and-the-agency", async () => {
    // The fail direction is CLOSED, not shut: a guard tightened to refuse
    // everybody would pass the refusal test above against a page no owner could
    // open.
    for (const c of CLEARANCES.filter((x) => x.mayReach)) {
      store.assembled = 0;
      asRole(c.role);

      const got = await read();
      expect(got.status, `${c.who} (${c.role}) could not read the ledger`).toBe(200);
      const body = (await got.json()) as { ok?: boolean; intents?: unknown[] };
      expect(body.ok).toBe(true);
      expect(body.intents).toHaveLength(1);
      expect(store.assembled).toBe(1);
    }
  });

  it("refuses an owner of a DIFFERENT practice before the role guard is reached", async () => {
    // Tenancy first: `requireClientAccess` is the real one here too, and an owner
    // elsewhere is an owner.
    asRole("client_owner", "another-practice");
    const got = await read();
    expect(got.status).toBe(403);
    expect(store.assembled).toBe(0);
  });

  it("an unauthenticated caller reaches the handler's body not at all", async () => {
    // `requireUser` returning a Response is the enforced-auth path; a null user
    // is the AUTH_ENFORCED-off development path, which the guards no-op for by
    // design. This asserts the first.
    store.user = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await read()).status).toBe(401);
    expect(store.assembled).toBe(0);
  });

  it("an unknown client slug is a 404 and never a ledger read", async () => {
    asRole("client_owner");
    const got = await read("?client=not-a-practice");
    expect(got.status).toBe(404);
    expect(store.assembled).toBe(0);
  });

  it("the admitted clearances are exactly requireOwnerRole's own list", async () => {
    // Pins the TABLE above against the shipped guard rather than against a second
    // copy of the role names — and it is what catches the import-alias mutation
    // at the source: `requireApproverRole` admits `client_coordinator`, so the
    // table and the guard would disagree here as well as in the refusal test.
    const { requireOwnerRole } = await import("@/lib/auth/guard");
    for (const c of CLEARANCES) {
      const user = { id: "u", name: "Probe", email: "e", role: c.role, clientId: "vitality", siteIds: [] };
      const denied = requireOwnerRole(user as Parameters<typeof requireOwnerRole>[0]);
      expect(denied === null, `${c.role} disagrees with the table`).toBe(c.mayReach);
    }
  });

  it("a hand-typed ?limit is a positive integer by the time the ledger sees it", async () => {
    // The clamp itself lives in assembleSyncStatus (and again in the repository);
    // what the route owes is not handing it rubbish. `?limit=100000` reaching the
    // assembly is fine — it is clamped there, and sync-status-capped.test.ts pins
    // that — but a NaN or a negative would turn into a page size of its own.
    asRole("client_owner");
    for (const [query, expected] of [
      ["?client=vitality", 50],
      ["?client=vitality&limit=abc", 50],
      ["?client=vitality&limit=-5", 50],
      ["?client=vitality&limit=0", 50],
      ["?client=vitality&limit=25", 25],
      ["?client=vitality&limit=100000", 100000],
    ] as const) {
      store.limits = [];
      await read(query);
      expect(store.limits, `limit for ${query}`).toEqual([expected]);
    }
  });
});
