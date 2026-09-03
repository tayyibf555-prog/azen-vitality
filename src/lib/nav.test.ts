import { describe, it, expect } from "vitest";
import {
  navForRole,
  canRoleAccessModule,
  CLIENT_NAV,
  NAV_CATEGORIES,
  NAV_HIDDEN_SLUGS,
  NAV_SWITCH_EXEMPT_SLUGS,
  EXTRA_OWNER_ONLY_SLUGS,
  categoriesForRole,
  CLINICIAN_SLUGS,
  STAFF_SLUGS,
} from "./nav";

// "co-pilot" LEFT this list in the manager-co-pilot lane (Wave 3 #5): the module
// is now shared with the practice manager, who gets a role-scoped six-tool
// version of it (src/lib/copilot/scope.ts). It is asserted on its own terms
// below — shared with the coordinator, still denied to the clinician and staff —
// rather than dropped quietly out of a list.
const OWNER_ONLY = ["roi", "reports", "meta-ads", "usps", "compliance", "settings"];
// "booking" (owner + coordinator tab) and "getting-started" (coordinator can now
// tick the checklist too) are shared, so both belong alongside the rest here.
const ALL_ROLE = ["", "reviews", "onboarding", "calendar", "patients", "recall", "booking", "getting-started"];

function slugsFor(role: Parameters<typeof navForRole>[0]): string[] {
  return navForRole(role).flatMap((g) => g.items.map((i) => i.slug));
}

describe("navForRole", () => {
  it("shows the owner every module (same set as the raw nav)", () => {
    const ownerSlugs = slugsFor("client_owner");
    const allSlugs = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug));
    expect(new Set(ownerSlugs)).toEqual(new Set(allSlugs));
    for (const slug of OWNER_ONLY) expect(ownerSlugs).toContain(slug);
  });

  it("shows the agency admin every module too", () => {
    const adminSlugs = slugsFor("agency_admin");
    for (const slug of OWNER_ONLY) expect(adminSlugs).toContain(slug);
  });

  it("hides the owner-only modules from a coordinator", () => {
    const coordSlugs = slugsFor("client_coordinator");
    for (const slug of OWNER_ONLY) expect(coordSlugs).not.toContain(slug);
  });

  it("still shows the shared modules to a coordinator", () => {
    const coordSlugs = slugsFor("client_coordinator");
    for (const slug of ALL_ROLE) expect(coordSlugs).toContain(slug);
  });

  it("drops any group left empty after filtering", () => {
    for (const group of navForRole("client_coordinator")) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});

