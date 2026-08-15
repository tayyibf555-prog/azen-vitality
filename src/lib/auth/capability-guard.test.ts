import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const env = vi.hoisted(() => ({ enforced: true }));
const overlay = vi.hoisted(() => ({ held: new Set<string>() }));

// authEnforced() reads SUPABASE_SERVICE_ROLE_KEY. Mocked rather than stubbed via
// process.env so the two states are explicit in each test.
vi.mock("./guard", () => ({ authEnforced: () => env.enforced }));

vi.mock("@/lib/capabilities/repository", () => ({
  getCapabilities: async () => overlay.held,
}));

import type { AuthedUser } from "./session";
import { DESTRUCTIVE_CAPABILITIES, CAPABILITIES, type Capability } from "@/lib/capabilities/keys";
import { requireCapability, hasCapability } from "./capability-guard";

const DESTRUCTIVE = "clinical.record.retract" as Capability;
const VIEW = "reports.nhs.view" as Capability;

const user: AuthedUser = {
  id: "u-1",
  name: "Blerta",
  email: "blerta@vitalitydental.co.uk",
  role: "client_coordinator",
  clientId: "vitality",
  siteIds: ["site-cc"],
};

beforeEach(() => {
  env.enforced = true;
  overlay.held = new Set<string>();
});

describe("0. the two fixtures really are what the tests assume", () => {
  it("one destructive key and one that is not", () => {
    expect(DESTRUCTIVE_CAPABILITIES.has(DESTRUCTIVE)).toBe(true);
    expect(DESTRUCTIVE_CAPABILITIES.has(VIEW)).toBe(false);
    expect(CAPABILITIES.some((c) => c.key === DESTRUCTIVE)).toBe(true);
  });
});

