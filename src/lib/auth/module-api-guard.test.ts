// `requireModuleApiAccess` is the API-layer counterpart to the page guard. Two claims
// have to hold at once and BOTH are pinned here, because the value of the guard is
// entirely in the second one:
//
//   1. it denies `client_clinician` every module outside CLINICIAN_SLUGS, and
//   2. it changes NOTHING for agency_admin / client_owner / client_coordinator.
//
// (2) is not a nicety. `canRoleAccessModule` is allow-BY-DEFAULT for those three
// (no `roles` array = open; an unknown slug = open) and deny-by-default only for the
// clinician, whose branch runs first and returns. If a later edit "tidies" that into
// a single uniform rule, the three existing roles silently lose modules in
// production — so their behaviour is asserted here explicitly, not assumed.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

// guard.ts needs only the AuthedUser TYPE from ./session; importing it for real pulls
// in the Supabase auth server. Stub it, as approver-guard.test.ts does.
vi.mock("./session", () => ({
  canAccessClient: () => true,
  getSessionUser: async () => null,
}));

import { requireModuleApiAccess, requireOwnerRole } from "./guard";
import { CLINICIAN_SLUGS, canRoleAccessModule } from "@/lib/nav";
import type { AuthedUser } from "./session";
import type { Role } from "@/lib/types";

function user(role: Role): AuthedUser {
  return { id: `user-${role}`, name: "Test", email: "t@example.com", role, clientId: "vitality", siteIds: ["site-cc"] };
}

/** The modules a clinician session could reach through the API before this guard. */
const DENIED_TO_CLINICIAN = [
  "conversations", // POST /api/inbox/reply — texting any patient in the practice
  "recall",
  "reactivation",
  "task-queue",
  "no-show-defence",
  "after-hours",
  "reports",
  "payments",
  "settings",
  "controls",
  "co-pilot",
  "onboarding",
  "reviews",
  "speed-to-lead",
  "treatment-coordinator",
];

