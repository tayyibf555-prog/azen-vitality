import { describe, it, expect, vi } from "vitest";

// guard.ts opens with `import "server-only"`, which is a Next.js-internal module
// with no top-level node_modules entry, so a plain node-env import of it fails to
// resolve. Stubbing it is the standard way to reach a server module from vitest;
// every OTHER test in the repo mocks the whole of guard.ts, but test 7 below has
// to exercise the REAL requireOwnerRole, or it pins nothing.
vi.mock("server-only", () => ({}));

import {
  navForRole,
  canRoleAccessModule,
  categoriesForRole,
  CLIENT_NAV,
  CLIENT_MODULE_SLUGS,
  CLINICIAN_SLUGS,
  EXTRA_OWNER_ONLY_SLUGS,
  OWNER_ROLES,
} from "./nav";
import { requireOwnerRole } from "./auth/guard";
import type { AuthedUser } from "./auth/session";

// ===========================================================================
// THE FOURTH ROLE: client_clinician.
//
// A separate file from nav.test.ts ON PURPOSE. nav.test.ts holds the pins the
// existing three roles have always had; if ADDING THE CLINICIAN had required
// editing one of them, that would itself have been the signal that the fourth
// role widened one of the other three. It did not: the clinician branch returns
// before any of their evaluation, and the proof of that is TEST 1 below, not this
// comment.
//
// CORRECTION, 2026-08-03: an earlier version of this header claimed "nothing in
// nav.test.ts changed", and by the time it was written that was already false.
// One expectation in it (the coordinator's Operations rail) was updated the same
// night, because the coordinator was DELIBERATELY granted "absence" and
// "staff-check-in" — a separate decision about the practice manager's job, made
// alongside the clinician work rather than caused by it. The distinction the
// original comment was reaching for is real and still holds, so it is stated
// precisely above instead of as a blanket claim that the file went untouched.
//
// The whole reason this file exists is that the nav is ALLOW-BY-DEFAULT:
// `roleCanSeeItem` returns true for any item carrying no `roles` array, and
// `canRoleAccessModule` returns true for a slug it does not recognise at all.
// Roughly two thirds of the modules carry no `roles` array, so a fourth role
// added the obvious way inherits Payments, Recall, Reactivation, Conversations,
// the agents and the rest by accident. CLINICIAN_SLUGS + an early return in both
// predicates is the only form of the fix that can be PROVEN not to widen the
// other three, and these tests are that proof.
// ===========================================================================

/** Every slug either predicate can be asked about, nav modules plus the owner-shell extras. */
const ALL_SLUGS = [...CLIENT_MODULE_SLUGS, ...EXTRA_OWNER_ONLY_SLUGS];

/** The owner-only list, copied from nav.test.ts:13 so this file stands alone. */
const OWNER_ONLY = ["roi", "reports", "meta-ads", "usps", "compliance", "co-pilot", "settings"];

function navSlugs(role: Parameters<typeof navForRole>[0]): string[] {
  return navForRole(role).flatMap((g) => g.items.map((i) => i.slug));
}

function allowedSlugs(role: Parameters<typeof canRoleAccessModule>[0]): string[] {
  return ALL_SLUGS.filter((slug) => canRoleAccessModule(role, slug));
}

// ---------------------------------------------------------------------------
// TEST 1 — the non-widening proof, stated as baseline + a named delta.
//
// A bare snapshot of today's values would only pin "whatever it is now", which
// silently absorbs any widening committed alongside it. So BASELINE holds the
// EXACT sets the three existing roles had at commit 6866aac, before the clinician
// role existed, and ADDED_TONIGHT names the only two slugs this change was
// allowed to give them and why. Together they say: nothing was removed, and
// nothing was added except these. A future edit that widens any of the three
// fails here with the offending slug named in the diff.
// ---------------------------------------------------------------------------
const BASELINE: Record<string, string[]> = {
  agency_admin: [
    "", "roi", "reports", "calendar", "patients", "payments", "meta-ads", "landing-pages",
    "smile-assessment", "speed-to-lead", "onboarding", "booking", "outreach", "power-dialler",
    "task-queue", "usps", "recall", "reactivation", "treatment-coordinator", "after-hours",
    "no-show-defence", "reviews", "conversations", "booking-agent", "whatsapp", "compliance",
    "rota", "staff-check-in", "daily-brief", "notifications", "co-pilot", "controls",
    "getting-started", "settings",
  ],
  client_owner: [
    "", "roi", "reports", "calendar", "patients", "payments", "meta-ads", "landing-pages",
    "smile-assessment", "speed-to-lead", "onboarding", "booking", "outreach", "power-dialler",
    "task-queue", "usps", "recall", "reactivation", "treatment-coordinator", "after-hours",
    "no-show-defence", "reviews", "conversations", "booking-agent", "whatsapp", "compliance",
    "rota", "staff-check-in", "daily-brief", "notifications", "co-pilot", "controls",
    "getting-started", "settings",
  ],
  client_coordinator: [
    "", "calendar", "patients", "payments", "landing-pages", "smile-assessment", "speed-to-lead",
    "onboarding", "booking", "power-dialler", "task-queue", "recall", "reactivation",
    "treatment-coordinator", "after-hours", "no-show-defence", "reviews", "conversations",
    "booking-agent", "whatsapp", "daily-brief", "notifications", "getting-started",
  ],
};

