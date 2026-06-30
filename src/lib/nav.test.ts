import { describe, it, expect } from "vitest";
import { navForRole, canRoleAccessModule, CLIENT_NAV } from "./nav";

const OWNER_ONLY = ["roi", "reports", "meta-ads", "usps", "compliance", "co-pilot", "settings"];
const ALL_ROLE = ["", "today", "reviews", "onboarding", "calendar", "patients", "recall"];

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