describe("1. a null user with auth NOT enforced", () => {
  beforeEach(() => {
    env.enforced = false;
  });

  it("passes a non-destructive capability through, like every other guard", async () => {
    await expect(requireCapability(null, VIEW)).resolves.toBeNull();
  });

  it("REFUSES a destructive one with 503, and says why in the practice's words", async () => {
    // THE POINT OF THE WHOLE FILE. requireUser returns null whenever
    // SUPABASE_SERVICE_ROLE_KEY is unset, and every guard downstream no-ops on a
    // null user. A capability check that inherited that would enforce NOTHING on
    // any environment missing the key — an owner ticking boxes that do nothing.
    const res = await requireCapability(null, DESTRUCTIVE);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(503);
    const body = (await res!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("sign-in is not configured");
    // NOT "forbidden": nobody is being refused, the environment cannot tell who
    // is asking. A 403 here would send the user to ask for a permission they
    // already have.
    expect(body.error).not.toBe("forbidden");
  });

  it("refuses EVERY destructive capability in the catalog, not just the sampled one", async () => {
    for (const key of DESTRUCTIVE_CAPABILITIES) {
      const res = await requireCapability(null, key as Capability);
      expect(res?.status, key).toBe(503);
    }
    expect(DESTRUCTIVE_CAPABILITIES.size).toBeGreaterThanOrEqual(15);
  });

  it("hasCapability agrees, so a UI built on it hides the control rather than showing a 503", async () => {
    await expect(hasCapability(null, DESTRUCTIVE)).resolves.toBe(false);
    await expect(hasCapability(null, VIEW)).resolves.toBe(true);
  });
});

describe("1b. a null user with auth ENFORCED is REFUSED, destructive or not", () => {
  // Defence in depth, and a default rather than a behaviour anybody depends on.
  // Enforcement being on means the environment CAN tell who is asking, so "no
  // user" is not a pilot with no sign-in configured — it is nobody. Every route
  // reaching a capability check has already run `requireUser`, which answers 401
  // on this combination, so nothing in the app can observe these branches today.
  // That is the reason to pin them: an unreachable branch that says "allow" is
  // where a hole waits for the one refactor that makes it reachable.
  beforeEach(() => {
    env.enforced = true;
  });

  it("refuses a NON-destructive capability with 403, where it used to pass through", () => {
    // The sharper of the two. A destructive key was already refused (503) on the
    // un-enforced path; a read was allowed on BOTH paths, so this is the branch
    // that actually changed posture.
    return requireCapability(null, VIEW).then(async (res) => {
      expect(res).toBeInstanceOf(Response);
      expect(res!.status).toBe(403);
      await expect(res!.json()).resolves.toEqual({ ok: false, error: "forbidden" });
    });
  });

  it("refuses a destructive capability too, and as 403 rather than the 503", async () => {
    // 403, not 503: 503 means "this environment has no sign-in", which is a claim
    // about the environment. Enforcement is ON here, so the honest answer is a
    // refusal of the caller, not an apology about the deployment.
    const res = await requireCapability(null, DESTRUCTIVE);
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe("forbidden");
    expect(body.error).not.toContain("sign-in is not configured");
  });

  it("refuses EVERY capability in the catalog, so no key is quietly exempt", async () => {
    for (const c of CAPABILITIES) {
      // `CapabilityDef.key` is a plain string in the catalog; the guard takes the
      // union, so the cast is the catalog-to-union hop the file already makes.
      const key = c.key as Capability;
      expect((await requireCapability(null, key))?.status, key).toBe(403);
      await expect(hasCapability(null, key), key).resolves.toBe(false);
    }
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(15);
  });

  it("hasCapability answers false in both directions, so a UI cannot draw what the route refuses", async () => {
    await expect(hasCapability(null, VIEW)).resolves.toBe(false);
    await expect(hasCapability(null, DESTRUCTIVE)).resolves.toBe(false);
  });

  it("the capability overlay is never even read for a caller who is nobody", async () => {
    // A refusal decided before any lookup: there is no user to look anything up
    // for, and reaching the repository would be the shape of a check that could
    // fail open on a read error.
    overlay.held = new Set([VIEW, DESTRUCTIVE]);
    expect((await requireCapability(null, VIEW))?.status).toBe(403);
    await expect(hasCapability(null, DESTRUCTIVE)).resolves.toBe(false);
  });

  it("THE PILOT PASSTHROUGH SURVIVES, and is conditional on enforcement being off", async () => {
    // The other direction, stated here rather than only in block 1, because the
    // pair is the actual contract: enforcement off keeps the un-enforced pilot
    // demo working, enforcement on refuses. Flipping either half must fail.
    env.enforced = false;
    await expect(requireCapability(null, VIEW)).resolves.toBeNull();
    await expect(hasCapability(null, VIEW)).resolves.toBe(true);
    expect((await requireCapability(null, DESTRUCTIVE))?.status).toBe(503);
  });
});

describe("2. a signed-in user", () => {
  it("passes when they hold the key", async () => {
    overlay.held = new Set([DESTRUCTIVE]);
    await expect(requireCapability(user, DESTRUCTIVE)).resolves.toBeNull();
    await expect(hasCapability(user, DESTRUCTIVE)).resolves.toBe(true);
  });

  it("is refused 403 with the exact envelope the rest of the platform uses", async () => {
    overlay.held = new Set([VIEW]);
    const res = await requireCapability(user, DESTRUCTIVE);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("holding a NEIGHBOURING key is not holding this one", async () => {
    overlay.held = new Set(["clinical.perio.write"]);
    expect((await requireCapability(user, "clinical.record.retract" as Capability))?.status).toBe(403);
  });

  it("is checked even when auth enforcement is off, if a user somehow exists", async () => {
    // Defence in depth: the un-enforced path is the null-user path. A real user
    // object must still be checked against their real set.
    env.enforced = false;
    overlay.held = new Set<string>();
    expect((await requireCapability(user, DESTRUCTIVE))?.status).toBe(403);
  });
});

describe("3. composition", () => {
  it("returns null, so a route can chain it after the module gate", async () => {
    // The contract every guard in this codebase shares: a Response means stop, a
    // null means carry on. Stated as a test because a route that treated the
    // return value as a boolean would fail open.
    overlay.held = new Set([VIEW]);
    const denied = await requireCapability(user, VIEW);
    expect(denied).toBeNull();
    expect(denied ?? "carry on").toBe("carry on");
  });

  it("a forgotten await yields a Promise, which is truthy — hence the coverage pin", async () => {
    // Not a behaviour test: a statement of the hazard the fs sweep exists to catch.
    // Every other require* in this codebase is synchronous, so `const d =
    // requireCapability(...)` compiles, is always truthy, and returns a Promise as
    // the route's Response.
    overlay.held = new Set([VIEW]);
    const notAwaited = requireCapability(user, VIEW);
    expect(notAwaited).toBeInstanceOf(Promise);
    expect(Boolean(notAwaited)).toBe(true);
    await notAwaited;
  });
});