/**
 * The complete, deliberate delta of this change for the three existing roles.
 *
 * - "absence" is a brand-new module, so every role that may see it is an addition
 *   by definition. It is NOT owner-only: the practice manager (a client_coordinator
 *   in this platform) is the person who approves holiday.
 * - "staff-check-in" already existed and was already visible to agency + owner as a
 *   placeholder, so flipping it live added nothing for them. The coordinator IS a
 *   genuine grant, for the same reason: attendance exceptions are the manager's job.
 */
const ADDED_TONIGHT: Record<string, string[]> = {
  agency_admin: ["absence"],
  client_owner: ["absence"],
  client_coordinator: ["absence", "staff-check-in"],
};

/** practice-brain is not a CLIENT_NAV module, so it never appears in navForRole. */
const EXTRA_ALLOWED_NOT_IN_NAV: Record<string, string[]> = {
  agency_admin: ["practice-brain"],
  client_owner: ["practice-brain"],
  client_coordinator: [],
};

function sorted(values: string[]): string[] {
  return [...values].sort();
}

describe("1. the existing three roles are byte-identical apart from the named delta", () => {
  it.each(["agency_admin", "client_owner", "client_coordinator"] as const)(
    "%s sees exactly its baseline nav plus tonight's named additions, and nothing else",
    (role) => {
      const expected = [...BASELINE[role], ...ADDED_TONIGHT[role]];
      expect(sorted(navSlugs(role))).toEqual(sorted(expected));
    },
  );

  it.each(["agency_admin", "client_owner", "client_coordinator"] as const)(
    "%s may reach exactly its baseline module set plus tonight's named additions",
    (role) => {
      const expected = [
        ...BASELINE[role],
        ...ADDED_TONIGHT[role],
        ...EXTRA_ALLOWED_NOT_IN_NAV[role],
      ];
      expect(sorted(allowedSlugs(role))).toEqual(sorted(expected));
    },
  );

  it("the clinician branch is unreachable for the other three (their path is the old one)", () => {
    // Direct statement of the mechanism: the early return keys on the role only, so
    // for any other role CLINICIAN_SLUGS membership is irrelevant. "payments" is in
    // no allow-list yet is open to all three; "co-pilot" is in no allow-list and is
    // owner-only. Both answers come from the ORIGINAL rules, not the new branch.
    expect(CLINICIAN_SLUGS.has("payments")).toBe(false);
    expect(canRoleAccessModule("client_coordinator", "payments")).toBe(true);
    expect(canRoleAccessModule("client_coordinator", "co-pilot")).toBe(false);
    expect(canRoleAccessModule("client_owner", "co-pilot")).toBe(true);
  });
});

describe("2. the clinician is denied every slug outside the allow-list", () => {
  it("iterates the FULL slug list, not a hand-picked sample", () => {
    const denied = ALL_SLUGS.filter((slug) => !CLINICIAN_SLUGS.has(slug));
    // Guards the guard: if the allow-list ever swallowed the nav, this loop would
    // be empty and assert nothing.
    expect(denied.length).toBeGreaterThan(20);
    for (const slug of denied) {
      expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    }
  });

  it("and is allowed every slug that IS in the allow-list", () => {
    for (const slug of CLINICIAN_SLUGS) {
      expect(canRoleAccessModule("client_clinician", slug)).toBe(true);
    }
  });
});

describe("3. the clinician is denied every owner-only module", () => {
  it.each(OWNER_ONLY)("cannot reach '%s'", (slug) => {
    expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    // Control: the owner still can, so this is a role difference and not a slug that
    // has quietly been switched off for everyone.
    expect(canRoleAccessModule("client_owner", slug)).toBe(true);
  });
});

describe("4. the clinician is denied the owner-shell practice-brain", () => {
  it("blocks the EXTRA_OWNER_ONLY_SLUGS path", () => {
    expect(EXTRA_OWNER_ONLY_SLUGS.has("practice-brain")).toBe(true);
    expect(canRoleAccessModule("client_clinician", "practice-brain")).toBe(false);
    expect(canRoleAccessModule("client_owner", "practice-brain")).toBe(true);
  });
});