describe("requireModuleApiAccess denies the clinician everything outside its allow-list", () => {
  it.each(DENIED_TO_CLINICIAN)("refuses %s with a 403", async (slug) => {
    const denied = requireModuleApiAccess(user("client_clinician"), slug);
    expect(denied).toBeInstanceOf(Response);
    expect(denied?.status).toBe(403);
    await expect(denied?.json()).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("refuses an unknown slug too, so a typo is not an open door", () => {
    // canRoleAccessModule is allow-by-default for an unrecognised slug — for the
    // OTHER three roles. The clinician branch returns before that fall-through.
    expect(requireModuleApiAccess(user("client_clinician"), "not-a-module")?.status).toBe(403);
  });
});

describe("requireModuleApiAccess admits the clinician its own six modules", () => {
  it.each([...CLINICIAN_SLUGS])("allows %s", (slug) => {
    expect(requireModuleApiAccess(user("client_clinician"), slug)).toBe(null);
  });

  it("is exactly six, and exactly these (a silent widening fails here)", () => {
    // WAS FIVE until campaign 6 added "my-work", the staff self-service surface, to
    // CLINICIAN_SLUGS. Moved by hand and with a reason, which is what this pin is
    // for: a clinician is a member of staff, and every tab of my-work is scoped to
    // the caller's OWN staff record, so it hands over no practice-wide data the way
    // "calendar" and "patients" do.
    expect([...CLINICIAN_SLUGS].sort()).toEqual([
      "",
      "absence",
      "calendar",
      "my-work",
      "patients",
      "staff-check-in",
    ]);
  });
});

describe("requireModuleApiAccess denies the FIFTH role everything outside two slugs", () => {
  // The whole reason the fifth role could be added at all. This guard is the API
  // half of the lock; the page half is `requireModuleAccess` and the nav half is
  // only cosmetic. A staff session that got past requireUser + requireClientAccess +
  // requireSiteAccess — all of which admit it — is stopped here and nowhere else.
  it.each(DENIED_TO_CLINICIAN.concat(["calendar", "patients", "absence", "staff-check-in", "rota"]))(
    "refuses %s with a 403",
    async (slug) => {
      const denied = requireModuleApiAccess(user("client_staff"), slug);
      expect(denied).toBeInstanceOf(Response);
      expect(denied?.status).toBe(403);
      await expect(denied?.json()).resolves.toEqual({ ok: false, error: "forbidden" });
    },
  );

  it("allows exactly the Overview and My work", () => {
    expect(requireModuleApiAccess(user("client_staff"), "")).toBe(null);
    expect(requireModuleApiAccess(user("client_staff"), "my-work")).toBe(null);
  });

  it("refuses an unknown slug, so a typo is not an open door for it either", () => {
    expect(requireModuleApiAccess(user("client_staff"), "not-a-module")?.status).toBe(403);
  });
});

describe("requireModuleApiAccess is a no-op for the three roles that predate the clinician", () => {
  const OTHERS: Role[] = ["agency_admin", "client_owner", "client_coordinator"];

  // A sample spanning every shape of nav item: open-to-all, owner-only, and
  // owner+coordinator — so a change to any of the three access paths is caught.
  const SAMPLE = [
    "", // the Overview index — open to all
    "calendar",
    "patients",
    "payments", // open to all (no `roles` array)
    "conversations", // open to all
    "task-queue", // open to all
    "settings", // OWNER-ONLY
    "controls", // OWNER-ONLY
    "reports", // OWNER-ONLY
    "landing-pages", // owner + COORDINATOR
    "absence", // owner + COORDINATOR
    "staff-check-in", // owner + COORDINATOR
  ];

  it.each(OTHERS.flatMap((r) => SAMPLE.map((s) => [r, s] as const)))(
    "%s on %s matches canRoleAccessModule exactly",
    (role, slug) => {
      // The guard must be a pure reflection of the predicate for these roles: null
      // where the predicate allows, 403 where it already refused before this existed.
      const allowed = canRoleAccessModule(role, slug);
      const result = requireModuleApiAccess(user(role), slug);
      if (allowed) expect(result).toBe(null);
      else expect(result?.status).toBe(403);
    },
  );

  it("owner and agency keep every owner-only module", () => {
    for (const slug of ["settings", "controls", "reports", "usps", "roi", "meta-ads"]) {
      expect(requireModuleApiAccess(user("client_owner"), slug)).toBe(null);
      expect(requireModuleApiAccess(user("agency_admin"), slug)).toBe(null);
    }
  });

  it("the coordinator keeps the modules it had, and is still refused the owner-only ones", () => {
    // Unchanged, both ways: this guard must not widen the coordinator either.
    for (const slug of ["landing-pages", "absence", "staff-check-in", "conversations", "patients"]) {
      expect(requireModuleApiAccess(user("client_coordinator"), slug)).toBe(null);
    }
    for (const slug of ["settings", "controls", "reports"]) {
      expect(requireModuleApiAccess(user("client_coordinator"), slug)?.status).toBe(403);
    }
  });

  it("an unknown slug stays open for the three, exactly as it was", () => {
    // Allow-by-default for a slug CLIENT_NAV does not know. Preserved deliberately:
    // narrowing it here would break routes whose slug is not a nav module.
    for (const role of OTHERS) expect(requireModuleApiAccess(user(role), "not-a-module")).toBe(null);
  });
});

describe("requireModuleApiAccess passes through when enforcement is off", () => {
  it("returns null for a null user, like every other guard in this file", () => {
    // authEnforced() false => requireUser returns null => the pilot demo is unchanged.
    expect(requireModuleApiAccess(null, "conversations")).toBe(null);
    expect(requireModuleApiAccess(null, "settings")).toBe(null);
    expect(requireModuleApiAccess(null, "not-a-module")).toBe(null);
  });
});

describe("the existing guards are untouched by this addition", () => {
  it("requireOwnerRole still refuses the coordinator and the clinician", () => {
    expect(requireOwnerRole(user("client_coordinator"))?.status).toBe(403);
    expect(requireOwnerRole(user("client_clinician"))?.status).toBe(403);
    expect(requireOwnerRole(user("client_owner"))).toBe(null);
  });

  it("the two guards return the same 403 body, so callers cannot tell them apart", async () => {
    // Deliberate: a refusal must not leak WHICH rule refused.
    const a = requireModuleApiAccess(user("client_clinician"), "reports");
    const b = requireOwnerRole(user("client_coordinator"));
    await expect(a?.json()).resolves.toEqual(await b?.json());
  });
});