describe("sidebar categories (rail + panel nav)", () => {
  it("every CLIENT_NAV module appears in exactly ONE category, except the documented hidden set", () => {
    const navSlugs = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug));
    const categorySlugs = NAV_CATEGORIES.flatMap((c) => c.slugs);
    // No duplicates across categories.
    expect(categorySlugs.length).toBe(new Set(categorySlugs).size);
    // Exact coverage both ways, minus the Home-embedded modules (daily-brief,
    // task-queue): a module missing from every category AND from the hidden set
    // would be unreachable from the sidebar; a category slug not in the nav is a typo.
    const expected = new Set(navSlugs.filter((s) => !NAV_HIDDEN_SLUGS.has(s)));
    expect(new Set(categorySlugs)).toEqual(expected);
  });

  it("hidden modules stay routable (deep links + palette) even without a category", () => {
    const navSlugs = new Set(CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug)));
    for (const slug of NAV_HIDDEN_SLUGS) {
      expect(navSlugs.has(slug)).toBe(true); // still in CLIENT_NAV (palette finds it)
      expect(canRoleAccessModule("client_coordinator", slug)).toBe(true);
    }
  });

  it("the old 'today' module is gone from the nav entirely (folded into Home)", () => {
    const navSlugs = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug));
    expect(navSlugs).not.toContain("today");
    expect(NAV_CATEGORIES.flatMap((c) => c.slugs)).not.toContain("today");
  });

  it("resolves every category for the owner, in rail order", () => {
    const cats = categoriesForRole("client_owner");
    // Calendar is its own rail button, second, rather than a tab under Home: it
    // is the most-used screen in the practice and the reference gives it a
    // top-level icon of its own.
    expect(cats.map((c) => c.key)).toEqual([
      "home",
      "calendar",
      "patients",
      "messages",
      "growth",
      "operations",
    ]);
    // Items resolve to real nav items (with icons/labels), not undefined holes.
    for (const c of cats) for (const i of c.items) expect(i.label.length).toBeGreaterThan(0);
  });

  it("gives the coordinator exactly nine Operations modules: the workforce block, the two desks, Getting started and the scoped co-pilot", () => {
    const cats = categoriesForRole("client_coordinator");
    const keys = cats.map((c) => c.key);
    // The everyday categories survive.
    expect(keys).toEqual(expect.arrayContaining(["home", "patients", "messages", "growth"]));
    const operations = cats.find((c) => c.key === "operations");
    // THIS EXPECTATION WIDENED ON PURPOSE — it is a decision, not drift.
    //
    // It used to be ["getting-started"] alone, because every other module in the
    // Operations rail was owner-only. On 2026-08-03 the orchestrator granted the
    // coordinator "absence" and "staff-check-in" as well, on the ground that the
    // practice manager IS a client_coordinator in this platform and she is the
    // person who approves holiday and reviews clocking exceptions: gating those two
    // on OWNER_ROLES locked their primary user out of them. Both gained the role via
    // an explicit `roles: [...OWNER_ROLES, "client_coordinator"]` array in CLIENT_NAV,
    // so the widening is one readable line per module rather than a default.
    //
    // WIDENED AGAIN, campaign 6, and again as a decision rather than drift. Three
    // more modules join, all for the same stated reason — the practice manager is a
    // client_coordinator and these are her job:
    //
    //   "rota"      was owner-only by an oversight the 2026-08-03 pass missed. The
    //               module's own note reads "owners and managers", but its `roles`
    //               array did not, so she could not open the page or make a single
    //               rota API call. All four rota routes moved from requireOwnerRole
    //               to requireApproverRole in the same change.
    //   "hours"     new module (Hours & pay): the month's worked hours and cost.
    //   "staff-hr"  new module (Staff HR): the employee file and document vault.
    //
    // WIDENED A THIRD TIME, manager-co-pilot lane (Wave 3 #5), one module:
    //
    //   "co-pilot"  the practice manager gets a SCOPED co-pilot. Not the owner's:
    //               `copilotAccessForRole` (src/lib/copilot/scope.ts) derives a
    //               six-tool operational allow-list from her session role on the
    //               server, caps her practice-brain clearance at her own tier, and
    //               strips money out of the patient record. The page and the API
    //               route are shared; what they will DO for her is not.
    //
    // ADDED, W1-D, two modules:
    //
    //   "equipment" the asset register and the equipment desk. The register is
    //               the practice manager's document in every practice that keeps
    //               one — she imports it, she keeps it, and she is who gets asked
    //               when the autoclave stops.
    //   "it-desk"   the front-desk IT first responder. The same reasoning: the
    //               printer, the internet and the locked-out login land on her.
    //               SETTING the escalation contact stays owner-only, inside the
    //               module and at its route (requireOwnerRole), because who the
    //               practice escalates to changes what every member of staff is
    //               told to do.
    //
    // Nothing else moved: everything still absent from this list (compliance,
    // reports, controls, permissions, settings) remains owner-only, and the
    // assertion is still an exact toEqual in NAV_CATEGORIES order, so the NEXT
    // unannounced addition fails here.
    expect(operations?.items.map((i) => i.slug)).toEqual([
      "getting-started",
      "rota",
      "absence",
      "staff-check-in",
      "hours",
      "staff-hr",
      "equipment",
      "it-desk",
      "co-pilot",
    ]);
  });

  it("hides owner-only items inside surviving categories for a coordinator", () => {
    const growth = categoriesForRole("client_coordinator").find((c) => c.key === "growth");
    const slugs = growth?.items.map((i) => i.slug) ?? [];
    expect(slugs).not.toContain("meta-ads");
    expect(slugs).not.toContain("usps");
    expect(slugs).not.toContain("roi");
    expect(slugs).toContain("smile-assessment");
  });

  it("the new Booking tab is shared (owner + coordinator) and lives in the growth rail category", () => {
    expect(canRoleAccessModule("client_owner", "booking")).toBe(true);
    expect(canRoleAccessModule("client_coordinator", "booking")).toBe(true);
    const growth = categoriesForRole("client_coordinator").find((c) => c.key === "growth");
    expect(growth?.items.map((i) => i.slug)).toContain("booking");
  });

  it("role null (dev / enforcement off) shows everything except the hidden set", () => {
    const all = categoriesForRole(null).flatMap((c) => c.items.map((i) => i.slug));
    const expected = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug)).filter(
      (s) => !NAV_HIDDEN_SLUGS.has(s),
    );
    expect(new Set(all)).toEqual(new Set(expected));
  });
});