describe("5. an UNKNOWN slug does not fall through to true for the clinician", () => {
  it("refuses a slug that is in no list at all", () => {
    // canRoleAccessModule ends `if (!item) return true` for a slug it cannot find.
    // That fall-through is deliberate for the existing three (the page itself 404s),
    // but for a deny-by-default role it would be a hole wide enough to drive a
    // future module through: any module added without a nav entry would be open.
    for (const slug of ["not-a-real-module", "payroll", "finance/export", ""]
      .filter((s) => !CLINICIAN_SLUGS.has(s) && !CLIENT_MODULE_SLUGS.includes(s))) {
      expect(canRoleAccessModule("client_clinician", slug)).toBe(false);
    }
    expect(canRoleAccessModule("client_clinician", "not-a-real-module")).toBe(false);
  });

  it("while the existing three keep the documented fall-through, unchanged", () => {
    for (const role of ["agency_admin", "client_owner", "client_coordinator"] as const) {
      expect(canRoleAccessModule(role, "not-a-real-module")).toBe(true);
    }
  });
});

describe("6. CLINICIAN_SLUGS contains only real modules", () => {
  it("is a subset of CLIENT_MODULE_SLUGS", () => {
    // A typo'd slug would grant nothing AND hide nothing, so it would never show up
    // as a failure anywhere else: the module stays denied and the test suite stays
    // green while the clinician silently cannot reach the page they were given.
    for (const slug of CLINICIAN_SLUGS) {
      expect(CLIENT_MODULE_SLUGS).toContain(slug);
    }
  });

  it("names the exact five modules a clinician gets", () => {
    expect(sorted([...CLINICIAN_SLUGS])).toEqual(
      sorted(["", "calendar", "patients", "absence", "staff-check-in"]),
    );
  });
});

describe("7. the API guard refuses the clinician", () => {
  const clinician: AuthedUser = {
    id: "u-clinician",
    name: "Dr Sara Malik",
    email: "sara@vitalitydental.co.uk",
    role: "client_clinician",
    clientId: "vitality",
    siteIds: ["site-cc"],
  };

  it("requireOwnerRole returns a 403 Response for a clinician", async () => {
    const res = requireOwnerRole(clinician);
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(403);
    await expect(res!.json()).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("and still passes the owner and the agency admin through", () => {
    expect(requireOwnerRole({ ...clinician, role: "client_owner" })).toBeNull();
    expect(requireOwnerRole({ ...clinician, role: "agency_admin" })).toBeNull();
    expect(requireOwnerRole({ ...clinician, role: "client_coordinator" })?.status).toBe(403);
  });
});

describe("8. navForRole for the clinician", () => {
  it("returns only allow-listed items and drops every emptied group", () => {
    const groups = navForRole("client_clinician");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(CLINICIAN_SLUGS.has(item.slug)).toBe(true);
      }
    }
    // The whole allow-list is actually reachable in the nav (nothing stranded).
    expect(sorted(navSlugs("client_clinician"))).toEqual(sorted([...CLINICIAN_SLUGS]));
    // And it really is a shrunk nav, not the full one.
    expect(navSlugs("client_clinician").length).toBeLessThan(navSlugs("client_owner").length);
  });

  it("drops whole groups the clinician has nothing in", () => {
    const clinicianGroups = navForRole("client_clinician").map((g) => g.label);
    const allGroups = CLIENT_NAV.map((g) => g.label);
    expect(clinicianGroups.length).toBeLessThan(allGroups.length);
    // Acquisition is entirely outside the allow-list, so the group disappears.
    expect(clinicianGroups).not.toContain("Acquisition");
    expect(allGroups).toContain("Acquisition");
  });
});

describe("9. categoriesForRole for the clinician", () => {
  it("contains no owner-only slug in any rail category", () => {
    const slugs = categoriesForRole("client_clinician").flatMap((c) => c.items.map((i) => i.slug));
    for (const ownerOnly of OWNER_ONLY) expect(slugs).not.toContain(ownerOnly);
    for (const slug of slugs) expect(CLINICIAN_SLUGS.has(slug)).toBe(true);
    // Non-empty, so "contains nothing" is not the reason it passes.
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs).toContain("calendar");
  });
});

describe("10. the new role was not added to the owner list", () => {
  it("OWNER_ROLES still has exactly two members", () => {
    expect(OWNER_ROLES).toEqual(["agency_admin", "client_owner"]);
    expect(OWNER_ROLES).toHaveLength(2);
    expect(OWNER_ROLES).not.toContain("client_clinician");
  });
});
