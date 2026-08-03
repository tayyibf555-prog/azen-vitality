import { describe, it, expect } from "vitest";
import {
  OWNER_ONLY_AREA_ITEMS,
  SHELL_PREFIX,
  shellAreas,
  shellBase,
  shellTreeFor,
} from "./nav-shell";
import { categoriesForRole } from "./nav";

const slugsIn = (areas: ReturnType<typeof shellAreas>, key: string) =>
  areas.find((a) => a.key === key)?.items.map((i) => i.slug) ?? [];

describe("shellTreeFor", () => {
  it("reads the owner tree from the owner prefix", () => {
    expect(shellTreeFor("/owner/vitality")).toBe("owner");
    expect(shellTreeFor("/owner/vitality/patients/123")).toBe("owner");
  });

  it("reads the staff tree from everything else", () => {
    expect(shellTreeFor("/c/vitality")).toBe("client");
    expect(shellTreeFor("/c/vitality/calendar")).toBe("client");
  });

  it("matches a whole segment, so /ownership is not the owner shell", () => {
    // A bare startsWith("/owner") - which is what three components did inline
    // before this module - would hand the owner-only nav to any route whose first
    // segment merely begins with those six characters.
    expect(shellTreeFor("/ownership/vitality")).toBe("client");
    expect(shellTreeFor("/owners-club")).toBe("client");
  });

  it("falls back to the staff shell when there is no pathname at all", () => {
    // usePathname can be null during the first client render. The staff shell is
    // the safe default: it carries no owner-only entries.
    expect(shellTreeFor(null)).toBe("client");
    expect(shellTreeFor(undefined)).toBe("client");
    expect(shellTreeFor("")).toBe("client");
  });
});

describe("shellBase", () => {
  it("builds the base every module href hangs off, per tree", () => {
    expect(shellBase("/c/vitality/calendar", "vitality")).toBe("/c/vitality");
    expect(shellBase("/owner/vitality/calendar", "vitality")).toBe("/owner/vitality");
  });

  it("uses the slug it is given, not the one in the path", () => {
    // The slug comes from useParams, which is the router's own answer; the path
    // is only ever consulted for the TREE.
    expect(shellBase("/owner/vitality/patients", "n15")).toBe("/owner/n15");
  });

  it("agrees with the declared prefixes", () => {
    expect(shellBase("/c/x", "x")).toBe(`${SHELL_PREFIX.client}/x`);
    expect(shellBase("/owner/x", "x")).toBe(`${SHELL_PREFIX.owner}/x`);
  });
});

describe("shellAreas", () => {
  it("gives the staff shell exactly what categoriesForRole gives", () => {
    const shell = shellAreas({ pathname: "/c/vitality", role: "client_owner" });
    const plain = categoriesForRole("client_owner");
    expect(shell.map((a) => a.key)).toEqual(plain.map((a) => a.key));
    expect(shell.map((a) => a.items.map((i) => i.slug))).toEqual(
      plain.map((a) => a.items.map((i) => i.slug)),
    );
  });

  it("adds the owner-only Practice brain in the owner shell, and only there", () => {
    // The regression this pins: the Practice brain has no /c route and is not in
    // CLIENT_NAV, so it lives ONLY in the owner shell's nav. Losing it there
    // (which is what deleting OwnerSidebar would otherwise have done) leaves the
    // page reachable by typed URL alone.
    const owner = shellAreas({ pathname: "/owner/vitality", role: "client_owner" });
    const staff = shellAreas({ pathname: "/c/vitality", role: "client_owner" });
    expect(slugsIn(owner, "operations")).toContain("practice-brain");
    expect(slugsIn(staff, "operations")).not.toContain("practice-brain");
  });

  it("appends the extra rather than replacing the area, so nothing standard is lost", () => {
    const owner = shellAreas({ pathname: "/owner/vitality", role: "client_owner" });
    const staff = shellAreas({ pathname: "/c/vitality", role: "client_owner" });
    const staffOps = slugsIn(staff, "operations");
    expect(slugsIn(owner, "operations")).toEqual([...staffOps, "practice-brain"]);
  });

  it("does not hand the Practice brain to a role that may not reach it", () => {
    // Defence in depth on top of the /owner layout guard. A coordinator cannot
    // normally render this shell at all; if they ever did, the nav must not
    // advertise an owner-only page to them.
    const areas = shellAreas({ pathname: "/owner/vitality", role: "client_coordinator" });
    expect(areas.flatMap((a) => a.items.map((i) => i.slug))).not.toContain("practice-brain");
  });

  it("keeps the clinician out of it too", () => {
    const areas = shellAreas({ pathname: "/owner/vitality", role: "client_clinician" });
    expect(areas.flatMap((a) => a.items.map((i) => i.slug))).not.toContain("practice-brain");
  });

  it("shows it with no verified role, matching categoriesForRole's own fallback", () => {
    const areas = shellAreas({ pathname: "/owner/vitality", role: null });
    expect(slugsIn(areas, "operations")).toContain("practice-brain");
  });

  it("still drops the systems the owner has switched off, in the owner shell", () => {
    // The owner sidebar's one genuinely owner-specific behaviour was this filter.
    // It has to survive the move onto the shared shell.
    const areas = shellAreas({
      pathname: "/owner/vitality",
      role: "client_owner",
      disabledSlugs: new Set(["recall", "reactivation"]),
    });
    const all = areas.flatMap((a) => a.items.map((i) => i.slug));
    expect(all).not.toContain("recall");
    expect(all).not.toContain("reactivation");
    // System controls is never a controllable system, so it is never hidden and
    // the owner can always switch things back on.
    expect(all).toContain("controls");
  });

  it("cannot be switched off itself, because it is not a controllable system", () => {
    // Belt and braces: even if "practice-brain" were passed in as disabled it is
    // not in the systems catalogue, so nothing can produce that state. Pinned so
    // a future edit that routes the extras through the filter is a deliberate one.
    const areas = shellAreas({
      pathname: "/owner/vitality",
      role: "client_owner",
      disabledSlugs: new Set(["practice-brain"]),
    });
    expect(slugsIn(areas, "operations")).toContain("practice-brain");
  });

  it("names an area key that actually exists, or the extra is silently dropped", () => {
    // OWNER_ONLY_AREA_ITEMS is keyed by area. A typo in the key produces no
    // error and no entry - the failure mode this assertion exists to catch.
    const keys = new Set(categoriesForRole(null).map((a) => a.key));
    for (const entry of OWNER_ONLY_AREA_ITEMS) {
      expect(keys.has(entry.areaKey), `no area named '${entry.areaKey}'`).toBe(true);
    }
  });
});