describe("canRoleAccessModule", () => {
  it("lets the owner reach every owner-only module", () => {
    for (const slug of OWNER_ONLY) {
      expect(canRoleAccessModule("client_owner", slug)).toBe(true);
      expect(canRoleAccessModule("agency_admin", slug)).toBe(true);
    }
  });

  it("blocks the coordinator from every owner-only module", () => {
    for (const slug of OWNER_ONLY) {
      expect(canRoleAccessModule("client_coordinator", slug)).toBe(false);
    }
  });

  it("blocks the coordinator from the owner-shell practice-brain", () => {
    expect(canRoleAccessModule("client_coordinator", "practice-brain")).toBe(false);
    expect(canRoleAccessModule("client_owner", "practice-brain")).toBe(true);
  });

  it("keeps 'Getting started' open to the coordinator (not owner-only) so it shows in their login too", () => {
    // The practice manager / coordinator works through this go-live checklist day to
    // day, so it must never be gated to owners. Lock both the predicate and the reason
    // it is open: the slug carries no owner `roles` and is not in the owner-only escape
    // hatch, so it stays reachable for the coordinator by nav and by direct URL.
    expect(canRoleAccessModule("client_coordinator", "getting-started")).toBe(true);
    expect(canRoleAccessModule("client_owner", "getting-started")).toBe(true);
    expect(canRoleAccessModule("agency_admin", "getting-started")).toBe(true);
    expect(EXTRA_OWNER_ONLY_SLUGS.has("getting-started")).toBe(false);
    const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "getting-started");
    expect(item?.roles).toBeUndefined();
  });

  it("owner shell nav: hides Practice brain from a coordinator, keeps it for owner/agency", () => {
    // The owner shell's nav (@/lib/nav-shell) adds the owner-only Practice brain
    // to the shared sidebar and filters it with canRoleAccessModule, so its
    // owner-only entries never render for a coordinator (defence in depth on top
    // of the /owner layout guard). These assert the exact predicate it uses.
    //
    // Co-pilot USED TO BE ASSERTED HERE TOO and no longer is: the module became
    // shared with the practice manager in the manager-co-pilot lane. Practice
    // brain did not move — it is the RAW knowledge tree, every tier of it, with no
    // clearance filter between the reader and the body text, which is exactly what
    // the co-pilot's `search_knowledge` has and the reason the co-pilot can be
    // shared when this cannot.
    for (const slug of ["practice-brain"]) {
      expect(canRoleAccessModule("client_coordinator", slug)).toBe(false);
      expect(canRoleAccessModule("client_owner", slug)).toBe(true);
      expect(canRoleAccessModule("agency_admin", slug)).toBe(true);
    }
  });

  it("co-pilot is reachable by every clearance, by TWO different mechanisms", () => {
    // THE MODULE-LEVEL HALF of the Dental OS mandate that the co-pilot serves every
    // staff clearance (coordinator's written ruling, 3 Sep 2026). Reaching the page
    // and the API route is open to all five; what the co-pilot DOES for each is
    // decided per-turn from the SESSION in src/lib/copilot/clearance.ts, which has
    // its own enumeration battery and its own non-widening snapshot.
    for (const role of ["client_owner", "agency_admin", "client_coordinator", "client_clinician", "client_staff"] as const) {
      expect(canRoleAccessModule(role, "co-pilot"), role).toBe(true);
    }
    // AND THE TWO MECHANISMS ARE NOT THE SAME MECHANISM, which is the thing worth
    // pinning. The three open roles are admitted by the item's explicit `roles`
    // array; the two allow-list roles are admitted by their OWN allow-lists, whose
    // branches run FIRST in both predicates and return. So the array stays exactly
    // as the manager lane left it — widening it would be a second, redundant grant
    // and would quietly change what "this array is the grant" means for every other
    // module that carries one.
    const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "co-pilot");
    expect(item?.roles).toEqual(["agency_admin", "client_owner", "client_coordinator"]);
    expect(CLINICIAN_SLUGS.has("co-pilot")).toBe(true);
    expect(STAFF_SLUGS.has("co-pilot")).toBe(true);
  });

  it("allows shared modules for every role", () => {
    for (const slug of ALL_ROLE) {
      expect(canRoleAccessModule("client_coordinator", slug)).toBe(true);
      expect(canRoleAccessModule("client_owner", slug)).toBe(true);
    }
  });
});

