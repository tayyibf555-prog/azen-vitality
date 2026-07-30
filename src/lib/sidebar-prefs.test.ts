import { describe, expect, it } from "vitest";
import {
  groupKeyForActive,
  isModuleActive,
  moduleHref,
  parseCollapsed,
  parseOpenGroups,
  resolveOpenGroups,
  serialiseCollapsed,
  serialiseOpenGroups,
  toggleGroup,
  withGroupOpened,
} from "@/lib/sidebar-prefs";

const BASE = "/c/vitality";
const ALL = ["home", "patients", "messages", "growth", "operations"];

describe("collapse state", () => {
  it("reads only an explicit 1 as collapsed", () => {
    expect(parseCollapsed("1")).toBe(true);
    expect(parseCollapsed("0")).toBe(false);
    expect(parseCollapsed("")).toBe(false);
    expect(parseCollapsed("true")).toBe(false);
  });

  it("defaults to expanded when no cookie was sent", () => {
    expect(parseCollapsed(undefined)).toBe(false);
    expect(parseCollapsed(null)).toBe(false);
  });

  it("round-trips", () => {
    expect(parseCollapsed(serialiseCollapsed(true))).toBe(true);
    expect(parseCollapsed(serialiseCollapsed(false))).toBe(false);
  });
});

describe("parseOpenGroups", () => {
  it("returns null when the user has never expressed a preference", () => {
    expect(parseOpenGroups(undefined)).toBeNull();
    expect(parseOpenGroups(null)).toBeNull();
  });

  it("treats an empty cookie as a real preference for nothing pinned open", () => {
    expect(parseOpenGroups("")).toEqual([]);
  });

  it("splits, trims and de-duplicates", () => {
    expect(parseOpenGroups("home, patients ,home")).toEqual(["home", "patients"]);
    expect(parseOpenGroups("home,,growth,")).toEqual(["home", "growth"]);
  });

  it("round-trips through serialise", () => {
    expect(parseOpenGroups(serialiseOpenGroups(["home", "growth"]))).toEqual(["home", "growth"]);
    expect(serialiseOpenGroups(["home", "home", "growth"])).toBe("home,growth");
    expect(serialiseOpenGroups([])).toBe("");
  });
});

describe("resolveOpenGroups", () => {
  it("opens only the current page's area on a first visit", () => {
    expect(resolveOpenGroups(null, "growth", ALL)).toEqual(["growth"]);
  });

  it("opens the remembered areas plus the current page's area", () => {
    expect(resolveOpenGroups(["operations"], "patients", ALL)).toEqual(["patients", "operations"]);
  });

  it("does not duplicate the current area when it was already remembered", () => {
    expect(resolveOpenGroups(["home", "growth"], "growth", ALL)).toEqual(["home", "growth"]);
  });

  it("drops areas this role cannot see", () => {
    // A coordinator sees no Operations area at all, so a remembered "operations"
    // must not survive into the resolved state.
    expect(resolveOpenGroups(["operations", "home"], null, ["home", "patients"])).toEqual(["home"]);
  });

  it("ignores a route area that is not in the visible list", () => {
    expect(resolveOpenGroups([], "operations", ["home", "patients"])).toEqual([]);
  });

  it("returns nothing open when the preference is EMPTY and no area is current", () => {
    // An empty cookie is a deliberate "nothing pinned", so it is honoured.
    expect(resolveOpenGroups([], null, ALL)).toEqual([]);
  });

  it("opens the first area on a first visit to a page that belongs to none", () => {
    // The dashboard sits in no area. With no preference yet, a wall of five shut
    // headers would be a poor first impression, so the first area opens.
    expect(resolveOpenGroups(null, null, ALL)).toEqual(["home"]);
    expect(resolveOpenGroups(null, null, [])).toEqual([]);
  });

  it("does not force the first area open once the user has a preference", () => {
    expect(resolveOpenGroups(["growth"], null, ALL)).toEqual(["growth"]);
  });

  it("orders by the visible list, not by insertion", () => {
    expect(resolveOpenGroups(["operations", "home"], "messages", ALL)).toEqual([
      "home",
      "messages",
      "operations",
    ]);
  });
});

describe("toggleGroup", () => {
  it("opens a closed area and closes an open one", () => {
    expect(toggleGroup(["home"], "growth")).toEqual(["home", "growth"]);
    expect(toggleGroup(["home", "growth"], "home")).toEqual(["growth"]);
  });

  it("does not mutate its input", () => {
    const open = ["home"];
    toggleGroup(open, "growth");
    expect(open).toEqual(["home"]);
  });
});

describe("withGroupOpened", () => {
  it("adds the area when it is closed", () => {
    expect(withGroupOpened(["home"], "growth")).toEqual(["home", "growth"]);
  });

  it("returns the same array when nothing changes, so a render guard cannot loop", () => {
    const open = ["home", "growth"];
    expect(withGroupOpened(open, "growth")).toBe(open);
    expect(withGroupOpened(open, null)).toBe(open);
  });
});

describe("moduleHref", () => {
  it("maps the empty slug to the client index", () => {
    expect(moduleHref(BASE, "")).toBe(BASE);
    expect(moduleHref(BASE, "patients")).toBe(`${BASE}/patients`);
  });
});

describe("isModuleActive", () => {
  it("matches the module page and anything nested under it", () => {
    expect(isModuleActive(`${BASE}/patients`, BASE, "patients")).toBe(true);
    expect(isModuleActive(`${BASE}/patients/p-1`, BASE, "patients")).toBe(true);
  });

  it("does not match a sibling slug that merely shares a prefix", () => {
    expect(isModuleActive(`${BASE}/patients-archive`, BASE, "patients")).toBe(false);
  });

  it("matches the index only at the base path", () => {
    expect(isModuleActive(BASE, BASE, "")).toBe(true);
    expect(isModuleActive(`${BASE}/`, BASE, "")).toBe(true);
    expect(isModuleActive(`${BASE}/patients`, BASE, "")).toBe(false);
  });

  it("handles a missing pathname", () => {
    expect(isModuleActive(null, BASE, "patients")).toBe(false);
    expect(isModuleActive(undefined, BASE, "")).toBe(false);
  });
});

describe("groupKeyForActive", () => {
  const groups = [
    { key: "home", items: [{ slug: "" }, { slug: "calendar" }] },
    { key: "patients", items: [{ slug: "patients" }, { slug: "payments" }] },
  ];

  it("finds the area holding the active module", () => {
    expect(groupKeyForActive(groups, (s) => s === "payments")).toBe("patients");
    expect(groupKeyForActive(groups, (s) => s === "")).toBe("home");
  });

  it("returns null when nothing in the nav is active", () => {
    expect(groupKeyForActive(groups, () => false)).toBeNull();
  });
});
