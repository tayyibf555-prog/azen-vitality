import { describe, it, expect } from "vitest";
import { navForRole, canRoleAccessModule, CLIENT_NAV, NAV_CATEGORIES, NAV_HIDDEN_SLUGS, categoriesForRole } from "./nav";

const OWNER_ONLY = ["roi", "reports", "meta-ads", "usps", "compliance", "co-pilot", "settings"];
const ALL_ROLE = ["", "reviews", "onboarding", "calendar", "patients", "recall"];

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
    expect(cats.map((c) => c.key)).toEqual(["home", "patients", "messages", "growth", "operations"]);
    // Items resolve to real nav items (with icons/labels), not undefined holes.
    for (const c of cats) for (const i of c.items) expect(i.label.length).toBeGreaterThan(0);
  });

  it("drops the whole Operations category for a coordinator (every module in it is owner-only)", () => {
    const keys = categoriesForRole("client_coordinator").map((c) => c.key);
    expect(keys).not.toContain("operations");
    // The everyday categories survive.
    expect(keys).toEqual(expect.arrayContaining(["home", "patients", "messages", "growth"]));
  });

  it("hides owner-only items inside surviving categories for a coordinator", () => {
    const growth = categoriesForRole("client_coordinator").find((c) => c.key === "growth");
    const slugs = growth?.items.map((i) => i.slug) ?? [];
    expect(slugs).not.toContain("meta-ads");
    expect(slugs).not.toContain("usps");
    expect(slugs).not.toContain("roi");
    expect(slugs).toContain("smile-assessment");
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

  it("allows shared modules for every role", () => {
    for (const slug of ALL_ROLE) {
      expect(canRoleAccessModule("client_coordinator", slug)).toBe(true);
      expect(canRoleAccessModule("client_owner", slug)).toBe(true);
    }
  });
});