describe("landing-pages (Growth) nav visibility", () => {
  it("is a live Growth module visible to owners, agency and the practice manager (coordinator)", () => {
    const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "landing-pages");
    expect(item).toBeDefined();
    expect(item?.status).toBe("live");
    // Read-only preview section, so the practice manager (coordinator) sees it too;
    // creating/launching pages stays owner-only in the sibling Meta Ads module.
    expect(new Set(item?.roles)).toEqual(
      new Set(["agency_admin", "client_owner", "client_coordinator"]),
    );
  });

  it("is reachable by all client roles, while its sibling Meta Ads stays owner-only", () => {
    expect(canRoleAccessModule("client_owner", "landing-pages")).toBe(true);
    expect(canRoleAccessModule("agency_admin", "landing-pages")).toBe(true);
    expect(canRoleAccessModule("client_coordinator", "landing-pages")).toBe(true);
    // Decoupled from Meta Ads, which remains owner-only: the coordinator cannot reach it.
    expect(canRoleAccessModule("client_coordinator", "meta-ads")).toBe(false);
  });

  it("shows in the Growth rail for the owner AND the coordinator", () => {
    const ownerGrowth = categoriesForRole("client_owner").find((c) => c.key === "growth");
    expect(ownerGrowth?.items.map((i) => i.slug)).toContain("landing-pages");
    const coordGrowth = categoriesForRole("client_coordinator").find((c) => c.key === "growth");
    expect(coordGrowth?.items.map((i) => i.slug)).toContain("landing-pages");
  });
});

describe("outreach (Campaigns) nav visibility", () => {
  it("shows Campaigns to the owner in the Growth rail category", () => {
    const growth = categoriesForRole("client_owner").find((c) => c.key === "growth");
    expect(growth?.items.map((i) => i.slug)).toContain("outreach");
  });

  it("is owner-only: hidden from a coordinator in nav and blocked by direct URL", () => {
    const coordSlugs = navForRole("client_coordinator").flatMap((g) => g.items.map((i) => i.slug));
    expect(coordSlugs).not.toContain("outreach");
    const growth = categoriesForRole("client_coordinator").find((c) => c.key === "growth");
    expect(growth?.items.map((i) => i.slug) ?? []).not.toContain("outreach");
    expect(canRoleAccessModule("client_coordinator", "outreach")).toBe(false);
    expect(canRoleAccessModule("client_owner", "outreach")).toBe(true);
  });

  it("stays reachable when its OWN kill switch is off (a management surface)", () => {
    // Segment outreach seeds OFF: switching it off must not hide the page where the
    // owner reviews campaigns and turns it back on (only the Launch action is gated).
    expect(NAV_SWITCH_EXEMPT_SLUGS.has("outreach")).toBe(true);
    const disabled = new Set(["outreach"]);
    const growth = categoriesForRole("client_owner", disabled).find((c) => c.key === "growth");
    expect(growth?.items.map((i) => i.slug)).toContain("outreach");
  });

  it("a non-exempt disabled system is still hidden from its category", () => {
    // Control check: reactivation has no exemption, so disabling it hides it.
    const disabled = new Set(["reactivation"]);
    const patients = categoriesForRole("client_owner", disabled).find((c) => c.key === "patients");
    expect(patients?.items.map((i) => i.slug) ?? []).not.toContain("reactivation");
  });
});
